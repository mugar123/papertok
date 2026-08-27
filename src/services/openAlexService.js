/**
 * OpenAlex API Service
 * Handles semantic enrichment, concept extraction, and citation graphs.
 */

import { CATEGORIES } from '../data/categories.js';
import { reconstructOpenAlexAbstract } from '../utils/openAlexAbstract.js';
import { withRequestDeadline } from '../utils/requestDeadline.js';
import {
  applyInstitutionWorksFallback,
  calculateEntityRecentImpact,
  getRecentImpactConfig,
  getRecentImpactPeriod,
} from '../utils/entityMetadata.js';
import { PaperBuilder } from './PaperBuilder.js';
import {
  getRorInstitution,
  mergeInstitutionWithRor,
  normalizeRorId,
  resolveRorInstitution,
  searchRorInstitutions,
} from './rorService.js';
import {
  getInstitutionAuthorsFromCrossref,
  getInstitutionWorksFromCrossref,
} from './crossrefInstitutionService.js';
import {
  isOpenAlexRateLimitError,
  openAlexFetch,
  openAlexJson,
  readOpenAlexPersistent,
  writeOpenAlexPersistent,
} from './openAlexClient.js';
import {
  filterRelevantSearchResults,
  institutionProminenceWeight,
  institutionSearchValues,
} from '../utils/searchRelevance.js';

const CACHE = new Map();
const GRAPH_CACHE = new Map(); // caches W... to arxivId mappings
const RECENT_IMPACT_CACHE = new Map();
const ENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENTITY_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMPACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMPACT_INSUFFICIENT_TTL_MS = 60 * 60 * 1000;
const IMPACT_STALE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ENRICHMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENTITY_WORKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const OPENALEX_ENRICHMENT_SELECT = [
  'id',
  'doi',
  'ids',
  'concepts',
  'topics',
  'primary_topic',
  'cited_by_count',
  'related_works',
  'locations',
  'primary_location',
  'type',
  'open_access',
  // OpenAlex charges per call, not per field, so this rides along on a request
  // the feed already makes. It costs ~2.6 KB per paper and buys a readable card
  // for the sources that arrive without one -- half of NASA's records, a tenth
  // of Europe PMC's -- which also unlocks the AI explanation, gated on having a
  // usable abstract.
  'abstract_inverted_index',
].join(',');

function normalizeDoi(value) {
  return String(value || '').trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
}

function extractArxivId(value) {
  const text = String(value || '');
  const match = text.match(/(?:arxiv\.org\/(?:abs|pdf)\/|10\.48550\/arxiv\.|arxiv:)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i);
  return match?.[1] || '';
}

/**
 * The arXiv id an OpenAlex work is hosted under, if any.
 *
 * OpenAlex indexes the preprint and the published version as one work, and the
 * arXiv id is never a field of its own: it has to be read out of whichever of
 * the identifiers happens to carry it. Worth extracting for any work, not just
 * during enrichment — a paper without this id can never be asked for figures.
 */
export function getArxivIdFromWork(work) {
  const direct = extractArxivId(work?.ids?.arxiv);
  if (direct) return direct;

  const candidates = [work?.doi, work?.ids?.doi];
  for (const location of work?.locations || []) {
    candidates.push(location?.landing_page_url, location?.pdf_url, location?.id);
  }
  return candidates.map(extractArxivId).find(Boolean) || '';
}

function getReliableEnrichmentDoi(work, arxivId) {
  const doi = normalizeDoi(work?.doi || work?.ids?.doi);
  if (!doi) return undefined;

  const canonicalArxivId = extractArxivId(doi);
  if (canonicalArxivId) return canonicalArxivId === arxivId ? doi : undefined;

  const hasPublishedLocation = (work?.locations || []).some(location => location?.is_published && location?.source);
  return work?.type !== 'preprint' || hasPublishedLocation ? doi : undefined;
}

export function mapOpenAlexEnrichmentWork(work) {
  if (!work || typeof work !== 'object') return null;
  const openAlexUrl = work.id || work.ids?.openalex || '';
  const openAlexId = String(openAlexUrl).split('/').pop();
  const arxivId = getArxivIdFromWork(work);
  if (!openAlexId) return null;
  const semanticTopics = Array.isArray(work.concepts) && work.concepts.length > 0
    ? work.concepts
    : (work.topics || []);

  return {
    openAlexId,
    arxivId,
    enrichment: {
      abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
      concepts: semanticTopics,
      topics: work.topics || [],
      primaryTopic: work.primary_topic || null,
      citationCount: Number.isFinite(work.cited_by_count) ? work.cited_by_count : 0,
      citationCountKnown: Number.isFinite(work.cited_by_count),
      related_works: work.related_works || [],
      publicationType: work.type || work.primary_location?.source?.type || 'preprint',
      publicationStatus: (
        work.primary_location?.is_published
        || (work.locations || []).some(location => location?.is_published)
        || (work.type && work.type !== 'preprint')
      ) ? 'published' : 'preprint',
      doi: arxivId
        ? getReliableEnrichmentDoi(work, arxivId)
        : (normalizeDoi(work.doi || work.ids?.doi) || undefined),
      journal: work.primary_location?.source?.display_name,
      publisher: work.primary_location?.source?.host_organization_name,
      openAccess: work.open_access?.is_oa,
      pdfUrl: work.open_access?.oa_url,
      landingPageUrl: work.primary_location?.landing_page_url,
    },
  };
}

// OpenAlex ORs *values* of one filter, not filters. `openalex:W1|openalex:W2`
// is refused with «It looks like you're trying to do an OR query between filters
// and it's not supported», so the key goes once and the ids are joined. This
// used to be written out by hand at each call site, and the two copies drifted:
// one of them had always been returning 400.
export function buildOpenAlexIdFilter(ids) {
  const values = [...new Set((Array.isArray(ids) ? ids : [])
    .map(id => String(id || '').trim())
    .filter(Boolean))];
  return values.length > 0 ? `openalex:${encodeURIComponent(values.join('|'))}` : '';
}

/**
 * Exported for its regression test, which needs a deadline short enough to wait
 * for: the real one is eight seconds.
 *
 * The OpenAlex branch has been covering its body read since `openAlexClient`
 * started buffering inside the deadline. This one hands the response back
 * unread, so it needs the deadline to outlive the call the same way.
 */
export async function fetchWithTimeout(url, timeoutMs = 8000) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // Let fetch report malformed URLs consistently.
  }

  if (hostname === 'api.openalex.org') {
    return openAlexFetch(url, { timeoutMs, cacheTtlMs: 5 * 60 * 1000 });
  }

  return fetch(url, withRequestDeadline({}, timeoutMs));
}

async function enrichInstitutionWithRor(institution, prefetchedRor = null) {
  if (!institution) return prefetchedRor;
  const rorInstitution = prefetchedRor || (institution.ror
    ? await getRorInstitution(institution.ror).catch(() => null)
    : null);
  return mergeInstitutionWithRor(institution, rorInstitution);
}

/**
 * Fetch OpenAlex enrichment data for a batch of arXiv IDs.
 * @param {string[]} arxivIds 
 * @param {{ timeoutMs?: number }} options
 * @returns {Promise<Object>} Map of { arxivId: { concepts, cited_by_count, related_works } }
 */
export function isOpenAlexEnrichmentId(id) {
  const value = String(id || '').trim().replace(/v\d+$/, '');
  return /^\d{4}\.\d{4,5}$/.test(value)
    || /^[a-z][a-z.-]+\/\d{7}$/i.test(value)
    || /^(?:openalex:|https:\/\/openalex\.org\/)?W\d+$/i.test(value);
}

export async function enrichPapersBatch(arxivIds, options = {}) {
  const validIds = [...new Set((Array.isArray(arxivIds) ? arxivIds : [])
    .filter(id => typeof id === 'string' && id.trim() !== '')
    .map(id => {
      const pure = id.startsWith('arxiv:') ? id.split(':')[1] : id;
      return pure.replace(/v\d+$/, '');
    })
    .filter(isOpenAlexEnrichmentId))];
    
  const result = {};
  
  // Reuse semantic/citation signals across sessions so a temporary outage does
  // not erase recommendation quality for papers the user has already encountered.
  validIds.forEach(id => {
    if (!CACHE.has(id)) {
      const persisted = readOpenAlexPersistent(`enrichment:${id}`, ENRICHMENT_CACHE_TTL_MS);
      if (persisted && !persisted.stale) CACHE.set(id, persisted.data);
    }
    if (CACHE.has(id)) result[id] = CACHE.get(id);
  });

  const toFetch = validIds.filter(id => !CACHE.has(id));
  
  if (toFetch.length === 0) return result;

  // Separate OpenAlex IDs and ArXiv IDs
  const openAlexIds = [];
  const arxivIdsOnly = [];
  
  toFetch.forEach(id => {
    if (id.startsWith('openalex:') || id.startsWith('https://openalex.org/') || /^W\d+$/.test(id)) {
      openAlexIds.push(id.replace('openalex:', '').replace('https://openalex.org/', ''));
    } else {
      arxivIdsOnly.push(id);
    }
  });

  const fetchChunk = async (filterParam) => {
    const url = `https://api.openalex.org/works?filter=${filterParam}&per_page=50&select=${OPENALEX_ENRICHMENT_SELECT}`;
    let response = null;
    let primaryFailed = false;
    let directError = null;
    try {
      response = await fetchWithTimeout(url, options.timeoutMs ?? 10000);
      if (!response || !response.ok) primaryFailed = true;
    } catch (error) {
      directError = error;
      primaryFailed = true;
    }
    
    // There used to be a cascade through corsproxy.io and allorigins here. Both
    // are gone -- corsproxy.io now answers "Server-side requests are not allowed
    // on your plan" and allorigins returns a 520 -- and the Worker route makes
    // them pointless anyway, since it is same-origin and holds the credential.
    // A failure is a failure: the caller keeps whatever the cache already had.
    if (primaryFailed) {
      if (directError && !isOpenAlexRateLimitError(directError)) {
        console.warn('OpenAlex enrichment failed', directError);
      }
      return;
    }

    try {
      if (response && response.ok) {
        const data = await response.json();
        if (data && data.results) {
          data.results.forEach(work => {
             const mapped = mapOpenAlexEnrichmentWork(work);
             if (!mapped) return;
             const { arxivId, openAlexId, enrichment } = mapped;

             if (arxivId) {
               CACHE.set(arxivId, enrichment);
               writeOpenAlexPersistent(`enrichment:${arxivId}`, enrichment);
               result[arxivId] = enrichment;
             }
             CACHE.set(`openalex:${openAlexId}`, enrichment);
             writeOpenAlexPersistent(`enrichment:openalex:${openAlexId}`, enrichment);
             result[`openalex:${openAlexId}`] = enrichment;
          });
        }
      }
    } catch (e) {
      console.error("Enrichment processing failed", e);
    }
  };

  // Run independent chunks concurrently. The shared OpenAlex client still caps
  // concurrency, while a slow chunk no longer consumes the whole feed budget.
  const CHUNK_SIZE = 20;
  const chunkRequests = [];
  for (let i = 0; i < arxivIdsOnly.length; i += CHUNK_SIZE) {
    const chunk = arxivIdsOnly.slice(i, i + CHUNK_SIZE);
    const filterIds = chunk.flatMap(id => {
       const cleanId = id.replace(/v\d+$/, '');
       return [`http://arxiv.org/abs/${cleanId}`, `https://arxiv.org/abs/${cleanId}`];
    }).join('|');
    chunkRequests.push(fetchChunk(`locations.landing_page_url:${encodeURIComponent(filterIds)}`));
  }

  for (let i = 0; i < openAlexIds.length; i += CHUNK_SIZE) {
    const chunk = openAlexIds.slice(i, i + CHUNK_SIZE);
    chunkRequests.push(fetchChunk(buildOpenAlexIdFilter(chunk)));
  }

  await Promise.all(chunkRequests);

  return result;
}

/**
 * Given a list of OpenAlex Work URLs (https://openalex.org/W...), fetch their metadata to get their arXiv IDs.
 * This is used for Capa 2 (Graph exploration).
 */
export async function getArxivIdsForOpenAlexWorks(openAlexUrls) {
  if (!openAlexUrls || openAlexUrls.length === 0) return [];
  const validUrls = openAlexUrls.filter(url => url && typeof url === 'string' && url.includes('/'));
  
  const result = [];
  const toFetch = [];
  
  validUrls.forEach(url => {
    const wId = url.split('/').pop();
    if (GRAPH_CACHE.has(wId)) {
      const cached = GRAPH_CACHE.get(wId);
      if (cached) result.push(cached);
    } else {
      toFetch.push(wId);
    }
  });
  
  if (toFetch.length === 0) return result;
  
  // Randomize and limit to 40 candidates to avoid massive queries
  const candidates = toFetch.sort(() => 0.5 - Math.random()).slice(0, 40);
  
  const url = `https://api.openalex.org/works?filter=${buildOpenAlexIdFilter(candidates)}&per-page=50&select=id,ids`;
  
  try {
     const response = await fetchWithTimeout(url, 10000);
     if (response.ok) {
        const data = await response.json();
        data.results.forEach(work => {
           const wId = work.id.split('/').pop();
           let arxivId = null;
           if (work.ids && work.ids.arxiv) {
              arxivId = work.ids.arxiv.split('/').pop().replace(/v\d+$/, '');
              result.push(arxivId);
           }
           GRAPH_CACHE.set(wId, arxivId); // Cache even if null to avoid re-fetching non-arxiv works
        });
     }
  } catch {
    // Related works fetch failed
  }
  return result;
}
// Helper for strict author name matching
function isNameMatch(p, o) {
  if (p === o) return true;
  if (p.length === 1 && o.charAt(0) === p) return true;
  if (o.length === 1 && p.charAt(0) === o) return true;
  if (p.length > 3 && o.length > 3 && (p.startsWith(o) || o.startsWith(p))) return true;
  return false;
}

function normalizeNameForMatch(name) {
  return name.normalize("NFD")
             .replace(/[\u0300-\u036f]/g, "") // Remove accents
             .replace(/-/g, ' ') // Convert hyphens to spaces
             .toLowerCase()
             .replace(/[^a-z\s]/g, '') // Keep only letters and spaces
             .split(/\s+/)
             .filter(Boolean);
}

function matchesAuthorName(reqName, oaName) {
  if (!reqName || !oaName) return false;
  const reqParts = normalizeNameForMatch(reqName);
  const oaParts = normalizeNameForMatch(oaName);
  
  const reqInOa = reqParts.length > 0 && reqParts.every(p => oaParts.some(o => isNameMatch(p, o)));
  const oaInReq = oaParts.length > 0 && oaParts.every(o => reqParts.some(p => isNameMatch(p, o)));
  
  return reqInOa || oaInReq;
}

/**
 * Fetch author profile from OpenAlex by name.
 * @param {string} authorName 
 * @returns {Promise<Object|null>}
 */
export async function getAuthorProfile(authorName) {
  if (!authorName) return null;
  const cleanName = encodeURIComponent(authorName.trim());
  const url = `https://api.openalex.org/authors?search=${cleanName}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    
    const data = await response.json();
    if (data && data.results && data.results.length > 0) {
      // Find the first result that actually matches the name reasonably well
      let bestAuthor = null;
      for (const author of data.results) {
        if (matchesAuthorName(authorName, author.display_name)) {
          bestAuthor = author;
          break;
        }
      }
      
      if (!bestAuthor) return null;
      
      return {
        id: bestAuthor.id,
        display_name: bestAuthor.display_name,
        works_count: bestAuthor.works_count || 0,
        cited_by_count: bestAuthor.cited_by_count || 0,
        h_index: bestAuthor.summary_stats ? bestAuthor.summary_stats.h_index : 0,
        orcid: bestAuthor.orcid || null,
        institution: (bestAuthor.last_known_institutions && bestAuthor.last_known_institutions.length > 0) 
            ? bestAuthor.last_known_institutions[0].display_name 
            : null,
        concepts: bestAuthor.x_concepts ? bestAuthor.x_concepts.slice(0, 5) : []
      };
    }
  } catch {
    // Get author profile failed
  }
  return null;
}

export async function getAuthorProfileByOrcid(orcidId) {
  const cleanOrcid = orcidId?.match(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i)?.[0]?.toUpperCase();
  if (!cleanOrcid) return null;

  const url = `https://api.openalex.org/authors?filter=orcid:${encodeURIComponent(cleanOrcid)}&per-page=1`;
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    const data = await response.json();
    return data.results?.[0] || null;
  } catch (err) {
    console.error(`OpenAlex ORCID lookup failed for ${cleanOrcid}`, err);
    return null;
  }
}

/**
 * Fetch author profile EXACT match from OpenAlex using a specific paper (arxivId) to disambiguate.
 * @param {string} authorName 
 * @param {string} arxivId 
 * @returns {Promise<Object|null>}
 */
export async function getAuthorProfileExact(authorName, arxivId) {
  if (!authorName) return null;
  
  // If no arxivId, fallback to standard search
  if (!arxivId) return getAuthorProfile(authorName);
  
  try {
    // 1. Fetch the exact work from OpenAlex using the arXiv pseudo-DOI
    const cleanArxivId = arxivId.replace(/v\d+$/, '');
    const workUrl = `https://api.openalex.org/works/doi:10.48550/arxiv.${cleanArxivId}`;
    let workResponse = await fetchWithTimeout(workUrl, 8000).catch(() => null);

    // If direct fetch fails (sometimes OpenAlex drops pseudo-DOIs), fallback to a filter search
    if (!workResponse || !workResponse.ok) {
       const searchUrl = `https://api.openalex.org/works?filter=doi:10.48550/arxiv.${cleanArxivId}`;
       const searchRes = await fetchWithTimeout(searchUrl, 8000).catch(() => null);
       if (searchRes && searchRes.ok) {
          const data = await searchRes.json();
          if (data.results && data.results.length > 0) {
             // We mock a successful workResponse to reuse the logic below
             workResponse = { ok: true, json: async () => data.results[0] };
          }
       }
    }
    
    if (workResponse && workResponse.ok) {
      const workData = await workResponse.json();
      
      if (workData.authorships) {
        // 2. Find the author in the paper's authors list that matches the requested name

        // Exact match or closest match
        let bestMatch = null;
        for (const authorship of workData.authorships) {
           const authorDisplayName = authorship.author.display_name;
           if (!authorDisplayName) continue;
           
           if (matchesAuthorName(authorName, authorDisplayName)) {
              bestMatch = authorship.author;
              break;
           }
        }
        
        // 3. If we found the exact author ID, fetch their specific profile to get H-index etc.
        if (bestMatch && bestMatch.id) {
           const authorProfileUrl = bestMatch.id; // It's a full URL like https://api.openalex.org/authors/A...
           const profileResponse = await fetchWithTimeout(authorProfileUrl, 10000);
           if (profileResponse.ok) {
              const author = await profileResponse.json();
              return {
                id: author.id,
                display_name: author.display_name,
                works_count: author.works_count || 0,
                cited_by_count: author.cited_by_count || 0,
                h_index: author.summary_stats ? author.summary_stats.h_index : 0,
                orcid: author.orcid || null,
                institution: (author.last_known_institutions && author.last_known_institutions.length > 0) 
                    ? author.last_known_institutions[0].display_name 
                    : null,
                concepts: author.x_concepts ? author.x_concepts.slice(0, 5) : []
              };
           }
        } else if (bestMatch) {
           // We found the author in the paper, but OpenAlex failed to link an ID to them for this specific work.
           // Fallback to searching the author database directly using their matched display name.
           const fallback = await getAuthorProfile(bestMatch.display_name || authorName);
           if (fallback) return fallback;
        }
      }
    }
    
    // If the exact match fails (e.g. OpenAlex hasn't indexed this arXiv paper yet), fallback:
    // Do a global search for the name, as it's better than showing an empty stub
    const fallbackProfile = await getAuthorProfile(authorName);
    if (fallbackProfile) return fallbackProfile;

    return {
      id: `stub-${authorName.replace(/\s+/g, '-')}`,
      display_name: authorName,
      works_count: null,
      cited_by_count: null,
      h_index: null,
      institution: null,
      concepts: []
    };
    
  } catch {
    // Fallback if full logic fails
    const fallbackProfile = await getAuthorProfile(authorName);
    if (fallbackProfile) return fallbackProfile;
    
    return {
      id: `stub-${authorName.replace(/\s+/g, '-')}`,
      display_name: authorName,
      works_count: null,
      cited_by_count: null,
      h_index: null,
      institution: null,
      concepts: []
    };
  }
}

/**
 * Search authors by name and return a list of matches.
 * @param {string} query 
 * @returns {Promise<Array>}
 */
/**
 * Collapse duplicate author entries returned by OpenAlex. The API often yields
 * several fragmented records for the same researcher (same name, frequently with
 * an unknown institution and no ORCID). Sharing a name alone does not prove
 * identity, so two records only merge when nothing contradicts it: records with
 * DIFFERENT ORCIDs or DIFFERENT institutions are kept apart as distinct people.
 * The merged entry keeps the richest profile and back-fills missing identity
 * fields from the weaker fragment.
 * @param {Array} authors
 * @returns {Array}
 */
export function dedupeAuthors(authors) {
  const normalize = (value) => (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Higher score = the more prominent / canonical profile. Research output is the
  // primary signal; identity fields (ORCID, institution) are back-filled below.
  const score = (author) => (author.works_count || 0) * 1e6
    + (author.cited_by_count || 0);

  const conflicts = (a, b) => (
    (a.orcid && b.orcid && a.orcid !== b.orcid)
    || (a.institution && b.institution && normalize(a.institution) !== normalize(b.institution))
  );

  // Same name can hold several genuinely distinct people, so each name maps to a
  // LIST of identity clusters instead of a single winner.
  const clustersByName = new Map();
  const ordered = [];
  for (const author of authors) {
    const key = normalize(author.display_name);
    if (!key) continue;
    const clusters = clustersByName.get(key) || [];
    if (!clustersByName.has(key)) clustersByName.set(key, clusters);

    const compatible = clusters.find(cluster => !conflicts(cluster.author, author));
    if (!compatible) {
      const cluster = { author };
      clusters.push(cluster);
      ordered.push(cluster);
      continue;
    }

    const winner = score(author) >= score(compatible.author) ? author : compatible.author;
    const loser = winner === author ? compatible.author : author;
    // Preserve identity fields the stronger record is missing.
    if (!winner.institution && loser.institution) winner.institution = loser.institution;
    if (!winner.institutionData && loser.institutionData) winner.institutionData = loser.institutionData;
    if (!winner.orcid && loser.orcid) winner.orcid = loser.orcid;
    compatible.author = winner;
  }

  return ordered.map(cluster => cluster.author);
}

const AUTHOR_INSTITUTION_LOOKUPS = new Map();

function settleAuthorInstitutionLookup(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(() => finish(null), timeoutMs);

    promise.then(finish).catch(() => finish(null));
  });
}

/**
 * Attach ROR's localized labels to an author institution without changing its
 * OpenAlex identity or canonical display name.
 */
export async function enrichAuthorInstitutionLocalization(author, { timeoutMs = 1800 } = {}) {
  if (!author) return author;

  const sourceInstitution = author.institutionData
    || author.last_known_institutions?.[0]
    || (author.institution ? { display_name: author.institution } : null);
  if (!sourceInstitution) return author;

  const existingNames = sourceInstitution.localized_names || sourceInstitution.localizedNames || {};
  if (existingNames.es && existingNames.en) {
    return { ...author, institutionData: sourceInstitution };
  }

  const lookupKey = sourceInstitution.ror
    || sourceInstitution.id
    || String(sourceInstitution.display_name || '').trim().toLowerCase();
  if (!lookupKey) return { ...author, institutionData: sourceInstitution };

  let lookup = AUTHOR_INSTITUTION_LOOKUPS.get(lookupKey);
  if (!lookup) {
    lookup = sourceInstitution.ror
      ? getRorInstitution(sourceInstitution.ror).catch(() => null)
      : resolveRorInstitution({ name: sourceInstitution.display_name }).catch(() => null);
    AUTHOR_INSTITUTION_LOOKUPS.set(lookupKey, lookup);
  }

  const rorInstitution = await settleAuthorInstitutionLookup(lookup, timeoutMs);
  const localizedNames = rorInstitution?.localized_names || {};
  const localizedInstitution = {
    ...sourceInstitution,
    localized_names: { ...existingNames, ...localizedNames },
    ror: sourceInstitution.ror || rorInstitution?.ror,
  };

  const lastKnownInstitutions = Array.isArray(author.last_known_institutions)
    ? [localizedInstitution, ...author.last_known_institutions.slice(1)]
    : author.last_known_institutions;

  return {
    ...author,
    institutionData: localizedInstitution,
    last_known_institutions: lastKnownInstitutions,
  };
}

export async function searchAuthors(query, options = {}) {
  if (!query) return [];
  const normalizedQuery = query.trim();
  const cleanName = encodeURIComponent(normalizedQuery);
  const url = `https://api.openalex.org/authors?search=${cleanName}&per-page=10`;
  
  try {
    const data = await openAlexJson(url, {
      timeoutMs: 7000,
      cacheTtlMs: 10 * 60 * 1000,
      staleIfError: true,
      persistentKey: `author-search:${normalizedQuery.toLowerCase()}`,
      persistentTtlMs: 24 * 60 * 60 * 1000,
      signal: options.signal,
    });

    const authors = (data?.results || []).map(author => ({
      id: author.id,
      display_name: author.display_name,
      works_count: author.works_count || 0,
      cited_by_count: author.cited_by_count || 0,
      h_index: author.summary_stats?.h_index || 0,
      orcid: author.orcid || null,
      institution: author.last_known_institutions?.[0]?.display_name || null,
      concepts: (author.x_concepts || []).slice(0, 5),
    })).filter(author => author.id && author.display_name);

    return dedupeAuthors(authors);
  } catch (error) {
    if (options.throwOnError) throw error;
    // Search authors failed
  }
  return [];
}

// ROR answers a search with one page of twenty. Asking for all of them and
// cutting to five only after the tie-break is the entire fix: cutting first is
// what threw away Massachusetts Institute of Technology, which ROR puts seventh.
const INSTITUTION_SEARCH_CANDIDATES = 20;
const INSTITUTION_SEARCH_LIMIT = 5;

// The same 1 500 ms this search path already allows `enrichAuthorInstitutionLocalization`,
// for the same reason. `settleSearch` gives the institutions task 4 500 ms and
// ROR spends ~250 ms of it (measured against the live API, 2026-08-26), so a
// second-and-a-half is affordable while still leaving the section time to
// render. `retries: 0` is load-bearing: the client retries twice by default,
// which would put three timeouts inside a budget that only has room for one.
const INSTITUTION_PROMINENCE_TIMEOUT_MS = 1500;

/**
 * `ror:a|b|c` — values of ONE filter, never `ror:a|ror:b`.
 *
 * The same trap `buildOpenAlexIdFilter` documents for work identifiers:
 * OpenAlex refuses an OR across filters with «It looks like you're trying to do
 * an OR query between filters and it's not supported».
 */
export function buildRorIdFilter(rorIds) {
  const values = [...new Set((Array.isArray(rorIds) ? rorIds : [])
    .map(id => normalizeRorId(id))
    .filter(Boolean))];
  return values.length > 0 ? `ror:${encodeURIComponent(values.join('|'))}` : '';
}

/**
 * The counts ROR does not carry, for a whole candidate list in one request.
 *
 * Filtering by the ROR identifiers we already hold, rather than searching
 * OpenAlex for the same words a second time, is what makes the coverage
 * complete: measured against the live APIs on 2026-08-26, this answered for
 * 20 of 20 candidates, where `?search=MIT` covered 14 and spent 11 of its 25
 * slots on organisations that were never candidates. A candidate OpenAlex's own
 * relevance leaves out would weigh nothing and sink for a reason that has
 * nothing to do with how prominent it is.
 */
export async function fetchInstitutionProminence(rorIds, options = {}) {
  const filter = buildRorIdFilter(rorIds);
  if (!filter) return new Map();

  // Injectable for the test, the way `OpenAlexClient` already takes `fetchImpl`
  // and `storage`. The shared client binds `globalThis.fetch` when the module
  // loads — deliberately, so Safari keeps the native receiver — so swapping the
  // global does NOT reach it, and a test that tried would quietly hit the live
  // API and pass on whatever OpenAlex happened to say that day.
  const requestJson = options.openAlexJson || openAlexJson;
  const url = `https://api.openalex.org/institutions?filter=${filter}`
    + `&per-page=${INSTITUTION_SEARCH_CANDIDATES}`
    + '&select=ror,works_count,cited_by_count,summary_stats';
  const data = await requestJson(url, {
    timeoutMs: INSTITUTION_PROMINENCE_TIMEOUT_MS,
    retries: 0,
    cacheTtlMs: 10 * 60 * 1000,
    signal: options.signal,
  });

  const prominenceByRorId = new Map();
  (data?.results || []).forEach((result) => {
    const rorId = normalizeRorId(result?.ror);
    if (rorId) prominenceByRorId.set(rorId, result);
  });
  return prominenceByRorId;
}

/**
 * Fills in the three fields `normalizeRorInstitution` ships as null, and only
 * those.
 *
 * Deliberately NOT `mergeInstitutionWithRor`, which takes `id` from the
 * OpenAlex side. Both search surfaces navigate with
 * `institution.id.split('/').pop()` and expect a ROR identifier there
 * (SearchPage.jsx, SearchCommand.jsx), so swapping in an OpenAlex id would
 * hand the explorer an `I…` where it wants an `0…` on every institution result.
 */
export function applyInstitutionProminence(institutions, prominenceByRorId) {
  if (!prominenceByRorId?.size) return institutions;
  return institutions.map((institution) => {
    const prominence = prominenceByRorId.get(institution._rorId);
    if (!prominence) return institution;
    return {
      ...institution,
      works_count: prominence.works_count ?? institution.works_count,
      cited_by_count: prominence.cited_by_count ?? institution.cited_by_count,
      summary_stats: prominence.summary_stats ?? institution.summary_stats,
    };
  });
}

/**
 * Best-effort by construction: the prominence lookup can only change the ORDER.
 *
 * OpenAlex is metered and rate-limited and this runs on a 4 500 ms budget, so
 * every way the second request can fail — down, throttled, slow, cancelled —
 * has to leave the candidates exactly as ROR sent them. Losing the tie-break is
 * a worse answer; losing the section is a bug.
 */
async function rankInstitutionsByProminence(query, candidates, options = {}) {
  if (candidates.length <= 1) return candidates;

  const prominenceByRorId = await fetchInstitutionProminence(
    candidates.map(candidate => candidate._rorId),
    options,
  ).catch(() => null);
  if (!prominenceByRorId?.size) return candidates;

  return filterRelevantSearchResults(
    query,
    applyInstitutionProminence(candidates, prominenceByRorId),
    institutionSearchValues,
    { getWeight: institutionProminenceWeight },
  );
}

/**
 * Search institutions by name.
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function searchInstitutions(query, options = {}) {
  if (!query) return [];
  try {
    const candidates = await searchRorInstitutions(query, INSTITUTION_SEARCH_CANDIDATES, options);
    const ranked = await rankInstitutionsByProminence(query, candidates, options);
    return ranked.slice(0, INSTITUTION_SEARCH_LIMIT).map(institution => ({
      ...institution,
      country_code: institution.geo?.country || institution.country_code || '',
    }));
  } catch (error) {
    if (options.throwOnError) throw error;
    // Search institutions failed
  }
  return [];
}

function normalizeTopicSearchValue(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreTopicMatch(query, values) {
  const normalizedQuery = normalizeTopicSearchValue(query);
  if (!normalizedQuery) return -1;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  let bestScore = -1;
  values.forEach((value, index) => {
    const normalizedValue = normalizeTopicSearchValue(value);
    if (!normalizedValue) return;
    const sourceWeight = Math.max(0, 4 - index);
    if (normalizedValue === normalizedQuery) {
      bestScore = Math.max(bestScore, 100 + sourceWeight);
    } else if (normalizedValue.startsWith(normalizedQuery)) {
      bestScore = Math.max(bestScore, 85 + sourceWeight);
    } else if (normalizedValue.includes(normalizedQuery)) {
      bestScore = Math.max(bestScore, 75 + sourceWeight);
    } else if (queryTokens.length > 1 && queryTokens.every(token => normalizedValue.includes(token))) {
      bestScore = Math.max(bestScore, 65 + sourceWeight);
    }
  });
  return bestScore;
}

export function searchLocalTopics(query, language = 'es', limit = 8) {
  if (!query?.trim()) return [];
  const matches = [];

  Object.entries(CATEGORIES).forEach(([id, category]) => {
    const categoryScore = scoreTopicMatch(query, [
      category.label,
      category.labelEn,
      id,
      category.description,
      category.descriptionEn,
    ]);
    if (categoryScore >= 0) {
      matches.push({
        id,
        display_name: language === 'en' ? category.labelEn || category.label : category.label,
        labelEs: category.label,
        labelEn: category.labelEn,
        description: language === 'en'
          ? category.descriptionEn || category.description
          : category.description,
        level: 0,
        categoryIds: Object.keys(category.subcategories || {}),
        subcategoryCount: Object.keys(category.subcategories || {}).length,
        works_count: null,
        _localTopic: true,
        _searchScore: categoryScore,
      });
    }

    Object.entries(category.subcategories || {}).forEach(([subcategoryId, subcategory]) => {
      const subcategoryScore = scoreTopicMatch(query, [
        subcategory.label,
        subcategory.labelEn,
        subcategoryId,
        category.label,
        category.labelEn,
      ]);
      if (subcategoryScore < 0) return;
      matches.push({
        id: subcategoryId,
        display_name: language === 'en'
          ? subcategory.labelEn || subcategory.label
          : subcategory.label,
        labelEs: subcategory.label,
        labelEn: subcategory.labelEn,
        description: language === 'en'
          ? category.descriptionEn || category.description
          : category.description,
        parent_display_name: language === 'en'
          ? category.labelEn || category.label
          : category.label,
        level: 1,
        categoryIds: [subcategoryId],
        works_count: null,
        _localTopic: true,
        _searchScore: subcategoryScore,
      });
    });
  });

  return matches
    .sort((a, b) => b._searchScore - a._searchScore || a.display_name.localeCompare(b.display_name))
    .slice(0, Math.max(1, limit))
    .map(topic => {
      const result = { ...topic };
      delete result._searchScore;
      return result;
    });
}

/**
 * Search PaperTok's bilingual taxonomy first, then enrich it with current
 * OpenAlex topics when the provider is available.
 */
export async function searchConcepts(query, options = {}) {
  if (!query?.trim()) return [];
  const language = options.language === 'en' ? 'en' : 'es';
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 8));
  const normalizedQuery = query.trim();
  const localTopics = searchLocalTopics(normalizedQuery, language, limit);

  try {
    const url = new URL('https://api.openalex.org/autocomplete/topics');
    url.searchParams.set('q', normalizedQuery);
    const data = await openAlexJson(url.toString(), {
      timeoutMs: 3500,
      retries: 0,
      cacheTtlMs: 30 * 60 * 1000,
      persistentKey: `topic-search:${normalizedQuery.toLowerCase()}`,
      persistentTtlMs: 7 * 24 * 60 * 60 * 1000,
      staleIfError: true,
      signal: options.signal,
    });

    const seen = new Set(localTopics.flatMap(topic => [
      normalizeTopicSearchValue(topic.display_name),
      normalizeTopicSearchValue(topic.labelEs),
      normalizeTopicSearchValue(topic.labelEn),
    ]).filter(Boolean));
    const remoteTopics = (data?.topics || data?.results || []).flatMap(topic => {
      const id = String(topic?.id || '').split('/').pop();
      const nameKey = normalizeTopicSearchValue(topic?.display_name);
      if (!/^T\d+$/i.test(id) || !nameKey || seen.has(nameKey)) return [];
      seen.add(nameKey);
      return [{
        id,
        display_name: topic.display_name,
        description: topic.description || topic.hint || '',
        level: 2,
        categoryIds: [],
        works_count: Number.isFinite(topic.works_count) ? topic.works_count : null,
        field_display_name: topic.field?.display_name
          || topic.subfield?.display_name
          || topic.field_display_name
          || '',
        keywords: Array.isArray(topic.keywords) ? topic.keywords.slice(0, 5) : [],
        _localTopic: false,
      }];
    });

    return [...localTopics, ...remoteTopics].slice(0, limit);
  } catch {
    return localTopics;
  }
}

export function getLocalTopicEntity(id, language = 'es') {
  const area = CATEGORIES[id];
  if (area) {
    return {
      id,
      display_name: language === 'en' ? area.labelEn || area.label : area.label,
      labelEs: area.label,
      labelEn: area.labelEn,
      description: language === 'en' ? area.descriptionEn || area.description : area.description,
      descriptionEs: area.description,
      descriptionEn: area.descriptionEn,
      level: 0,
      categoryIds: Object.keys(area.subcategories || {}),
      _localTopic: true,
    };
  }
  for (const areaValue of Object.values(CATEGORIES)) {
    const subcategory = areaValue.subcategories?.[id];
    if (subcategory) {
      return {
        id,
        display_name: language === 'en' ? subcategory.labelEn || subcategory.label : subcategory.label,
        labelEs: subcategory.label,
        labelEn: subcategory.labelEn,
        description: language === 'en'
          ? areaValue.descriptionEn || areaValue.description
          : areaValue.description,
        descriptionEs: areaValue.description,
        descriptionEn: areaValue.descriptionEn,
        level: 1,
        categoryIds: [id],
        _localTopic: true,
      };
    }
  }
  return null;
}

/**
 * Search journals/sources by name.
 */
export async function searchSources() {
  // Free openalex api is down. For now, we return empty so it doesn't crash.
  return [];
}

/**
 * Look up an OpenAlex institution by its ROR identifier or name.
 * Returns { id, display_name } or null if not found.
 */
export async function findInstitution({ rorUrl, name, aliases = [] }) {
  let resolvedRorUrl = rorUrl;
  if (!resolvedRorUrl && name) {
    const rorInstitution = await resolveRorInstitution({ name }).catch(() => null);
    resolvedRorUrl = rorInstitution?.ror || null;
  }

  if (resolvedRorUrl) {
    const rorId = resolvedRorUrl.replace(/^https?:\/\/ror\.org\//, '');
    const url = `https://api.openalex.org/institutions?filter=ror:${rorId}&select=id,display_name`;
    try {
      const res = await fetchWithTimeout(url, 4000);
      if (res.ok) {
        const data = await res.json();
        const inst = data.results?.[0];
        if (inst) {
          return {
            id: inst.id.split('/').pop(),
            display_name: inst.display_name
          };
        }
      }
    } catch { /* ROR lookup failed, try name search */ }
  }

  const candidateNames = [...new Set([name, ...aliases].map(value => value?.trim()).filter(Boolean))];
  for (const candidateName of candidateNames) {
    const url = `https://api.openalex.org/institutions?search=${encodeURIComponent(candidateName)}&select=id,display_name&per-page=1`;
    try {
      const res = await fetchWithTimeout(url, 4000);
      if (res.ok) {
        const data = await res.json();
        const inst = data.results?.[0];
        if (inst) {
          return {
            id: inst.id.split('/').pop(),
            display_name: inst.display_name
          };
        }
      }
    } catch { /* Name lookup failed, try the next alias */ }
  }

  return null;
}

/**
 * Fetch entity metadata by ID
 */
export async function getEntityById(type, id) {
  if (!id) return null;
  if (type === 'concept' || type === 'topic') {
    const localTopic = getLocalTopicEntity(id);
    if (localTopic) return localTopic;
  }
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const persistentCacheKey = `entity:${type}:${cleanId}`;
  const cachedEntity = readOpenAlexPersistent(persistentCacheKey, ENTITY_CACHE_TTL_MS);
  if (cachedEntity && !cachedEntity.stale) {
    return type === 'institution'
      ? enrichInstitutionWithRor(cachedEntity.data)
      : cachedEntity.data;
  }

  const persistEntity = (data) => {
    if (data) writeOpenAlexPersistent(persistentCacheKey, data);
    return data;
  };
  const readStaleEntity = () => {
    const stale = readOpenAlexPersistent(persistentCacheKey, ENTITY_STALE_TTL_MS);
    return stale && !stale.stale
      ? { ...stale.data, _openAlexCacheStatus: 'stale', _openAlexCachedAt: stale.savedAt }
      : null;
  };
  
  // If it's an institution and the ID is a ROR ID, resolve via ROR filter
  if (type === 'institution' && (id.includes('ror.org') || !cleanId.startsWith('I'))) {
    const rorUrl = id.startsWith('http') ? id : `https://ror.org/${cleanId}`;
    const url = `https://api.openalex.org/institutions?filter=ror:${encodeURIComponent(rorUrl)}`;
    const rorPromise = getRorInstitution(rorUrl).catch(() => null);
    try {
      const response = await fetchWithTimeout(url, 10000);
      if (response.status === 404) return persistEntity(await rorPromise);
      if (!response.ok) throw new Error(`OpenAlex API error: ${response.status}`);
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        const institution = data.results[0];
        if (institution.works_count > 0) {
          return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
        }

        const worksUrl = `https://api.openalex.org/works?filter=institutions.ror:${encodeURIComponent(rorUrl)}&per-page=1&select=id`;
        try {
          const worksResponse = await fetchWithTimeout(worksUrl, 10000);
          if (!worksResponse.ok) return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
          const worksData = await worksResponse.json();
          const withWorks = applyInstitutionWorksFallback(institution, worksData.meta?.count);
          return persistEntity(await enrichInstitutionWithRor(withWorks, await rorPromise));
        } catch {
          return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
        }
      }
      return persistEntity(await rorPromise);
    } catch (err) {
      const staleEntity = readStaleEntity();
      if (staleEntity) return enrichInstitutionWithRor(staleEntity, await rorPromise);
      const rorFallback = await rorPromise;
      if (rorFallback) return persistEntity(rorFallback);
      console.error(`OpenAlex getEntityById by ROR filter failed for ${id}`, err);
      throw err;
    }
  }
  
  const endpoint = type === 'institution'
    ? 'institutions'
    : type === 'concept'
      ? 'concepts'
      : type === 'topic'
        ? 'topics'
        : type === 'source'
          ? 'sources'
          : 'authors';
  const url = `https://api.openalex.org/${endpoint}/${cleanId}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenAlex API error: ${response.status}`);
    let data = await response.json();

    if (type === 'institution' && data?.works_count === 0) {
      const filterKey = data.ror ? 'institutions.ror' : 'institutions.id';
      const filterValue = data.ror || cleanId;
      const worksUrl = `https://api.openalex.org/works?filter=${filterKey}:${encodeURIComponent(filterValue)}&per-page=1&select=id`;
      try {
        const worksResponse = await fetchWithTimeout(worksUrl, 10000);
        if (worksResponse.ok) {
          const worksData = await worksResponse.json();
          data = applyInstitutionWorksFallback(data, worksData.meta?.count);
        }
      } catch {
        // Preserve the institution profile even when the metrics fallback is unavailable.
      }
    }

    if (type === 'institution') {
      data = await enrichInstitutionWithRor(data);
    }
    
    // If it's a concept, translate back to Spanish
    if ((type === 'concept' || type === 'topic') && data && data.display_name) {
      let translatedName = data.display_name;
      Object.values(CATEGORIES).forEach(cat => {
        if (cat.labelEn.toLowerCase() === data.display_name.toLowerCase()) translatedName = cat.label;
        if (cat.subcategories) {
          Object.values(cat.subcategories).forEach(sub => {
            if (sub.labelEn.toLowerCase() === data.display_name.toLowerCase()) translatedName = sub.label;
          });
        }
      });
      data.display_name = translatedName;
    }
    
    return persistEntity(data);
  } catch (err) {
    const staleEntity = readStaleEntity();
    if (staleEntity) {
      return type === 'institution'
        ? enrichInstitutionWithRor(staleEntity)
        : staleEntity;
    }
    console.error(`OpenAlex getEntityById failed for ${type} ${id}`, err);
    throw err;
  }
}

export function normalizeRecentImpactEntityId(type, value) {
  const prefix = type === 'institution' ? 'I' : type === 'author' ? 'A' : '';
  if (!prefix) return '';
  const rawId = typeof value === 'object' ? value?.id : value;
  const match = String(rawId || '').match(new RegExp(`(?:openalex\\.org/)?(${prefix}\\d+)`, 'i'));
  return match?.[1]?.toUpperCase() || '';
}

async function resolveRecentImpactEntityId(type, entityOrId) {
  const directId = normalizeRecentImpactEntityId(type, entityOrId);
  if (directId) return directId;

  if (type === 'institution') {
    const rawRor = typeof entityOrId === 'object'
      ? entityOrId?.ror || entityOrId?._rorId || entityOrId?.id
      : entityOrId;
    const rorId = normalizeRorId(rawRor);
    if (!rorId) return '';
    const data = await openAlexJson(
      `https://api.openalex.org/institutions?filter=ror:${rorId}&per-page=1&select=id`,
      {
        timeoutMs: 7000,
        retries: 1,
        cacheTtlMs: 24 * 60 * 60 * 1000,
        persistentKey: `recent-impact-identity:institution:${rorId}`,
        persistentTtlMs: 30 * 24 * 60 * 60 * 1000,
        staleIfError: true,
      },
    );
    return normalizeRecentImpactEntityId(type, data?.results?.[0]?.id);
  }

  const rawOrcid = typeof entityOrId === 'object' ? entityOrId?.orcid : entityOrId;
  const orcid = String(rawOrcid || '').match(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i)?.[0]?.toUpperCase();
  if (!orcid) return '';
  const data = await openAlexJson(
    `https://api.openalex.org/authors?filter=orcid:${encodeURIComponent(orcid)}&per-page=1&select=id`,
    {
      timeoutMs: 7000,
      retries: 1,
      cacheTtlMs: 24 * 60 * 60 * 1000,
      persistentKey: `recent-impact-identity:author:${orcid}`,
      persistentTtlMs: 30 * 24 * 60 * 60 * 1000,
      staleIfError: true,
    },
  );
  return normalizeRecentImpactEntityId(type, data?.results?.[0]?.id);
}

export function buildRecentImpactUrl(type, openAlexId, period, attempt = 0) {
  const config = getRecentImpactConfig(type);
  const normalizedId = normalizeRecentImpactEntityId(type, openAlexId);
  if (!config || !normalizedId || !period?.from || !period?.to) return '';
  const filterKey = type === 'institution' ? 'institutions.id' : 'author.id';
  const numericSeed = Number(normalizedId.slice(1)) || 1;
  const params = new URLSearchParams({
    filter: [
      `${filterKey}:${normalizedId}`,
      `from_publication_date:${period.from}`,
      `to_publication_date:${period.to}`,
    ].join(','),
    sample: String(config.sampleSize),
    seed: String(numericSeed + attempt),
    'per-page': String(config.sampleSize),
    select: 'id,fwci,publication_date',
  });
  return `https://api.openalex.org/works?${params}`;
}

export async function fetchRecentImpactWorks(type, openAlexId, period, fetchJson = openAlexJson) {
  const config = getRecentImpactConfig(type);
  if (!config) return { works: [], attempts: 0 };
  const uniqueWorks = new Map();
  let attempts = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = buildRecentImpactUrl(type, openAlexId, period, attempt);
    if (!url) break;
    const data = await fetchJson(url, {
      timeoutMs: 12000,
      cacheTtlMs: 60 * 60 * 1000,
      retries: 1,
    });
    attempts += 1;
    const results = Array.isArray(data?.results) ? data.results : [];
    results.forEach((work, index) => {
      const key = work?.id || `${attempt}:${index}`;
      uniqueWorks.set(key, work);
    });

    const works = [...uniqueWorks.values()];
    if (calculateEntityRecentImpact(works, config.minimumSampleSize).available) break;
    if (results.length < config.sampleSize) break;
  }

  return { works: [...uniqueWorks.values()], attempts };
}

function recentImpactCacheTtl(impact) {
  return impact?.available ? IMPACT_CACHE_TTL_MS : IMPACT_INSUFFICIENT_TTL_MS;
}

export async function getEntityRecentImpact(type, entityOrId, now = new Date()) {
  const config = getRecentImpactConfig(type);
  if (!config || !entityOrId) return null;
  const period = getRecentImpactPeriod(now);
  const openAlexId = await resolveRecentImpactEntityId(type, entityOrId);
  if (!openAlexId) {
    return {
      available: false,
      reason: 'unresolved_identity',
      sampleSize: 0,
      minimumSampleSize: config.minimumSampleSize,
      period,
      source: 'OpenAlex',
    };
  }

  const cacheKey = `${type}:${openAlexId}:${period.from}:${period.to}`;
  const memoryEntry = RECENT_IMPACT_CACHE.get(cacheKey);
  if (memoryEntry && Date.now() - memoryEntry.savedAt <= recentImpactCacheTtl(memoryEntry.data)) {
    return {
      ...memoryEntry.data,
      cacheStatus: 'memory-cache',
      cachedAt: memoryEntry.savedAt,
    };
  }
  if (memoryEntry) RECENT_IMPACT_CACHE.delete(cacheKey);

  const persistentCacheKey = `recent-impact:v2:${cacheKey}`;
  const cachedImpact = readOpenAlexPersistent(persistentCacheKey, Number.POSITIVE_INFINITY);
  if (cachedImpact && cachedImpact.ageMs <= recentImpactCacheTtl(cachedImpact.data)) {
    const impact = {
      ...cachedImpact.data,
      cacheStatus: 'fresh-cache',
      cachedAt: cachedImpact.savedAt,
    };
    RECENT_IMPACT_CACHE.set(cacheKey, { data: impact, savedAt: cachedImpact.savedAt });
    return impact;
  }

  try {
    const sample = await fetchRecentImpactWorks(type, openAlexId, period);
    const impact = {
      ...calculateEntityRecentImpact(sample.works, config.minimumSampleSize),
      entityType: type,
      openAlexId,
      period,
      source: 'OpenAlex',
      sampled: true,
      sampleAttempts: sample.attempts,
      cacheStatus: 'network',
      cachedAt: Date.now(),
    };

    if (!impact.available && cachedImpact?.data?.available && cachedImpact.ageMs <= IMPACT_STALE_TTL_MS) {
      return {
        ...cachedImpact.data,
        cacheStatus: 'stale-cache',
        stale: true,
        cachedAt: cachedImpact.savedAt,
      };
    }

    writeOpenAlexPersistent(persistentCacheKey, impact);
    RECENT_IMPACT_CACHE.set(cacheKey, { data: impact, savedAt: impact.cachedAt });
    return impact;
  } catch (error) {
    if (cachedImpact?.data?.available && cachedImpact.ageMs <= IMPACT_STALE_TTL_MS) {
      return {
        ...cachedImpact.data,
        cacheStatus: 'stale-cache',
        stale: true,
        rateLimited: isOpenAlexRateLimitError(error),
        cachedAt: cachedImpact.savedAt,
      };
    }
    throw error;
  }
}

export function getInstitutionRecentImpact(entityOrId, now = new Date()) {
  return getEntityRecentImpact('institution', entityOrId, now);
}

export function getAuthorRecentImpact(entityOrId, now = new Date()) {
  return getEntityRecentImpact('author', entityOrId, now);
}

/**
 * OpenAlex Concept Mapping for PaperTok Categories
 */
const OA_CONCEPT_MAP = {
  'physics': 'C121332964',
  'cs': 'C41008148',
  'math': 'C33923547',
  'q-bio': 'C86803240',
  'stat': 'C105795698',
  'econ': 'C162324750',
  'eess': 'C127413603',
  'q-fin': 'C144133560'
};

/**
 * Fetch works for a specific entity
 * type: 'institution', 'concept', 'author'
 * sortBy: 'cited_by_count:desc' or 'publication_date:desc'
 * filters: { category: string, peerReviewed: boolean, dateRange: string }
 */
export async function getWorksByEntity(type, id, sortBy = 'cited_by_count:desc', page = 1, searchQuery = '', filters = {}, entityName = '') {
  if (!id) return { papers: [], total: 0 };
  
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const isRor = type === 'institution' && (id.includes('ror.org') || !cleanId.startsWith('I'));
  
  let filterKey;
  if (type === 'institution') {
    filterKey = isRor ? 'institutions.ror' : 'institutions.id';
  } else if (type === 'concept') {
    filterKey = 'concepts.id';
  } else if (type === 'topic') {
    filterKey = 'topics.id';
  } else if (type === 'source') {
    filterKey = 'locations.source.id';
  } else {
    filterKey = 'author.id';
  }
  
  const filterId = isRor ? (id.startsWith('http') ? id : `https://ror.org/${cleanId}`) : cleanId;
  let filterParams = `${filterKey}:${filterId}`;
  
  // Advanced Filters
  if (filters.peerReviewed) {
    filterParams += ',primary_location.is_published:true';
  }
  if (filters.category) {
    const prefix = filters.category.split('.')[0];
    if (OA_CONCEPT_MAP[prefix]) {
      filterParams += `,concepts.id:${OA_CONCEPT_MAP[prefix]}`;
    }
  }
  if (filters.dateRange) {
    const today = new Date();
    if (filters.dateRange === 'last_year') {
      const lastYear = new Date(today.setFullYear(today.getFullYear() - 1)).toISOString().split('T')[0];
      filterParams += `,from_publication_date:${lastYear}`;
    } else if (filters.dateRange === 'last_5_years') {
      const last5Years = new Date(today.setFullYear(today.getFullYear() - 5)).toISOString().split('T')[0];
      filterParams += `,from_publication_date:${last5Years}`;
    }
  }
  
  let url = `https://api.openalex.org/works?filter=${filterParams}&sort=${sortBy}&per-page=30&page=${page}`;
  if (searchQuery) {
     url += `&search=${encodeURIComponent(searchQuery)}`;
  }
  const worksCacheKey = `entity-works:${type}:${cleanId}:${sortBy}:${page}:${searchQuery}:${JSON.stringify(filters)}`;
  
  try {
    const data = await openAlexJson(url, {
      timeoutMs: 7000,
      retries: 0,
      cacheTtlMs: 5 * 60 * 1000,
      persistentKey: worksCacheKey,
      persistentTtlMs: ENTITY_WORKS_CACHE_TTL_MS,
      staleIfError: true,
    });
    if (data && data.results) {
       const papers = data.results.map(formatOpenAlexWorkAsPaper).filter(Boolean);
       return { papers, total: data.meta ? data.meta.count : 0 };
    }
  } catch (err) {
    console.error(`OpenAlex getWorksByEntity failed for ${type} ${id}`, err);
    if (type === 'institution') {
      try {
        return await getInstitutionWorksFromCrossref(
          entityName,
          page,
          searchQuery,
          filters,
          crossrefUrl => fetchWithTimeout(crossrefUrl, 10000),
        );
      } catch (fallbackError) {
        console.error(`Crossref institution fallback failed for ${entityName || id}`, fallbackError);
      }
    }
    throw err;
  }
  return { papers: [], total: 0 };
}

/**
 * Fetch authors for a specific entity (e.g. institution or concept)
 */
export async function getAuthorsByEntity(type, id, page = 1, searchQuery = '', entityName = '') {
  if (!id || type === 'author') return { authors: [], total: 0 };
  
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const isRor = type === 'institution' && (id.includes('ror.org') || !cleanId.startsWith('I'));
  
  let filterKey;
  if (type === 'institution') {
    filterKey = isRor ? 'last_known_institutions.ror' : 'last_known_institutions.id';
  } else {
    filterKey = 'x_concepts.id';
  }
  
  const filterId = isRor ? (id.startsWith('http') ? id : `https://ror.org/${cleanId}`) : cleanId;
  const params = new URLSearchParams({
    filter: `${filterKey}:${filterId}`,
    sort: 'cited_by_count:desc',
    'per-page': '30',
    page: String(page),
  });
  if (searchQuery) params.set('search', searchQuery);
  const url = `https://api.openalex.org/authors?${params}`;
  const authorsCacheKey = `entity-authors:${type}:${cleanId}:${page}:${searchQuery.trim().toLowerCase()}`;
  
  try {
    const data = await openAlexJson(url, {
      timeoutMs: 7000,
      retries: 0,
      cacheTtlMs: 5 * 60 * 1000,
      persistentKey: authorsCacheKey,
      persistentTtlMs: ENTITY_WORKS_CACHE_TTL_MS,
      staleIfError: true,
    });
    if (data && data.results) {
       const authors = data.results.map(author => ({
          id: author.id,
          display_name: author.display_name,
          works_count: author.works_count || 0,
          cited_by_count: author.cited_by_count || 0,
          h_index: author.summary_stats ? author.summary_stats.h_index : 0,
          institution: (author.last_known_institutions && author.last_known_institutions.length > 0) 
              ? author.last_known_institutions[0].display_name 
              : null,
          concepts: author.x_concepts ? author.x_concepts.slice(0, 3) : []
       }));
       return { authors, total: data.meta ? data.meta.count : 0 };
    }
  } catch (err) {
    console.error(`OpenAlex getAuthorsByEntity failed for ${type} ${id}`, err);
    if (type === 'institution') {
      try {
        return await getInstitutionAuthorsFromCrossref(
          entityName,
          page,
          searchQuery,
          crossrefUrl => fetchWithTimeout(crossrefUrl, 10000),
        );
      } catch (fallbackError) {
        console.error(`Crossref institution authors fallback failed for ${entityName || id}`, fallbackError);
      }
    }
    throw err;
  }
  return { authors: [], total: 0 };
}

/**
 * Fetch full paper metadata from OpenAlex using a list of DOIs,
 * and format them as standard Paper objects (since they might not be on arXiv).
 * @param {string[]} dois 
 */
export async function fetchPapersByDois(dois, options = {}) {
  if (!dois || dois.length === 0) return [];
  
  const cleanDois = dois.map(doi => {
    if (doi.includes('doi.org/')) return doi.split('doi.org/')[1];
    return doi;
  }).filter(Boolean);
  
  if (cleanDois.length === 0) return [];
  
  const results = [];
  const chunkSize = 40;
  for (let i = 0; i < cleanDois.length; i += chunkSize) {
    const chunk = cleanDois.slice(i, i + chunkSize);
    // OpenAlex OR syntax requires the property name once: filter=doi:A|B|C
    const filterIds = chunk.join('|');
    const url = `https://api.openalex.org/works?filter=doi:${filterIds}&per-page=50`;
    
    try {
      const response = await fetchWithTimeout(url, 10000);
      if (response.ok) {
        const data = await response.json();
        if (data && data.results) {
          results.push(...data.results);
        }
      }
    } catch (err) {
      console.error("OpenAlex fetchPapersByDois failed", err);
      if (options.throwOnProviderError) throw err;
    }
  }
  
  return results.map(work => {
    return formatOpenAlexWorkAsPaper(work);
  });
}

function formatOpenAlexWorkAsPaper(work) {
  const summary = reconstructOpenAlexAbstract(work.abstract_inverted_index) || 'Resumen no disponible.';
  
  const authors = work.authorships?.map(a => ({ name: a.author?.display_name || 'Unknown Author', id: a.author?.id })) || [{ name: 'Unknown Author' }];
  const institutions = [...new Map((work.authorships || [])
    .flatMap(authorship => authorship.institutions || [])
    .filter(Boolean)
    .map(institution => [institution.id || institution.ror || institution.display_name, {
      id: institution.id,
      ror: institution.ror,
      displayName: institution.display_name,
    }])).values()];
  const categories = work.concepts?.map(c => c.display_name) || [];
  const openAlexId = work.id.split('/').pop();
  
  return PaperBuilder.create({
    id: openAlexId,
    sources: { primary: 'openalex', enrichedBy: [] },
    title: work.title || 'No Title',
    abstract: summary || 'No summary available.',
    authors,
    institutions,
    year: work.publication_date ? new Date(work.publication_date).getFullYear() : new Date().getFullYear(),
    publicationType: work.primary_location?.source?.type || 'journal',
    publicationStatus: work.primary_location?.is_published ? 'published' : 'preprint',
    openAccess: work.open_access?.is_oa,
    pdfUrl: work.open_access?.oa_url,
    landingPageUrl: work.primary_location?.landing_page_url || work.id,
    doi: work.doi,
    arxivId: getArxivIdFromWork(work) || undefined,
    journal: work.primary_location?.source?.display_name,
    publisher: work.primary_location?.source?.host_organization_name,
    citationCount: work.cited_by_count || 0,
    citationCountKnown: Number.isFinite(work.cited_by_count),
    concepts: work.concepts || [],
    categories: categories,
    keywords: categories,
    // The work's branch of science, kept because `categories` above is a list
    // of concept names — "Toric code", "The Imaginary" — and a concept is not a
    // field. Without this the Explorer's rows had nothing to take a field
    // colour from and every one of them rendered in the brand ink, while the
    // same paper in the feed, which arrives with an arXiv category, rendered in
    // its own. `areaAccentForPaper` reads it when there is no arXiv id to go on.
    primaryTopic: work.primary_topic || null,
  });
}

/**
 * One work fetched from OpenAlex by its arXiv id, as a full paper — abstract
 * included, which the enrichment path deliberately leaves out. This is the
 * public paper page's fallback when arXiv itself refuses to answer: arXiv
 * rate-limits by IP in bursts, while OpenAlex indexes the same preprints.
 */
export async function fetchPaperByArxivIdViaOpenAlex(arxivId, { timeoutMs = 8000 } = {}) {
  const clean = String(arxivId || '').replace(/^arxiv:/i, '').replace(/v\d+$/i, '').trim();
  if (!clean) return null;
  // Same landing-page filter the enrichment batch uses: OpenAlex has no
  // first-class arXiv id field.
  const filter = `locations.landing_page_url:${encodeURIComponent(
    `http://arxiv.org/abs/${clean}|https://arxiv.org/abs/${clean}`,
  )}`;
  try {
    const response = await fetchWithTimeout(`https://api.openalex.org/works?filter=${filter}&per_page=1`, timeoutMs);
    if (!response?.ok) return null;
    const data = await response.json();
    const work = data?.results?.[0];
    return work ? formatOpenAlexWorkAsPaper(work) : null;
  } catch (error) {
    console.warn('OpenAlex arXiv fallback failed', error);
    return null;
  }
}

export async function getTrendingPapers() {
  const cacheKey = 'trending_papers_v2';
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 60) return cached.data; // Cache for 1 hour

  try {
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');
    // Get papers published in the last year, sort by citations
    const filter = `from_publication_date:${year - 1}-${month}-01,has_doi:true,type:article`;
    
    // Slight randomization of page to make it change from time to time
    const page = Math.floor(Math.random() * 3) + 1; 
    const url = `https://api.openalex.org/works?filter=${filter}&sort=cited_by_count:desc&per-page=10&page=${page}`;
    
    const response = await fetchWithTimeout(url, 8000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (!data || !data.results) return [];
    
    const papers = data.results.map(formatOpenAlexWorkAsPaper);
    CACHE.set(cacheKey, { data: papers, timestamp: Date.now() });
    return papers;
  } catch (err) {
    console.error("Failed to fetch trending papers", err);
    return [];
  }
}
