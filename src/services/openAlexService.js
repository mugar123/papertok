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
