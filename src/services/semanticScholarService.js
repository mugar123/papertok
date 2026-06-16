/**
 * Semantic Scholar API Service
 * Supplements OpenAlex with ML-based recommendations, citation graphs, and author relationships.
 * API Rate Limit: 1 request per second (without API Key).
 */

const CACHE = new Map();

// Simple rate limiter queue to avoid 429 Too Many Requests
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 1100; // 1.1 seconds

async function rateLimitedFetch(url, retries = 2) {
  const now = Date.now();
  const timeSinceLastReq = now - lastRequestTime;
  
  if (timeSinceLastReq < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastReq));
  }
  
  lastRequestTime = Date.now();
  
  try {
    const response = await fetch(url);
    if (response.status === 429 && retries > 0) {
      console.warn('Semantic Scholar 429, retrying...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      return rateLimitedFetch(url, retries - 1);
    }
    if (!response.ok) {
      throw new Error(`Semantic Scholar API Error: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error(`Fetch failed for ${url}`, err);
    return null;
  }
}

/**
 * Get AI-based recommendations for a specific paper.
 * @param {string} arxivId 
 * @returns {Promise<string[]>} Array of recommended arXiv IDs
 */
export async function getPaperRecommendations(arxivId) {
  if (!arxivId) return [];
  const cleanId = arxivId.replace(/v\d+$/, '');
  const cacheKey = `rec_${cleanId}`;
  
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/ARXIV:${cleanId}?fields=externalIds&limit=20`;
  
  const data = await rateLimitedFetch(url);
  if (data && data.recommendedPapers) {
    const arxivIds = data.recommendedPapers
      .filter(p => p.externalIds && p.externalIds.ArXiv)
      .map(p => p.externalIds.ArXiv);
      
    CACHE.set(cacheKey, arxivIds);
    return arxivIds;
  }
  
  return [];
}

/**
 * Get references (papers this paper cites) and citations (papers that cite this paper).
 * @param {string} arxivId 
 * @returns {Promise<Object>} { references: [], citations: [] }
 */
export async function getPaperCitationsAndReferences(arxivId) {
  if (!arxivId) return { references: [], citations: [] };
  const cleanId = arxivId.replace(/v\d+$/, '');
  const cacheKey = `cits_refs_${cleanId}`;
  
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  const fields = 'references.title,references.authors,references.year,references.externalIds,citations.title,citations.authors,citations.year,citations.externalIds';
  const url = `https://api.semanticscholar.org/graph/v1/paper/ARXIV:${cleanId}?fields=${fields}`;
  
  const data = await rateLimitedFetch(url);
  if (data) {
    const mapPaper = (p) => ({
      title: p.title,
      authors: p.authors ? p.authors.map(a => a.name) : [],
      year: p.year,
      arxivId: p.externalIds && p.externalIds.ArXiv ? p.externalIds.ArXiv : null
    });

    const result = {
      references: (data.references || []).map(mapPaper).filter(p => p.title),
      citations: (data.citations || []).map(mapPaper).filter(p => p.title)
    };
    
    CACHE.set(cacheKey, result);
    return result;
  }
  
  return { references: [], citations: [] };
}

/**
 * Finds similar authors based on co-authorship.
 * @param {string} authorName 
 * @returns {Promise<Array>} List of similar author objects
 */
export async function getSimilarAuthors(authorName) {
  if (!authorName) return [];
  const cleanName = encodeURIComponent(authorName.trim());
  const cacheKey = `sim_authors_${cleanName}`;
  
  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  // 1. Search for the author to get their ID and papers
  const searchUrl = `https://api.semanticscholar.org/graph/v1/author/search?query=${cleanName}&fields=name,papers.authors&limit=1`;
  const searchData = await rateLimitedFetch(searchUrl);
  
  if (searchData && searchData.data && searchData.data.length > 0) {
    const author = searchData.data[0];
    const coAuthorCounts = {};
    
    // 2. Extract co-authors from their papers
    (author.papers || []).forEach(paper => {
      if (paper.authors) {
        paper.authors.forEach(coAuthor => {
          if (coAuthor.authorId && coAuthor.authorId !== author.authorId) {
            coAuthorCounts[coAuthor.name] = (coAuthorCounts[coAuthor.name] || 0) + 1;
          }
        });
      }
    });
    
    // 3. Sort by frequency
    const similar = Object.entries(coAuthorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({
        name,
        coAuthoredCount: count
      }));
      
    CACHE.set(cacheKey, similar);
    return similar;
  }
  
  return [];
}
