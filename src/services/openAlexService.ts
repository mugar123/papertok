import type { Paper } from '../models/Paper.ts';
import type { OpenAlexWork, OpenAlexPage, OpenAlexAuthor, OpenAlexInstitution, OpenAlexTopic } from './adapters/openAlexTypes.ts';
import type { OpenAlexJsonOptions } from './openAlexClient.ts';
import type { OpenAlexEnrichment } from '../utils/openAlexWork.ts';

type Enrichment = OpenAlexEnrichment;
type Entity = OpenAlexAuthor | OpenAlexInstitution | OpenAlexTopic;
type RequestOptions = { language?: string; signal?: AbortSignal | null; throwOnError?: boolean; timeoutMs?: number; limit?: number; typeahead?: boolean };
type InstitutionProminence = Pick<OpenAlexInstitution, 'ror' | 'works_count' | 'cited_by_count' | 'summary_stats'>;
type InstitutionOptions = RequestOptions & { openAlexJson?: (url: string, options: OpenAlexJsonOptions<OpenAlexPage<InstitutionProminence>>) => Promise<OpenAlexPage<InstitutionProminence>> };
type WorksFilters = { peerReviewed?: boolean; category?: string; dateRange?: string };
type ImpactPeriod = ReturnType<typeof getRecentImpactPeriod>;
export type RecentImpact = Partial<ReturnType<typeof calculateEntityRecentImpact>> & {
  available: boolean; sampleSize: number; minimumSampleSize: number;
  entityType?: string; openAlexId?: string; period: ImpactPeriod; source: string; sampled?: boolean;
  sampleAttempts?: number; cacheStatus?: string; cachedAt?: number; stale?: boolean; rateLimited?: boolean; reason?: string;
};

/**
 * OpenAlex API Service
 * Handles semantic enrichment, concept extraction, and citation graphs.
 */

import { openAlexTypeaheadExpression } from './openAlexSearchQuery.ts';
import { CATEGORIES } from '../data/categories.ts';
import { areaKeyForCategory, openAlexFilterForArea } from '../utils/areaAccent.ts';
import { usableOpenAlexAbstract } from '../utils/openAlexAbstract.ts';
import { OPENALEX_PEER_REVIEWED_FILTER, openAlexIsWorkingPaper, openAlexPeerReviewed, openAlexPublicationStatus } from '../utils/publicationStatus.ts';
import { usableOpenAlexConcepts } from '../utils/openAlexConcepts.ts';
import { matchesAuthorName } from '../utils/authorNameMatch.ts';
import { paperReferenceFor } from '../utils/explorerPaths.ts';
import { normalizePmid } from '../utils/publicNavigation.ts';
import { withRequestDeadline } from '../utils/requestDeadline.ts';
import {
  applyInstitutionWorksFallback,
  calculateEntityRecentImpact,
  getRecentImpactConfig,
  getRecentImpactPeriod,
} from '../utils/entityMetadata.ts';
import { PaperBuilder } from './PaperBuilder.ts';
import { OPENALEX_ENRICHMENT_SELECT, extractArxivId, getArxivIdFromWork, mapOpenAlexEnrichmentWork, normalizeDoi } from '../utils/openAlexWork.ts';
import {
  getRorInstitution,
  mergeInstitutionWithRor,
  normalizeRorId,
  resolveRorInstitution,
  searchRorInstitutions,
} from './rorService.ts';
import {
  getInstitutionAuthorsFromCrossref,
  getInstitutionWorksFromCrossref,
} from './crossrefInstitutionService.ts';
import {
  isOpenAlexRateLimitError,
  openAlexFetch,
  openAlexJson,
  readOpenAlexPersistent,
  writeOpenAlexPersistent,
} from './openAlexClient.ts';
import {
  filterRelevantSearchResults,
  institutionProminenceWeight,
  institutionSearchValues,
  scoreSearchMatch,
  authorSearchValues,
} from '../utils/searchRelevance.ts';

const CACHE = new Map<string, Enrichment>();
const GRAPH_CACHE = new Map<string, string | null>(); // caches W... to arxivId mappings
const RECENT_IMPACT_CACHE = new Map<string, { data: RecentImpact; savedAt: number }>();
const ENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENTITY_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMPACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const IMPACT_INSUFFICIENT_TTL_MS = 60 * 60 * 1000;
const IMPACT_STALE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ENRICHMENT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ENTITY_WORKS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// OpenAlex ORs *values* of one filter, not filters. `openalex:W1|openalex:W2`
// is refused with «It looks like you're trying to do an OR query between filters
// and it's not supported», so the key goes once and the ids are joined. This
// used to be written out by hand at each call site, and the two copies drifted:
// one of them had always been returning 400.
export function buildOpenAlexIdFilter(ids: unknown) {
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
export async function fetchWithTimeout(url: string | URL, timeoutMs = 8000) {
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

async function enrichInstitutionWithRor(institution: OpenAlexInstitution | null, prefetchedRor: OpenAlexInstitution | null = null) {
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
export function isOpenAlexEnrichmentId(id: unknown): boolean {
  const raw = String(id || '').trim();
  // A DOI is taken whole: stripping a trailing `v<n>` the way an arXiv id needs
  // would corrupt one that legitimately ends that way.
  if (/^doi:10\.\d{4,9}\/\S+$/i.test(raw)) return true;
  const value = raw.replace(/v\d+$/, '');
  return /^\d{4}\.\d{4,5}$/.test(value)
    || /^[a-z][a-z.-]+\/\d{7}$/i.test(value)
    || /^(?:openalex:|https:\/\/openalex\.org\/)?W\d+$/i.test(value);
}

export async function enrichPapersBatch(arxivIds: string[], options: RequestOptions = {}) {
  const validIds = [...new Set((Array.isArray(arxivIds) ? arxivIds : [])
    .filter(id => typeof id === 'string' && id.trim() !== '')
    .map(id => {
      if (/^doi:/i.test(id)) return `doi:${id.slice(4).toLowerCase()}`;
      const pure = id.startsWith('arxiv:') ? id.split(':')[1] : id;
      return pure.replace(/v\d+$/, '');
    })
    .filter(isOpenAlexEnrichmentId))];
    
  const result: Record<string, Enrichment> = {};
  
  // Reuse semantic/citation signals across sessions so a temporary outage does
  // not erase recommendation quality for papers the user has already encountered.
  validIds.forEach(id => {
    if (!CACHE.has(id)) {
      const persisted = readOpenAlexPersistent<Enrichment>(`enrichment:${id}`, ENRICHMENT_CACHE_TTL_MS);
      if (persisted && !persisted.stale) CACHE.set(id, persisted.data);
    }
    if (CACHE.has(id)) result[id] = CACHE.get(id)!;
  });

  const toFetch = validIds.filter(id => !CACHE.has(id));
  
  if (toFetch.length === 0) return result;

  // Separate OpenAlex IDs and ArXiv IDs
  const openAlexIds: string[] = [];
  const arxivIdsOnly: string[] = [];
  const doisOnly: string[] = [];
  
  toFetch.forEach(id => {
    if (/^doi:/i.test(id)) {
      doisOnly.push(id.slice(4));
    } else if (id.startsWith('openalex:') || id.startsWith('https://openalex.org/') || /^W\d+$/.test(id)) {
      openAlexIds.push(id.replace('openalex:', '').replace('https://openalex.org/', ''));
    } else {
      arxivIdsOnly.push(id);
    }
  });

  const fetchChunk = async (filterParam: string) => {
    const url = `https://api.openalex.org/works?filter=${filterParam}&per_page=50&select=${OPENALEX_ENRICHMENT_SELECT}`;
    let response = null;
    let primaryFailed = false;
    let directError: unknown = null;
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
        const data = await response.json() as OpenAlexPage<OpenAlexWork>;
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
             // OpenAlex answers with the DOI lowercased and prefixed; the feed
             // looks the paper up by the same id it asked with, so both sides
             // are normalized the same way.
             const workDoi = String(work.doi || work.ids?.doi || '')
               .trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
             if (workDoi) {
               CACHE.set(`doi:${workDoi}`, enrichment);
               writeOpenAlexPersistent(`enrichment:doi:${workDoi}`, enrichment);
               result[`doi:${workDoi}`] = enrichment;
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

  for (let i = 0; i < doisOnly.length; i += CHUNK_SIZE) {
    const chunk = doisOnly.slice(i, i + CHUNK_SIZE);
    chunkRequests.push(fetchChunk(`doi:${encodeURIComponent(chunk.join('|'))}`));
  }

  await Promise.all(chunkRequests);

  return result;
}

/**
 * Given a list of OpenAlex Work URLs (https://openalex.org/W...), fetch their metadata to get their arXiv IDs.
 * This is used for Capa 2 (Graph exploration).
 */
export async function getArxivIdsForOpenAlexWorks(openAlexUrls: string[]) {
  if (!openAlexUrls || openAlexUrls.length === 0) return [];
  const validUrls = openAlexUrls.filter(url => url && typeof url === 'string' && url.includes('/'));
  
  const result: string[] = [];
  const toFetch: string[] = [];
  
  validUrls.forEach(url => {
    const wId = url.split('/').pop()!;
    if (GRAPH_CACHE.has(wId)) {
      const cached = GRAPH_CACHE.get(wId);
      if (cached) result.push(cached);
    } else {
      toFetch.push(wId);
    }
  });
  
  if (toFetch.length === 0) return result;
  
  // The first forty, in the order OpenAlex listed them. A random forty gave
  // every reader of one paper a different URL, so the related works of a paper
  // many had liked were fetched once per reader instead of once (PAP-86).
  const candidates = toFetch.slice(0, 40);
  
  const url = `https://api.openalex.org/works?filter=${buildOpenAlexIdFilter(candidates)}&per-page=50&select=id,ids`;
  
  try {
     const response = await fetchWithTimeout(url, 10000);
     if (response.ok) {
        const data = await response.json() as OpenAlexPage<OpenAlexWork>;
        data.results!.forEach(work => {
           const wId = work.id!.split('/').pop()!;
           let arxivId = null;
           if (work.ids && work.ids.arxiv) {
              arxivId = work.ids.arxiv.split('/').pop()!.replace(/v\d+$/, '');
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

/**
 * Fetch author profile from OpenAlex by name.
 * @param {string} authorName 
 * @returns {Promise<Object|null>}
 */
export async function getAuthorProfile(authorName: string): Promise<OpenAlexAuthor | null> {
  if (!authorName) return null;
  const cleanName = encodeURIComponent(authorName.trim());
  const url = `https://api.openalex.org/authors?search=${cleanName}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    
    const data = await response.json() as OpenAlexPage<OpenAlexAuthor>;
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

export async function getAuthorProfileByOrcid(orcidId: string) {
  const cleanOrcid = orcidId?.match(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/i)?.[0]?.toUpperCase();
  if (!cleanOrcid) return null;

  const url = `https://api.openalex.org/authors?filter=orcid:${encodeURIComponent(cleanOrcid)}&per-page=1`;
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    const data = await response.json() as OpenAlexPage<OpenAlexAuthor>;
    return data.results?.[0] || null;
  } catch (err) {
    console.error(`OpenAlex ORCID lookup failed for ${cleanOrcid}`, err);
    return null;
  }
}

// The OpenAlex work a paper reference names: the DOI or PMID as OpenAlex
// indexes them, an arXiv id through its DataCite DOI. A PubMed paper's
// `pmid:` id used to be glued onto the arXiv prefix
// (`works/doi:10.48550/arxiv.pmid:42774036`), which can only 404.
function workUrlForReference(reference: ReturnType<typeof paperReferenceFor>) {
  if (!reference) return '';
  if (reference.type === 'doi') return `https://api.openalex.org/works/doi:${reference.value}`;
  if (reference.type === 'pmid') return `https://api.openalex.org/works/pmid:${reference.value}`;
  return `https://api.openalex.org/works/doi:10.48550/arxiv.${reference.value.replace(/v\d+$/, '')}`;
}

/**
 * The author a name names on a given paper, found through that paper's own
 * authorships on OpenAlex. `paperRef` is a paper reference
 * (`doi:…`, `pmid:…`, `arxiv:…`, or a bare arXiv id for older links).
 *
 * A profile the paper confirms comes back `verified: true`; one found only by
 * the name (or the stub when nothing matched) does not, because a name is
 * shared: "Wei Zhang" is 11,284 OpenAlex entities (audit 2026-09-23).
 * @param {string} authorName
 * @param {string} paperRef
 * @returns {Promise<Object|null>}
 */
export async function getAuthorProfileExact(authorName: string, paperRef: string | null): Promise<OpenAlexAuthor | null> {
  if (!authorName) return null;

  const reference = paperReferenceFor(paperRef);
  // Without a paper, the name search is all there is.
  if (!reference) return getAuthorProfile(authorName);

  // The name search starts NOW rather than third in line. For a paper OpenAlex
  // has not indexed -- 51 of 56 slow author links on a feed page measured
  // 2026-09-07 -- the work lookup below can only 404, and running the search
  // behind it turned one round trip into three. The authorship match still
  // wins whenever the paper can supply one: "A. M. Gavrilik" is three
  // different entities in OpenAlex, and only the paper says which.
  const byName = getAuthorProfile(authorName).catch(() => null);

  try {
    // There used to be a standby `works?filter=doi:` here for when OpenAlex
    // "drops pseudo-DOIs". Measured over 8 indexed papers it rescued none, and
    // in 2 it was strictly worse -- the direct lookup found the work and the
    // filter returned nothing -- so it was pure latency in front of the search
    // that could actually answer.
    const workUrl = workUrlForReference(reference);
    const workResponse = await fetchWithTimeout(workUrl, 8000).catch(() => null);

    if (workResponse && workResponse.ok) {
      const workData = await workResponse.json() as OpenAlexWork;

      if (workData.authorships) {
        // The authorship the requested name is: by OpenAlex's spelling of the
        // author, or by the byline as the paper printed it (`raw_author_name`,
        // which for a PubMed record is the same "Li WN" the card shows).
        // Only one may match: a short byline can fit two authors of the same
        // paper ("Zhang W" is both Wei and Wen Zhang), and then the paper does
        // not say which one was clicked (review of 2026-09-25).
        const matching = workData.authorships.filter((authorship) => {
          const authorDisplayName = authorship.author?.display_name;
          if (!authorDisplayName) return false;
          return matchesAuthorName(authorName, authorDisplayName)
            || Boolean(authorship.raw_author_name && matchesAuthorName(authorName, authorship.raw_author_name));
        });
        const bestMatch = matching.length === 1 ? matching[0].author : null;

        // With the exact author ID, fetch their profile for H-index etc.
        // An authorship names its author as `https://openalex.org/A…`, the
        // website, not the API: fetched as given it went around the relay to a
        // page that is not JSON, and every "exact" match fell through to the
        // name search. The API address of the same author is built instead.
        const authorKey = String(bestMatch?.id || '').match(/A\d+$/i)?.[0]?.toUpperCase();
        if (bestMatch && authorKey) {
           const profileResponse = await fetchWithTimeout(`https://api.openalex.org/authors/${authorKey}`, 10000);
           if (profileResponse.ok) {
              const author = await profileResponse.json() as OpenAlexAuthor;
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
                concepts: author.x_concepts ? author.x_concepts.slice(0, 5) : [],
                verified: true,
              };
           }
        }
        // The work named them but OpenAlex never linked an id to that
        // authorship. The search already in flight — from the name the reader
        // clicked, the card's spelling — is tried first because it is already
        // out; if it misses, the work's own spelling of the name is the better
        // query (78cb22d deleted this second search; the 2026-09-09 review put
        // it back: "N. Cuello" misses where "Nicolás Cuello" does not).
        if (bestMatch && bestMatch.display_name) {
          const fromCard = await byName;
          if (fromCard) return fromCard;
          const fromWork = await getAuthorProfile(bestMatch.display_name).catch(() => null);
          if (fromWork) return fromWork;
        }
      }
    }
  } catch {
    // Whatever the work lookup did, the search below is what answers.
  }

  const fallbackProfile = await byName;
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
export function dedupeAuthors<T extends OpenAlexAuthor>(authors: T[]): T[] {
  const normalize = (value: string | null | undefined) => (value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Higher score = the more prominent / canonical profile. Research output is the
  // primary signal; identity fields (ORCID, institution) are back-filled below.
  const score = (author: T) => (author.works_count || 0) * 1e6
    + (author.cited_by_count || 0);

  const conflicts = (a: T, b: T) => (
    (a.orcid && b.orcid && a.orcid !== b.orcid)
    || (a.institution && b.institution && normalize(a.institution) !== normalize(b.institution))
  );

  // Same name can hold several genuinely distinct people, so each name maps to a
  // LIST of identity clusters instead of a single winner.
  const clustersByName = new Map<string, Array<{ author: T }>>();
  const ordered: Array<{ author: T }> = [];
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

const AUTHOR_INSTITUTION_LOOKUPS = new Map<string, Promise<OpenAlexInstitution | null>>();

function settleAuthorInstitutionLookup<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  return new Promise<T | null>(resolve => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null | undefined = null;
    const finish = (value: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId!);
      resolve(value);
    };
    timeoutId = setTimeout(() => finish(null), timeoutMs);

    promise.then(finish).catch(() => finish(null));
  });
}

/**
 * Attach ROR's localized labels to an author institution without changing its
 * OpenAlex identity or canonical display name.
 */
export async function enrichAuthorInstitutionLocalization<T extends OpenAlexAuthor | null | undefined>(author: T, { timeoutMs = 1800 } = {}) {
  if (!author) return author;

  const sourceInstitution = author.institutionData
    || author.last_known_institutions?.[0]
    || (author.institution ? { display_name: author.institution } : null);
  if (!sourceInstitution) return author;

  const existingNames = sourceInstitution.localized_names || sourceInstitution.localizedNames || {};
  if (existingNames.en) {
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

/** Author-name search does not support fuzzy operators; work bylines do. */
async function searchAuthorSuggestions(query: string, options: RequestOptions): Promise<OpenAlexAuthor[]> {
  const expression = openAlexTypeaheadExpression(query) || JSON.stringify(query);
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', `raw_author_name.search:${expression}`);
  url.searchParams.set('per-page', '25');
  url.searchParams.set('select', 'id,authorships');
  // A short exact surname can otherwise fill the page with fuzzy first names
  // before a well-established surname completion reaches the client.
  url.searchParams.set('sort', 'cited_by_count:desc');
  try {
    const data = await openAlexJson<OpenAlexPage<OpenAlexWork>>(url.toString(), {
      timeoutMs: 5000, retries: 0, cacheTtlMs: 10 * 60 * 1000, signal: options.signal,
    });
    const authors = new Map<string, OpenAlexAuthor>();
    for (const work of data.results || []) {
      for (const authorship of work.authorships || []) {
        const author = authorship.author;
        if (!author?.id || !author.display_name || authors.has(author.id)) continue;
        const institution = authorship.institutions?.[0];
        authors.set(author.id, {
          id: author.id, display_name: author.display_name,
          institution: institution?.display_name || null,
          institutionData: institution,
          works_count: null, cited_by_count: null,
        });
      }
    }
    return filterRelevantSearchResults(query, [...authors.values()], authorSearchValues, { minimumScore: 80 }).slice(0, 10);
  } catch (error) {
    if (options.throwOnError) throw error;
    return [];
  }
}

export async function searchAuthors(query: string, options: RequestOptions = {}) {
  if (!query) return [];
  const normalizedQuery = query.trim();
  if (options.typeahead) return searchAuthorSuggestions(normalizedQuery, options);
  const url = `https://api.openalex.org/authors?search=${encodeURIComponent(normalizedQuery)}&per-page=10`;
  try {
    const data = await openAlexJson<OpenAlexPage<OpenAlexAuthor>>(url, {
      timeoutMs: 7000,
      // A search the relay reserves ten list calls for, on every miss: asked
      // again after a 5xx it would reserve them again, for the same outage.
      retries: 0,
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
// for the same reason. The search page gives the institutions section 4 500 ms and
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
export function buildRorIdFilter(rorIds: unknown) {
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
export async function fetchInstitutionProminence(rorIds: unknown, options: InstitutionOptions = {}) {
  const filter = buildRorIdFilter(rorIds);
  if (!filter) return new Map<string, InstitutionProminence>();

  // Injectable for the test, the way `OpenAlexClient` already takes `fetchImpl`
  // and `storage`. The shared client binds `globalThis.fetch` when the module
  // loads — deliberately, so Safari keeps the native receiver — so swapping the
  // global does NOT reach it, and a test that tried would quietly hit the live
  // API and pass on whatever OpenAlex happened to say that day.
  const requestJson: NonNullable<InstitutionOptions['openAlexJson']> = options.openAlexJson || openAlexJson;
  const url = `https://api.openalex.org/institutions?filter=${filter}`
    + `&per-page=${INSTITUTION_SEARCH_CANDIDATES}`
    + '&select=ror,works_count,cited_by_count,summary_stats';
  const data = await requestJson(url, {
    timeoutMs: INSTITUTION_PROMINENCE_TIMEOUT_MS,
    retries: 0,
    cacheTtlMs: 10 * 60 * 1000,
    signal: options.signal,
  });

  const prominenceByRorId = new Map<string, InstitutionProminence>();
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
export function applyInstitutionProminence(institutions: OpenAlexInstitution[], prominenceByRorId: Map<string, InstitutionProminence> | null) {
  if (!prominenceByRorId?.size) return institutions;
  return institutions.map((institution) => {
    const prominence = prominenceByRorId.get(institution._rorId!);
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
async function rankInstitutionsByProminence(query: string, candidates: OpenAlexInstitution[], options: InstitutionOptions = {}) {
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
export async function searchInstitutions(query: string, options: InstitutionOptions = {}) {
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

function scoreTopicMatch(query: string, values: Array<string | undefined>) {
  const normalizedQuery = normalizeTopicSearchValue(query);
  if (!normalizedQuery) return -1;

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  let bestScore = -1;
  values.forEach((value: string|undefined, index: number) => {
    const normalizedValue = normalizeTopicSearchValue(value);
    if (!normalizedValue) return;
    const sourceWeight = Math.max(0, 4 - index);
    const approximate = scoreSearchMatch(normalizedQuery, [normalizedValue]);
    if (approximate >= 82) bestScore = Math.max(bestScore, approximate + sourceWeight);
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

export function searchLocalTopics(query: string, limit = 8) {
  if (!query?.trim()) return [];
  const matches: Array<OpenAlexTopic & { _searchScore?: number }> = [];

  Object.entries(CATEGORIES).forEach(([id, category]) => {
    const categoryScore = scoreTopicMatch(query, [
      category.label,
      id,
      category.description,
    ]);
    if (categoryScore >= 0) {
      matches.push({
        id,
        display_name: category.label,
        label: category.label,
        description: category.description,
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
        subcategoryId,
        category.label,
      ]);
      if (subcategoryScore < 0) return;
      matches.push({
        id: subcategoryId,
        display_name: subcategory.label,
        label: subcategory.label,
        parent_display_name: category.label,
        level: 1,
        categoryIds: [subcategoryId],
        works_count: null,
        _localTopic: true,
        _searchScore: subcategoryScore,
      });
    });
  });

  return matches
    .sort((a, b) => b._searchScore! - a._searchScore! || a.display_name.localeCompare(b.display_name))
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
export async function searchConcepts(query: string, options: RequestOptions = {}) {
  if (!query?.trim()) return [];
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 8));
  const normalizedQuery = query.trim();
  const localTopics = searchLocalTopics(normalizedQuery, limit);

  try {
    // Keep the existing free autocomplete endpoint. The existing taxonomy can
    // correct a known topic before the one request, without a second search.
    const url = new URL('https://api.openalex.org/autocomplete/topics');
    url.searchParams.set('q', localTopics[0]?.display_name || normalizedQuery);
    const data = await openAlexJson<OpenAlexPage<OpenAlexTopic> & { topics?: OpenAlexTopic[] }>(url.toString(), {
      timeoutMs: 3500,
      retries: 0,
      cacheTtlMs: 30 * 60 * 1000,
      persistentKey: `topic-autocomplete:${url.searchParams.get('q')!.toLowerCase()}`,
      persistentTtlMs: 7 * 24 * 60 * 60 * 1000,
      staleIfError: true,
      signal: options.signal,
    });

    const seen = new Set(localTopics.flatMap(topic => [
      normalizeTopicSearchValue(topic.display_name),
      normalizeTopicSearchValue(topic.label),
    ]).filter(Boolean));
    const remoteTopics = (data?.topics || data?.results || []).flatMap(topic => {
      const id = String(topic?.id || '').split('/').pop()!;
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

    return [...localTopics, ...filterRelevantSearchResults(normalizedQuery, remoteTopics, topic => [topic.display_name])].slice(0, limit);
  } catch (error) {
    if (options.throwOnError && localTopics.length === 0) throw error;
    return localTopics;
  }
}

export function getLocalTopicEntity(id: string) {
  const area = CATEGORIES[id as keyof typeof CATEGORIES];
  if (area) {
    return {
      id,
      display_name: area.label,
      label: area.label,
      description: area.description,
      level: 0,
      categoryIds: Object.keys(area.subcategories || {}),
      _localTopic: true,
    };
  }
  for (const areaValue of Object.values(CATEGORIES)) {
    const subcategory = (areaValue.subcategories as Record<string, { label: string }>)?.[id];
    if (subcategory) {
      return {
        id,
        display_name: subcategory.label,
        label: subcategory.label,
        level: 1,
        categoryIds: [id],
        _localTopic: true,
      };
    }
  }
  return null;
}

/**
 * Look up an OpenAlex institution by its ROR identifier or name.
 * Returns { id, display_name } or null if not found.
 */
export async function findInstitution({ rorUrl, name, aliases = [] }: { rorUrl?: string | null; name?: string; aliases?: string[] }) {
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
        const data = await res.json() as OpenAlexPage<OpenAlexInstitution>;
        const inst = data.results?.[0];
        if (inst) {
          return {
            id: inst.id.split('/').pop()!,
            display_name: inst.display_name
          };
        }
      }
    } catch { /* ROR lookup failed, try name search */ }
  }

  const candidateNames = [...new Set([name, ...aliases].map(value => value?.trim()).filter(Boolean))];
  for (const candidateName of candidateNames) {
    const url = `https://api.openalex.org/institutions?search=${encodeURIComponent(candidateName!)}&select=id,display_name&per-page=1`;
    try {
      const res = await fetchWithTimeout(url, 4000);
      if (res.ok) {
        const data = await res.json() as OpenAlexPage<OpenAlexInstitution>;
        const inst = data.results?.[0];
        if (inst) {
          return {
            id: inst.id.split('/').pop()!,
            display_name: inst.display_name
          };
        }
      }
    } catch { /* Name lookup failed, try the next alias */ }
  }

  return null;
}

/**
 * The entity the persistent cache already holds for this route, or null —
 * synchronously, for a page deciding what it is born with.
 *
 * `getEntityById` reads the same entry first, but it is async, and a page
 * that awaits it has painted a skeleton by the time it answers. Measured
 * 2026-09-09 on a warm institution: the skeleton stood for 30 ms — two frames
 * — before the hero replaced it, a flash that reads as a glitch rather than
 * as a wait. A page born from this peek paints its data on its first frame,
 * the way one handed over from the search palette does; the load effect still
 * runs and upgrades the record (an institution gains its ROR localisation
 * there), so nothing is lost by not waiting.
 *
 * Authors and institutions only: topics are born from CATEGORIES already, and
 * a project's record is OpenAIRE's, not this cache's. Only a FRESH entry
 * qualifies — a stale one is `getEntityById`'s business, which revalidates.
 */
export function peekEntity(type: string|undefined, id: string|undefined) {
  if (!id || (type !== 'author' && type !== 'institution')) return null;
  const cleanId = String(id).includes('/') ? String(id).split('/').pop()! : String(id);
  const cached = readOpenAlexPersistent<Entity>(`entity:${type}:${cleanId}`, ENTITY_CACHE_TTL_MS);
  return cached && !cached.stale && cached.data ? cached.data : null;
}

/**
 * Fetch entity metadata by ID
 */
export async function getEntityById(type: string | undefined, id: string | undefined): Promise<Entity | null> {
  if (!id) return null;
  if (type === 'concept' || type === 'topic') {
    const localTopic = getLocalTopicEntity(id);
    if (localTopic) return localTopic;
  }
  const cleanId = id.includes('/') ? id.split('/').pop()! : id;
  const persistentCacheKey = `entity:${type}:${cleanId}`;
  const cachedEntity = readOpenAlexPersistent<Entity>(persistentCacheKey, ENTITY_CACHE_TTL_MS);
  if (cachedEntity && !cachedEntity.stale) {
    return type === 'institution'
      ? enrichInstitutionWithRor(cachedEntity.data as OpenAlexInstitution)
      : cachedEntity.data;
  }

  const persistEntity = (data: Entity | null) => {
    if (data) writeOpenAlexPersistent(persistentCacheKey, data);
    return data;
  };
  const readStaleEntity = () => {
    const stale = readOpenAlexPersistent<Entity>(persistentCacheKey, ENTITY_STALE_TTL_MS);
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
      const data = await response.json() as OpenAlexPage<OpenAlexInstitution>;
      if (data.results && data.results.length > 0) {
        const institution = data.results[0];
        if (institution.works_count! > 0) {
          return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
        }

        const worksUrl = `https://api.openalex.org/works?filter=institutions.ror:${encodeURIComponent(rorUrl)}&per-page=1&select=id`;
        try {
          const worksResponse = await fetchWithTimeout(worksUrl, 10000);
          if (!worksResponse.ok) return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
          const worksData = await worksResponse.json() as OpenAlexPage<OpenAlexWork>;
          const withWorks = applyInstitutionWorksFallback(institution, worksData.meta?.count);
          return persistEntity(await enrichInstitutionWithRor(withWorks, await rorPromise));
        } catch {
          return persistEntity(await enrichInstitutionWithRor(institution, await rorPromise));
        }
      }
      return persistEntity(await rorPromise);
    } catch (err) {
      const staleEntity = readStaleEntity();
      if (staleEntity) return enrichInstitutionWithRor(staleEntity as OpenAlexInstitution, await rorPromise);
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
    let data = await response.json() as Entity;

    if (type === 'institution' && data?.works_count === 0) {
      const filterKey = (data as OpenAlexInstitution).ror ? 'institutions.ror' : 'institutions.id';
      const filterValue = (data as OpenAlexInstitution).ror || cleanId;
      const worksUrl = `https://api.openalex.org/works?filter=${filterKey}:${encodeURIComponent(filterValue)}&per-page=1&select=id`;
      try {
        const worksResponse = await fetchWithTimeout(worksUrl, 10000);
        if (worksResponse.ok) {
          const worksData = await worksResponse.json() as OpenAlexPage<OpenAlexWork>;
          data = applyInstitutionWorksFallback(data, worksData.meta?.count);
        }
      } catch {
        // Preserve the institution profile even when the metrics fallback is unavailable.
      }
    }

    if (type === 'institution') {
      data = (await enrichInstitutionWithRor(data as OpenAlexInstitution))!;
    }
    
    // If it's a concept, translate back to Spanish
    if ((type === 'concept' || type === 'topic') && data && data.display_name) {
      let translatedName = data.display_name;
      Object.values(CATEGORIES).forEach(cat => {
        if (cat.label.toLowerCase() === data.display_name.toLowerCase()) translatedName = cat.label;
        if (cat.subcategories) {
          Object.values(cat.subcategories).forEach(sub => {
            if (sub.label.toLowerCase() === data.display_name.toLowerCase()) translatedName = sub.label;
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
        ? enrichInstitutionWithRor(staleEntity as OpenAlexInstitution)
        : staleEntity;
    }
    console.error(`OpenAlex getEntityById failed for ${type} ${id}`, err);
    throw err;
  }
}

export function normalizeRecentImpactEntityId(type: string, value: string | Partial<Entity> | null | undefined) {
  const prefix = type === 'institution' ? 'I' : type === 'author' ? 'A' : '';
  if (!prefix) return '';
  const rawId = typeof value === 'object' ? value?.id : value;
  const match = String(rawId || '').match(new RegExp(`(?:openalex\\.org/)?(${prefix}\\d+)`, 'i'));
  return match?.[1]?.toUpperCase() || '';
}

async function resolveRecentImpactEntityId(type: string, entityOrId: string | (Partial<OpenAlexInstitution> & { orcid?: string | null })) {
  const directId = normalizeRecentImpactEntityId(type, entityOrId);
  if (directId) return directId;

  if (type === 'institution') {
    const rawRor = typeof entityOrId === 'object'
      ? entityOrId?.ror || entityOrId?._rorId || entityOrId?.id
      : entityOrId;
    const rorId = normalizeRorId(rawRor);
    if (!rorId) return '';
    const data = await openAlexJson<OpenAlexPage<Entity>>(
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
  const data = await openAlexJson<OpenAlexPage<Entity>>(
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

export function buildRecentImpactUrl(type: string, openAlexId: string, period: Pick<ImpactPeriod, 'from' | 'to'>, attempt = 0) {
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

export async function fetchRecentImpactWorks(type: string, openAlexId: string, period: Pick<ImpactPeriod, 'from' | 'to'>, fetchJson: (url: string, options: OpenAlexJsonOptions<OpenAlexPage<OpenAlexWork>>) => Promise<OpenAlexPage<OpenAlexWork>> = openAlexJson) {
  const config = getRecentImpactConfig(type);
  if (!config) return { works: [], attempts: 0 };
  const uniqueWorks = new Map<string, OpenAlexWork>();
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

function recentImpactCacheTtl(impact: RecentImpact | null | undefined) {
  return impact?.available ? IMPACT_CACHE_TTL_MS : IMPACT_INSUFFICIENT_TTL_MS;
}

export async function getEntityRecentImpact(type: string, entityOrId: string | (Partial<OpenAlexInstitution> & { orcid?: string | null }), now = new Date()): Promise<RecentImpact | null> {
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
  const cachedImpact = readOpenAlexPersistent<RecentImpact>(persistentCacheKey, Number.POSITIVE_INFINITY);
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

// What the entity screen waits before it paints without the list
// (`ENTITY_PRIMARY_RENDER_BUDGET_MS`, EntityExplorer.jsx). Every deadline below
// is carved out of it.
const ENTITY_SCREEN_BUDGET_MS = 7000;

/**
 * Fetch works for a specific entity
 * type: 'institution', 'concept', 'author'
 * sortBy: 'cited_by_count:desc' or 'publication_date:desc'
 * filters: { category: string, peerReviewed: boolean, dateRange: string }
 */
export async function getWorksByEntity(type: string|undefined, id: string|undefined, sortBy = 'cited_by_count:desc', page = 1, searchQuery = '', filters: WorksFilters = {}, entityName = '') {
  if (!id) return { papers: [], total: 0 };

  // The screen cuts its own wait at 7000 ms (`ENTITY_PRIMARY_RENDER_BUDGET_MS`
  // in EntityExplorer.jsx), and OpenAlex used to be allowed all seven of them —
  // so on an institution the Crossref fallback started AFTER the page had
  // already given up, and the reader got the empty state on every institution
  // OpenAlex was slow about. 3500 + 3250 leaves 250 ms of margin for the
  // client's own queue.
  const startedAt = Date.now();
  const primaryTimeoutMs = type === 'institution' ? 3500 : ENTITY_SCREEN_BUDGET_MS;
  
  const cleanId = id.includes('/') ? id.split('/').pop()! : id;
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
  
  // Advanced Filters. The Explorer still drops what `openAlexPeerReviewed`
  // does not call reviewed. Asking OpenAlex to leave out what it can name
  // keeps a page of working papers from arriving only to be emptied.
  if (filters.peerReviewed) {
    filterParams += `,primary_location.is_published:true,${OPENALEX_PEER_REVIEWED_FILTER}`;
  }
  if (filters.category) {
    const areaFilter = openAlexFilterForArea(areaKeyForCategory(filters.category));
    if (areaFilter) filterParams += `,${areaFilter}`;
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
  // The page is persisted as the papers it became, not as the raw response
  // (openAlexClient.js says why), under the query it was asked with. Keyed by
  // the reader's filters (`v3`), a "Peer-reviewed only" page fetched before
  // the query named the working-paper series would answer the narrower query,
  // whose page numbers count other works. `v2` papers were built before
  // `openAlexPeerReviewed` and carry `peerReviewed: true` for working papers,
  // reports and works with no venue. Both kinds of page age out.
  const worksCacheKey = `entity-works-v4:${url.slice(url.indexOf('?') + 1)}`;
  
  try {
    const data = await openAlexJson<ReturnType<typeof slimWorksPage>, OpenAlexPage<OpenAlexWork>>(url, {
      timeoutMs: primaryTimeoutMs,
      retries: 0,
      cacheTtlMs: 5 * 60 * 1000,
      persistentKey: worksCacheKey,
      persistentTtlMs: ENTITY_WORKS_CACHE_TTL_MS,
      staleIfError: true,
      persistentSlim: slimWorksPage,
    });
    if (data && data.papers) {
       return { papers: data.papers, total: data.total || 0 };
    }
  } catch (err) {
    console.error(`OpenAlex getWorksByEntity failed for ${type} ${id}`, err);
    if (type === 'institution') {
      try {
        // Whatever is left of the screen's budget, never less than the 1500 ms
        // below which asking is pointless.
        const remainingMs = Math.max(1500, ENTITY_SCREEN_BUDGET_MS - (Date.now() - startedAt) - 250);
        return await getInstitutionWorksFromCrossref(
          entityName,
          page,
          searchQuery,
          filters,
          crossrefUrl => fetchWithTimeout(crossrefUrl, remainingMs),
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
export async function getAuthorsByEntity(type: string|undefined, id: string, page = 1, searchQuery = '', entityName = '') {
  if (!id || type === 'author') return { authors: [], total: 0 };
  
  const cleanId = id.includes('/') ? id.split('/').pop()! : id;
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
  const authorsCacheKey = `entity-authors-v2:${type}:${cleanId}:${page}:${searchQuery.trim().toLowerCase()}`;
  
  try {
    const data = await openAlexJson<ReturnType<typeof slimAuthorsPage>, OpenAlexPage<OpenAlexAuthor>>(url, {
      timeoutMs: 7000,
      retries: 0,
      cacheTtlMs: 5 * 60 * 1000,
      persistentKey: authorsCacheKey,
      persistentTtlMs: ENTITY_WORKS_CACHE_TTL_MS,
      staleIfError: true,
      persistentSlim: slimAuthorsPage,
    });
    if (data && data.authors) {
       return { authors: data.authors, total: data.total || 0 };
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
export async function fetchPapersByDois(dois: string[], options: { throwOnProviderError?: boolean } = {}) {
  if (!dois || dois.length === 0) return [];
  
  const cleanDois = dois.map(doi => {
    if (doi.includes('doi.org/')) return doi.split('doi.org/')[1];
    return doi;
  }).filter(Boolean);
  
  if (cleanDois.length === 0) return [];
  
  const results: OpenAlexWork[] = [];
  const chunkSize = 40;
  for (let i = 0; i < cleanDois.length; i += chunkSize) {
    const chunk = cleanDois.slice(i, i + chunkSize);
    // OpenAlex OR syntax requires the property name once: filter=doi:A|B|C
    const filterIds = chunk.join('|');
    const url = `https://api.openalex.org/works?filter=doi:${filterIds}&per-page=50`;
    
    try {
      const response = await fetchWithTimeout(url, 10000);
      if (response.ok) {
        const data = await response.json() as OpenAlexPage<OpenAlexWork>;
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

/**
 * A works page as the Explorer keeps it: the papers, not the works. A raw
 * page of thirty works ran to over a million characters (inverted-index
 * abstracts, authorships, locations); the papers made from it are a tenth of
 * that, and are all the page ever reads.
 */
export function slimWorksPage(data: OpenAlexPage<OpenAlexWork> | null) {
  const papers = Array.isArray(data?.results) ? data.results.map(formatOpenAlexWorkAsPaper).filter(Boolean) : [];
  return { papers, total: data?.meta?.count || 0 };
}

/** An authors page as the Explorer keeps it: the seven fields its cards show. */
export function slimAuthorsPage(data: OpenAlexPage<OpenAlexAuthor>) {
  const authors = Array.isArray(data?.results) ? data.results.map(author => ({
    id: author.id,
    display_name: author.display_name,
    works_count: author.works_count || 0,
    cited_by_count: author.cited_by_count || 0,
    h_index: author.summary_stats ? author.summary_stats.h_index : 0,
    institution: (author.last_known_institutions && author.last_known_institutions.length > 0)
      ? author.last_known_institutions[0].display_name
      : null,
    concepts: author.x_concepts ? author.x_concepts.slice(0, 3) : [],
  })) : [];
  return { authors, total: data?.meta?.count || 0 };
}

function formatOpenAlexWorkAsPaper(work: OpenAlexWork): Paper {
  // OpenAlex dates a work as a calendar day. The year is read from that text:
  // as a Date it is midnight UTC, still the previous year west of Greenwich on
  // 1 January, which is where OpenAlex files a work known only by its year.
  const date = work.publication_date || '';
  const published = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';

  const authors = work.authorships?.map(a => ({ name: a.author?.display_name || 'Unknown Author', id: a.author?.id })) || [{ name: 'Unknown Author' }];
  const institutions = [...new Map((work.authorships || [])
    .flatMap(authorship => authorship.institutions || [])
    .filter(Boolean)
    .map(institution => [institution.id || institution.ror || institution.display_name, {
      id: institution.id,
      ror: institution.ror,
      displayName: institution.display_name,
    }])).values()];
  const categories = usableOpenAlexConcepts(work.concepts).map(c => c.display_name);
  const openAlexId = work.id!.split('/').pop()!;
  
  return PaperBuilder.create({
    id: openAlexId,
    sources: { primary: 'openalex', enrichedBy: [] },
    title: work.title || 'No Title',
    abstract: usableOpenAlexAbstract(work),
    authors,
    institutions,
    year: Number(published.slice(0, 4)) || undefined,
    published,
    publicationType: work.type || work.primary_location?.source?.type || 'journal',
    publicationStatus: openAlexPublicationStatus(work),
    peerReviewed: openAlexPeerReviewed(work),
    workingPaper: openAlexIsWorkingPaper(work) || undefined,
    openAccess: work.open_access?.is_oa,
    pdfUrl: work.open_access?.oa_url,
    landingPageUrl: work.primary_location?.landing_page_url || work.id,
    doi: work.doi,
    arxivId: getArxivIdFromWork(work) || undefined,
    pmid: normalizePmid(work.ids?.pmid) || undefined,
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
export async function fetchPaperByArxivIdViaOpenAlex(arxivId: unknown, { timeoutMs = 8000 } = {}) {
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
    const data = await response.json() as OpenAlexPage<OpenAlexWork>;
    const work = data?.results?.[0];
    return work ? formatOpenAlexWorkAsPaper(work) : null;
  } catch (error) {
    console.warn('OpenAlex arXiv fallback failed', error);
    return null;
  }
}

/**
 * One work fetched from OpenAlex by a provider id the feed keys papers with:
 * an OpenAlex work id (`W2741809807`) or a PubMed id (`pmid:31234567`), both
 * of which `GET /works/{id}` resolves directly. This is how the public paper
 * page opens the likes and saves the feed remembered under those ids — a
 * paper liked from an OpenAlex or PubMed card had no DOI or arXiv id stored
 * beside it, so its row on the profile could not link anywhere.
 *
 * The returned paper carries the id the feed would have given it
 * (`openalex:W…` / `pmid:…`), so a like made on the page lands on the same
 * interaction document as one made on the card.
 *
 * `openAlexJson` is injectable for the test: the shared client binds
 * `globalThis.fetch` when the module loads, so swapping the global would not
 * reach it.
 */
export async function fetchPaperByWorkId(type: unknown, value: unknown, options: { timeoutMs?: number; openAlexJson?: (url: string, options: OpenAlexJsonOptions<OpenAlexWork>) => Promise<OpenAlexWork> } = {}) {
  const kind = String(type || '').toLowerCase();
  const clean = String(value || '').trim();
  const lookup = kind === 'openalex' && /^W\d+$/i.test(clean)
    ? clean.toUpperCase()
    : kind === 'pmid' && /^\d+$/.test(clean) ? `pmid:${clean}` : '';
  if (!lookup) return null;
  const feedId = kind === 'openalex' ? `openalex:${lookup}` : lookup;

  const requestJson: (url: string, options: OpenAlexJsonOptions<OpenAlexWork>) => Promise<OpenAlexWork> = options.openAlexJson || openAlexJson;
  try {
    const work = await requestJson(`https://api.openalex.org/works/${encodeURIComponent(lookup)}`, {
      timeoutMs: options.timeoutMs ?? 8000,
      retries: 0,
      cacheTtlMs: 5 * 60 * 1000,
    });
    if (!work?.id) return null;
    return { ...formatOpenAlexWorkAsPaper(work), id: feedId };
  } catch (error) {
    // A 404 is an id nobody can open, which the page reports as not found;
    // anything else is the provider misbehaving, and the page offers a retry.
    if ((error as { status?: number } | null)?.status === 404) return null;
    throw error;
  }
}
