/**
 * OpenAlex API Service
 * Handles semantic enrichment, concept extraction, and citation graphs.
 */

import { CATEGORIES } from '../data/categories';
import { PaperBuilder } from './PaperBuilder';

const CACHE = new Map();
const GRAPH_CACHE = new Map(); // caches W... to arxivId mappings

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId1 = setTimeout(() => controller.abort(), timeoutMs);
  
  let timeoutId2;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId2 = setTimeout(() => {
       controller.abort();
       reject(new Error('Timeout'));
    }, timeoutMs + 100);
  });

  // Automatically append mailto parameter to enter Polite Pool and avoid budget limits
  let finalUrl = url;
  if (finalUrl.includes('api.openalex.org')) {
    finalUrl += finalUrl.includes('?') ? '&mailto=app@papertok.io' : '?mailto=app@papertok.io';
  }

  return Promise.race([
    fetch(finalUrl, { signal: controller.signal }),
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId1);
    clearTimeout(timeoutId2);
  });
}

/**
 * Fetch OpenAlex enrichment data for a batch of arXiv IDs.
 * @param {string[]} arxivIds 
 * @returns {Promise<Object>} Map of { arxivId: { concepts, cited_by_count, related_works } }
 */
export async function enrichPapersBatch(arxivIds) {
  const validIds = arxivIds
    .map(String)
    .filter(id => id && id.trim() !== '')
    .map(id => {
      const pure = id.startsWith('arxiv:') ? id.split(':')[1] : id;
      return pure.replace(/v\d+$/, '');
    });
    
  const toFetch = validIds.filter(id => !CACHE.has(id));
  const result = {};
  
  // Populate from cache first
  validIds.forEach(id => {
    if (CACHE.has(id)) result[id] = CACHE.get(id);
  });
  
  if (toFetch.length === 0) return result;
  
  // OpenAlex supports up to 50 items in an OR filter. Since we use 2 URLs per ID, max chunk is 25.
  const CHUNK_SIZE = 20;
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + CHUNK_SIZE);
    // Use landing_page_url to reliably find arXiv papers instead of DOIs
    const filterIds = chunk.flatMap(id => {
       const cleanId = id.replace(/v\d+$/, '');
       return [`http://arxiv.org/abs/${cleanId}`, `https://arxiv.org/abs/${cleanId}`];
    }).join('|');
    const url = `https://api.openalex.org/works?filter=locations.landing_page_url:${encodeURIComponent(filterIds)}&per-page=50&select=doi,ids,concepts,cited_by_count,related_works,locations,primary_location,type`;
    
    let response = null;
    let primaryFailed = false;
    try {
      response = await fetchWithTimeout(url, 10000).catch(() => null);
      if (!response || !response.ok) {
        primaryFailed = true;
      }
    } catch {
      primaryFailed = true;
    }
      
    // If direct fetch fails (e.g., Safari Private Relay block), try proxy cascade
    if (primaryFailed) {
      console.warn('OpenAlex direct fetch failed, trying proxy cascade');
      try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
        response = await fetchWithTimeout(proxyUrl, 8000).catch(() => null);
      } catch { /* proxy fallback failed, try next */ }

      if (!response || !response.ok) {
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          response = await fetchWithTimeout(proxyUrl, 8000).catch(() => null);
        } catch { /* proxy fallback failed */ }
      }
    }
      
    try {
      if (response && response.ok) {
        const data = await response.json();
        if (data && data.results) {
          data.results.forEach(work => {
             let arxivId = null;
             if (work.ids && work.ids.arxiv) {
               arxivId = work.ids.arxiv.split('/').pop().replace(/^arxiv\./i, '').replace(/v\d+$/, '');
             }
             if (!arxivId && work.locations) {
               const arxivLoc = work.locations.find(loc => loc.source && loc.source.id === 'https://openalex.org/S4306400194');
               if (arxivLoc && arxivLoc.landing_page_url) {
                 const url = arxivLoc.landing_page_url;
                 let rawId;
                 if (url.includes('/abs/')) {
                     rawId = url.split('/abs/')[1];
                 } else if (url.includes('arxiv.')) {
                     rawId = url.split('arxiv.')[1];
                 } else {
                     rawId = url.split('/').pop();
                 }
                 if (rawId) {
                     arxivId = rawId.split('?')[0].replace(/v\d+$/, '');
                 }
               }
             }
             
             if (arxivId) {
               const enriched = {
                 concepts: work.concepts || [],
                 citationCount: work.cited_by_count || 0,
                 related_works: work.related_works || [],
                 publicationType: (work.type && work.type !== 'preprint') ? work.type : (work.primary_location?.source?.type || 'preprint'),
                 publicationStatus: (work.primary_location?.is_published || (work.locations && work.locations.some(l => l.is_published)) || (work.type && work.type !== 'preprint')) ? 'published' : 'preprint',
                 doi: work.doi,
                 journal: work.primary_location?.source?.display_name,
                 publisher: work.primary_location?.source?.host_organization_name,
                 openAccess: work.open_access?.is_oa,
                 pdfUrl: work.open_access?.oa_url,
                 landingPageUrl: work.primary_location?.landing_page_url
               };
               CACHE.set(`openalex_work_${arxivId}`, enriched);
               result[arxivId] = enriched;
             }
          });
        }
      }
    } catch {
      // Enrichment processing failed
    }
  }
  
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
  
  const filterIds = candidates.map(id => `openalex:${id}`).join('|');
  const url = `https://api.openalex.org/works?filter=${filterIds}&per-page=50&select=id,ids`;
  
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
export async function searchAuthors(query) {
  if (!query) return [];
  const cleanName = encodeURIComponent(query.trim());
  const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${cleanName}&limit=10&fields=name,url,paperCount,citationCount,hIndex`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.data) {
      return data.data.map(author => ({
        id: author.authorId,
        display_name: author.name,
        works_count: author.paperCount || 0,
        cited_by_count: author.citationCount || 0,
        h_index: author.hIndex || 0,
        institution: null,
        concepts: []
      }));
    }
  } catch {
    // Search authors failed
  }
  return [];
}

/**
 * Search institutions by name.
 * @param {string} query 
 * @returns {Promise<Array>}
 */
export async function searchInstitutions(query) {
  if (!query) return [];
  const cleanQuery = encodeURIComponent(query.trim());
  const url = `https://api.ror.org/organizations?query=${cleanQuery}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.items) {
      return data.items.slice(0, 5).map(inst => ({
        id: inst.id,
        display_name: inst.names?.find(n => n.types?.includes('ror_display'))?.value || inst.name,
        country_code: inst.locations?.[0]?.geonames_details?.country_name || inst.country?.country_code || '',
        works_count: 0,
        cited_by_count: 0,
        type: inst.types?.[0] || 'education'
      }));
    }
  } catch {
    // Search institutions failed
  }
  return [];
}

/**
 * Search concepts (fields of study) by name.
 * @param {string} query 
 * @returns {Promise<Array>}
 */
export async function searchConcepts(query) {
  if (!query) return [];
  
  let searchQuery = query.trim().toLowerCase();
  let matches = [];

  Object.entries(CATEGORIES).forEach(([id, cat]) => {
    if (cat.label.toLowerCase().includes(searchQuery) || cat.labelEn.toLowerCase().includes(searchQuery)) {
      matches.push({
        id: id,
        display_name: cat.labelEn,
        description: cat.label,
        works_count: 1000,
        level: 0
      });
    }
    if (cat.subcategories) {
      Object.entries(cat.subcategories).forEach(([subId, subCat]) => {
         if (subCat.label.toLowerCase().includes(searchQuery) || subCat.labelEn.toLowerCase().includes(searchQuery)) {
           matches.push({
             id: subId,
             display_name: subCat.labelEn,
             description: subCat.label,
             works_count: 500,
             level: 1
           });
         }
      });
    }
  });

  return matches.slice(0, 5);
}

/**
 * Search journals/sources by name.
 */
export async function searchSources(query) {
  // Free openalex api is down. For now, we return empty so it doesn't crash.
  return [];
}

/**
 * Look up an OpenAlex institution by its ROR identifier or name.
 * Returns { id, display_name } or null if not found.
 */
export async function findInstitution({ rorUrl, name }) {
  if (rorUrl) {
    const rorId = rorUrl.replace(/^https?:\/\/ror\.org\//, '');
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

  return null;
}

/**
 * Fetch entity metadata by ID
 */
export async function getEntityById(type, id) {
  if (!id) return null;
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  
  // If it's an institution and the ID is a ROR ID, resolve via ROR filter
  if (type === 'institution' && (id.includes('ror.org') || !cleanId.startsWith('I'))) {
    const rorUrl = id.startsWith('http') ? id : `https://ror.org/${cleanId}`;
    const url = `https://api.openalex.org/institutions?filter=ror:${encodeURIComponent(rorUrl)}`;
    try {
      const response = await fetchWithTimeout(url, 10000);
      if (!response.ok) return null;
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        return data.results[0];
      }
      return null;
    } catch (err) {
      console.error(`OpenAlex getEntityById by ROR filter failed for ${id}`, err);
      return null;
    }
  }
  
  const endpoint = type === 'institution' ? 'institutions' : type === 'concept' ? 'concepts' : type === 'source' ? 'sources' : 'authors';
  const url = `https://api.openalex.org/${endpoint}/${cleanId}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    const data = await response.json();
    
    // If it's a concept, translate back to Spanish
    if (type === 'concept' && data && data.display_name) {
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
    
    return data;
  } catch {
    // Get entity by id failed
    return null;
  }
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
export async function getWorksByEntity(type, id, sortBy = 'cited_by_count:desc', page = 1, searchQuery = '', filters = {}) {
  if (!id) return { papers: [], total: 0 };
  
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const isRor = type === 'institution' && (id.includes('ror.org') || !cleanId.startsWith('I'));
  
  let filterKey;
  if (type === 'institution') {
    filterKey = isRor ? 'institutions.ror' : 'institutions.id';
  } else if (type === 'concept') {
    filterKey = 'concepts.id';
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
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return { papers: [], total: 0 };
    
    const data = await response.json();
    if (data && data.results) {
       const papers = data.results.map(formatOpenAlexWorkAsPaper).filter(Boolean);
       return { papers, total: data.meta ? data.meta.count : 0 };
    }
  } catch (err) {
    console.error(`OpenAlex getWorksByEntity failed for ${type} ${id}`, err);
  }
  return { papers: [], total: 0 };
}

/**
 * Fetch authors for a specific entity (e.g. institution or concept)
 */
export async function getAuthorsByEntity(type, id, page = 1, searchQuery = '') {
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
  let url = `https://api.openalex.org/authors?filter=${filterKey}:${filterId}&sort=cited_by_count:desc&per-page=30&page=${page}`;
  if (searchQuery) {
     url += `&search=${encodeURIComponent(searchQuery)}`;
  }
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return { authors: [], total: 0 };
    
    const data = await response.json();
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
  }
  return { authors: [], total: 0 };
}

/**
 * Fetch full paper metadata from OpenAlex using a list of DOIs,
 * and format them as standard Paper objects (since they might not be on arXiv).
 * @param {string[]} dois 
 */
export async function fetchPapersByDois(dois) {
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
    }
  }
  
  return results.map(work => {
    return formatOpenAlexWorkAsPaper(work);
  });
}

function formatOpenAlexWorkAsPaper(work) {
  let summary = 'Resumen no disponible.';
  if (work.abstract_inverted_index) {
    const words = [];
    for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
    summary = words.join(' ').replace(/\s+/g, ' ').trim();
  }
  
  const authors = work.authorships?.map(a => ({ name: a.author?.display_name || 'Unknown Author', id: a.author?.id })) || [{ name: 'Unknown Author' }];
  const categories = work.concepts?.map(c => c.display_name) || [];
  const openAlexId = work.id.split('/').pop();
  
  return PaperBuilder.create({
    id: openAlexId,
    sources: { primary: 'openalex', enrichedBy: [] },
    title: work.title || 'No Title',
    abstract: summary || 'No summary available.',
    authors,
    year: work.publication_date ? new Date(work.publication_date).getFullYear() : new Date().getFullYear(),
    publicationType: work.primary_location?.source?.type || 'journal',
    publicationStatus: work.primary_location?.is_published ? 'published' : 'preprint',
    openAccess: work.open_access?.is_oa,
    pdfUrl: work.open_access?.oa_url,
    landingPageUrl: work.primary_location?.landing_page_url || work.id,
    doi: work.doi,
    journal: work.primary_location?.source?.display_name,
    publisher: work.primary_location?.source?.host_organization_name,
    citationCount: work.cited_by_count || 0,
    concepts: work.concepts || [],
    categories: categories,
    keywords: categories
  });
}

import { fetchPapers } from './arxivService';

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

