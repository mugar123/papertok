/**
 * arXiv API Service
 * Uses Vite proxy in dev, CORS proxy in production (GitHub Pages).
 */

const isDev = import.meta.env.DEV;
const ARXIV_DEV = '/api/arxiv';
const ARXIV_PROD = 'https://export.arxiv.org/api/query';
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

function parseArxivXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const entries = doc.querySelectorAll('entry');
  const papers = [];

  entries.forEach((entry) => {
    const id = entry.querySelector('id')?.textContent || '';
    const arxivId = id.replace(/.*\/abs\//, '').replace(/v\d+$/, '').trim();
    if (!arxivId || arxivId.toLowerCase() === 'unknown') return;

    const title = (entry.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const summary = (entry.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').trim();

    const authorElements = entry.querySelectorAll('author');
    const authors = [];
    authorElements.forEach((a) => {
      const name = a.querySelector('name')?.textContent;
      if (name) authors.push(name);
    });

    let pdfUrl = '';
    const links = entry.querySelectorAll('link');
    links.forEach((link) => {
      if (link.getAttribute('title') === 'pdf') {
        pdfUrl = link.getAttribute('href') || '';
      }
    });
    if (!pdfUrl && arxivId) pdfUrl = `https://arxiv.org/pdf/${arxivId}`;

    const primaryCatEl = entry.querySelector('primary_category') ||
      entry.querySelector('[*|primary_category]');
    const primaryCategory = primaryCatEl?.getAttribute('term') || '';

    const categoryElements = entry.querySelectorAll('category');
    const allCategories = [];
    categoryElements.forEach((c) => {
      const term = c.getAttribute('term');
      if (term) allCategories.push(term);
    });

    const doi = entry.querySelector('doi')?.textContent || entry.getElementsByTagName('arxiv:doi')[0]?.textContent || entry.getElementsByTagNameNS('*', 'doi')[0]?.textContent || '';
    const journalRef = entry.querySelector('journal_ref')?.textContent || entry.getElementsByTagName('arxiv:journal_ref')[0]?.textContent || entry.getElementsByTagNameNS('*', 'journal_ref')[0]?.textContent || '';
    const comment = entry.querySelector('comment')?.textContent || entry.getElementsByTagName('arxiv:comment')[0]?.textContent || entry.getElementsByTagNameNS('*', 'comment')[0]?.textContent || '';

    // Fix for published and updated just in case
    const publishedRaw = entry.querySelector('published')?.textContent || entry.getElementsByTagNameNS('*', 'published')[0]?.textContent || '';
    const updatedRaw = entry.querySelector('updated')?.textContent || entry.getElementsByTagNameNS('*', 'updated')[0]?.textContent || '';
    const published = safeDateISO(publishedRaw);
    const updated = safeDateISO(updatedRaw);

    papers.push({
      id: arxivId, arxivId, title, summary, published, updated,
      authors, pdfUrl, primaryCategory, allCategories, doi, journalRef, comment,
    });
  });

  return papers;
}

/**
 * Helper to parse the rss2json format in production
 */
function safeDateISO(dateStr) {
  if (!dateStr) return new Date().toISOString();
  let cleanStr = dateStr.trim();
  
  // Replace space with T to make it ISO 8601 compliant for Safari
  // Converts "2024-03-12 20:00:00" to "2024-03-12T20:00:00"
  // Converts "2024-03-12 20:00:00 +0000" to "2024-03-12T20:00:00 +0000"
  cleanStr = cleanStr.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
  
  // If it has a timezone offset like +0000 or -0400 without a colon, Safari hates it.
  // We can just append Z if it ends with time, or trust the parser if it's standard.
  if (cleanStr.match(/T\d{2}:\d{2}:\d{2}$/)) {
    cleanStr += 'Z';
  }
  
  const parsed = new Date(cleanStr);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseRss2Json(data) {
  if (data.status !== 'ok' || !data.items) return [];
  
  return data.items
    .map(item => {
      const idUrl = item.guid || item.link;
      const id = idUrl ? idUrl.split('/').pop() : '';
      if (!id || id.toLowerCase() === 'unknown') return null;
      
      const authors = item.author ? item.author.split(',').map(a => a.trim()) : ['Unknown Author'];
      const categories = item.categories || [];
      const primaryCategory = categories.length > 0 ? categories[0] : 'unknown';
      
      return {
        id,
        arxivId: id,
        title: item.title ? item.title.replace(/\n/g, ' ').trim() : 'No Title',
        summary: item.description ? item.description.replace(/\n/g, ' ').trim() : 'No summary available.',
        authors,
        published: safeDateISO(item.pubDate),
        updated: safeDateISO(item.pubDate),
        pdfUrl: idUrl ? idUrl.replace('abs', 'pdf') : '',
        primaryCategory,
        allCategories: categories,
        doi: '',
        journalRef: '',
        comment: ''
      };
    })
    .filter(Boolean);
}

let lastFetchTime = 0;

/**
 * Helper to fetch and parse arXiv XML or JSON using cascading proxies in production
 */
async function fetchArxivData(url) {
  const baseUrl = isDev ? ARXIV_DEV : ARXIV_PROD;
  
  if (isDev) {
    try {
      const response = await fetchWithTimeout(url, 10000);
      if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);
      const xmlText = await response.text();
      return parseArxivXml(xmlText);
    } catch (e) {
      console.warn('Dev fetch failed', e);
    }
  }

  // Without fetchQueue, requests run in parallel.
  // This prevents one slow proxy (like allorigins) from delaying the entire feed by 30+ seconds.
  try {
    // 1. Try corsproxy.io (fast, raw XML, keeps all authors)
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    const response = await fetchWithTimeout(proxyUrl, 6000);
    
    if (response.ok) {
       const xmlText = await response.text();
       const parsed = parseArxivXml(xmlText);
       if (parsed.length > 0) {
         return parsed;
       }
    }
  } catch (e) {
    console.warn('corsproxy failed', e);
  }

  try {
    // Strip out parentheses to help some proxies
    const cleanUrl = url.replace(/[\(\)]/g, '');
    // 2. Try allorigins (keeps all authors)
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(cleanUrl)}`;
    const response = await fetchWithTimeout(proxyUrl, 6000);
        
        if (response.ok) {
           const data = await response.json();
           if (data.contents) {
             const parsed = parseArxivXml(data.contents);
             if (parsed.length > 0) return parsed;
           }
        }
      } catch (e) {
        console.warn('allorigins failed, trying rss2json', e);
      }
      
      // 3. Fallback to rss2json (fast, but drops co-authors)
      try {
        const cleanUrl = url.replace(/[\(\)]/g, '');
        const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(cleanUrl)}`;
        const response = await fetchWithTimeout(proxyUrl, 8000);
        if (!response.ok) throw new Error(`arXiv API error via rss2json: ${response.status}`);
        const data = await response.json();
        return parseRss2Json(data);
      } catch (e) {
        console.error('All proxies failed', e);
        return [];
      }
}

/**
 * Fetch papers from arXiv by categories or raw query.
 */
export async function fetchPapers(categoriesOrQuery, start = 0, maxResults = 20, mode = 'recent', sortByOverride = 'submittedDate') {
  if (!categoriesOrQuery || categoriesOrQuery.length === 0) return [];

  let searchQuery = '';
  if (Array.isArray(categoriesOrQuery)) {
    searchQuery = `(${categoriesOrQuery.map((cat) => `cat:${cat}`).join(' OR ')})`;
  } else {
    searchQuery = categoriesOrQuery;
  }

  const sortBy = mode === 'relevance' ? 'relevance' : sortByOverride;

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: start.toString(),
    max_results: maxResults.toString(),
    sortBy,
  });
  if (sortBy !== 'relevance') {
    params.append('sortOrder', 'descending');
  }

  const baseUrl = isDev ? ARXIV_DEV : ARXIV_PROD;
  const url = `${baseUrl}?${params.toString()}`;

  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    const papers = await fetchArxivData(url);
    cache.set(cacheKey, { data: papers, timestamp: Date.now() });
    return papers;
  } catch (error) {
    console.error('Error fetching papers:', error);
    throw error;
  }
}

export function getPdfUrl(arxivId) { return `https://arxiv.org/pdf/${arxivId}`; }
export function getAbsUrl(arxivId) { return `https://arxiv.org/abs/${arxivId}`; }
export function clearCache() { cache.clear(); }

/**
 * Fetch papers by a specific author
 */
export async function getAuthorPapers(authorName, maxResults = 10) {
  // We use quotes for exact match. URLSearchParams will safely encode spaces.
  const query = `au:"${authorName.trim()}"`;
  return fetchPapers(query, 0, maxResults, 'submittedDate');
}

/**
 * Fetch papers by a list of arXiv IDs.
 */
export async function fetchPapersByIds(arxivIds) {
  if (!arxivIds || arxivIds.length === 0) return [];
  const idList = arxivIds.join(',');
  const params = new URLSearchParams({
    id_list: idList,
  });

  const baseUrl = isDev ? ARXIV_DEV : ARXIV_PROD;
  const url = `${baseUrl}?${params.toString()}`;

  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    const papers = await fetchArxivData(url);
    cache.set(cacheKey, { data: papers, timestamp: Date.now() });
    return papers;
  } catch (error) {
    console.error('Error fetching papers by id:', error);
    throw error;
  }
}

/**
 * Search papers by any string (all:query)
 */
export async function searchPapers(queryStr, start = 0, maxResults = 20) {
  if (!queryStr || queryStr.trim() === '') return [];
  const encodedQuery = `all:"${queryStr.trim()}"`;
  return fetchPapers(encodedQuery, start, maxResults, 'recent', 'relevance');
}

