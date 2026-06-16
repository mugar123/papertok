/**
 * OpenAlex API Service
 * Handles semantic enrichment, concept extraction, and citation graphs.
 */

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

  return Promise.race([
    fetch(url, { signal: controller.signal }),
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
  const validIds = arxivIds.filter(id => id && id.trim() !== '');
  const toFetch = validIds.filter(id => !CACHE.has(id));
  const result = {};
  
  // Populate from cache first
  arxivIds.forEach(id => {
    if (CACHE.has(id)) result[id] = CACHE.get(id);
  });
  
  if (toFetch.length === 0) return result;
  
  // OpenAlex supports up to 50 items in an OR filter
  const CHUNK_SIZE = 40;
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + CHUNK_SIZE);
    // Convert arXiv IDs to their official DOIs for OpenAlex lookup
    const filterIds = chunk.map(id => `doi:10.48550/arxiv.${id.replace(/v\d+$/, '')}`).join('|');
    const url = `https://api.openalex.org/works?filter=${filterIds}&per-page=50&select=doi,concepts,cited_by_count,related_works`;
    
    let response = null;
    let primaryFailed = false;
    try {
      response = await fetchWithTimeout(url, 10000).catch(() => null);
      if (!response || !response.ok) {
        primaryFailed = true;
      }
    } catch (e) {
      primaryFailed = true;
    }
      
    // If direct fetch fails (e.g., Safari Private Relay block), try proxy cascade
    if (primaryFailed) {
      console.warn('OpenAlex direct fetch failed, trying proxy cascade');
      try {
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
        response = await fetchWithTimeout(proxyUrl, 8000).catch(() => null);
      } catch (e) { }

      if (!response || !response.ok) {
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          response = await fetchWithTimeout(proxyUrl, 8000).catch(() => null);
        } catch (e) { }
      }
    }
      
    try {
      if (response && response.ok) {
        const data = await response.json();
        if (data && data.results) {
          data.results.forEach(work => {
             let arxivId = null;
             if (work.doi) {
               // work.doi is usually "https://doi.org/10.48550/arxiv.2403.01123"
               const match = work.doi.match(/arxiv\.(.+)$/i);
               if (match) {
                 arxivId = match[1].replace(/v\d+$/, '');
               }
             }
             
             if (arxivId) {
               const enriched = {
                 concepts: work.concepts || [],
                 cited_by_count: work.cited_by_count || 0,
                 related_works: work.related_works || []
               };
               CACHE.set(arxivId, enriched);
               result[arxivId] = enriched;
             }
          });
        }
      }
    } catch (err) {
      console.error("OpenAlex enrichment failed", err);
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
  } catch (err) {
    console.error("OpenAlex related works fetch failed", err);
  }
  return result;
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
      // Pick the first result as the best match
      const author = data.results[0];
      return {
        id: author.id,
        display_name: author.display_name,
        works_count: author.works_count || 0,
        cited_by_count: author.cited_by_count || 0,
        h_index: author.summary_stats ? author.summary_stats.h_index : 0,
        institution: (author.last_known_institutions && author.last_known_institutions.length > 0) 
            ? author.last_known_institutions[0].display_name 
            : null,
        concepts: author.x_concepts ? author.x_concepts.slice(0, 5) : []
      };
    }
  } catch (err) {
    console.error("OpenAlex getAuthorProfile failed", err);
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
    
    if (workResponse.ok) {
      const workData = await workResponse.json();
      
      if (workData.authorships) {
        // 2. Find the author in the paper's authors list that matches the requested name
        const reqParts = authorName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
        
        // Exact match or closest match
        let bestMatch = null;
        for (const authorship of workData.authorships) {
           const authorDisplayName = authorship.author.display_name;
           if (!authorDisplayName) continue;
           
           const oaParts = authorDisplayName.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
           
           // If all parts of one are present in the other (accounts for 'Last, First' vs 'First Last')
           const reqInOa = reqParts.length > 0 && reqParts.every(p => oaParts.some(o => o.includes(p) || p.includes(o)));
           const oaInReq = oaParts.length > 0 && oaParts.every(o => reqParts.some(p => p.includes(o) || o.includes(p)));
           
           if (reqInOa || oaInReq) {
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
    // DO NOT do a global search for the name, as it will likely return a completely different person (e.g. Medicine instead of Physics)
    return {
      id: `stub-${authorName.replace(/\s+/g, '-')}`,
      display_name: authorName,
      works_count: null,
      cited_by_count: null,
      h_index: null,
      institution: null,
      concepts: []
    };
    
  } catch (err) {
    console.error("OpenAlex getAuthorProfileExact failed", err);
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
  const url = `https://api.openalex.org/authors?search=${cleanName}&per-page=10`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.results) {
      return data.results.map(author => ({
        id: author.id,
        display_name: author.display_name,
        works_count: author.works_count || 0,
        cited_by_count: author.cited_by_count || 0,
        h_index: author.summary_stats ? author.summary_stats.h_index : 0,
        institution: (author.last_known_institutions && author.last_known_institutions.length > 0) 
            ? author.last_known_institutions[0].display_name 
            : null,
        concepts: author.x_concepts ? author.x_concepts.slice(0, 5) : []
      }));
    }
  } catch (err) {
    console.error("OpenAlex searchAuthors failed", err);
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
  const url = `https://api.openalex.org/institutions?search=${cleanQuery}&per-page=5`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.results) {
      return data.results.map(inst => ({
        id: inst.id,
        display_name: inst.display_name,
        country_code: inst.geo?.country_code,
        works_count: inst.works_count || 0,
        cited_by_count: inst.cited_by_count || 0,
        type: inst.type
      }));
    }
  } catch (err) {
    console.error("OpenAlex searchInstitutions failed", err);
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
  const cleanQuery = encodeURIComponent(query.trim());
  const url = `https://api.openalex.org/concepts?search=${cleanQuery}&per-page=5`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.results) {
      return data.results.map(concept => ({
        id: concept.id,
        display_name: concept.display_name,
        level: concept.level,
        description: concept.description,
        works_count: concept.works_count || 0
      }));
    }
  } catch (err) {
    console.error("OpenAlex searchConcepts failed", err);
  }
  return [];
}

/**
 * Fetch entity metadata by ID
 */
export async function getEntityById(type, id) {
  if (!id) return null;
  const endpoint = type === 'institution' ? 'institutions' : type === 'concept' ? 'concepts' : 'authors';
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const url = `https://api.openalex.org/${endpoint}/${cleanId}`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error(`OpenAlex getEntityById failed for ${type} ${id}`, err);
    return null;
  }
}

/**
 * Fetch works for a specific entity
 * type: 'institution', 'concept', 'author'
 * sortBy: 'cited_by_count:desc' or 'publication_date:desc'
 */
export async function getWorksByEntity(type, id, sortBy = 'cited_by_count:desc') {
  if (!id) return [];
  
  const filterKey = type === 'institution' ? 'institutions.id' : type === 'concept' ? 'concepts.id' : 'author.id';
  const cleanId = id.includes('/') ? id.split('/').pop() : id;
  const filterParams = `${filterKey}:${cleanId},locations.source.id:S4306400194`;
  
  const url = `https://api.openalex.org/works?filter=${filterParams}&sort=${sortBy}&per-page=30&select=id,locations`;
  
  try {
    const response = await fetchWithTimeout(url, 10000);
    if (!response.ok) return [];
    
    const data = await response.json();
    if (data && data.results) {
       const arxivIds = [];
       data.results.forEach(work => {
           if (work.locations) {
               const arxivLoc = work.locations.find(loc => loc.source && loc.source.id === 'https://openalex.org/S4306400194');
               if (arxivLoc && arxivLoc.landing_page_url) {
                   const arxivId = arxivLoc.landing_page_url.split('/').pop().replace(/v\d+$/, '');
                   if (arxivId && arxivId !== 'arxiv.org') {
                       arxivIds.push(arxivId);
                   }
               }
           }
       });
       return arxivIds;
    }
  } catch (err) {
    console.error(`OpenAlex getWorksByEntity failed for ${type} ${id}`, err);
  }
  return [];
}
