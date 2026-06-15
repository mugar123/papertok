/**
 * OpenAlex API Service
 * Handles semantic enrichment, concept extraction, and citation graphs.
 */

const CACHE = new Map();
const GRAPH_CACHE = new Map(); // caches W... to arxivId mappings

/**
 * Fetch OpenAlex enrichment data for a batch of arXiv IDs.
 * @param {string[]} arxivIds 
 * @returns {Promise<Object>} Map of { arxivId: { concepts, cited_by_count, related_works } }
 */
export async function enrichPapersBatch(arxivIds) {
  if (!arxivIds || arxivIds.length === 0) return {};
  
  // Clean IDs (remove versions like v1)
  const cleanIds = arxivIds.map(id => id.replace(/v\d+$/, ''));
  
  const toFetch = cleanIds.filter(id => !CACHE.has(id));
  const result = {};
  
  // Populate from cache
  cleanIds.forEach(id => {
    if (CACHE.has(id)) result[id] = CACHE.get(id);
  });
  
  if (toFetch.length === 0) return result;
  
  // OpenAlex supports up to 50 items in an OR filter
  const CHUNK_SIZE = 40;
  for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
    const chunk = toFetch.slice(i, i + CHUNK_SIZE);
    // Explicitly search by arxiv ID
    const filterIds = chunk.map(id => `ids.arxiv:${id}`).join('|');
    const url = `https://api.openalex.org/works?filter=${filterIds}&per-page=50&select=ids,concepts,cited_by_count,related_works`;
    
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data && data.results) {
          data.results.forEach(work => {
             let arxivId = null;
             if (work.ids && work.ids.arxiv) {
               arxivId = work.ids.arxiv.split('/').pop().replace(/v\d+$/, '');
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
  
  const result = [];
  const toFetch = [];
  
  openAlexUrls.forEach(url => {
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
     const response = await fetch(url);
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
