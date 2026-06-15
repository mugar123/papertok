/**
 * arXiv API Service
 * Uses Vite proxy in dev, CORS proxy in production (GitHub Pages).
 */

const isDev = import.meta.env.DEV;
const ARXIV_DEV = '/api/arxiv';
const ARXIV_PROD = 'https://export.arxiv.org/api/query';
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function parseArxivXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const entries = doc.querySelectorAll('entry');
  const papers = [];

  entries.forEach((entry) => {
    const id = entry.querySelector('id')?.textContent || '';
    const arxivId = id.replace(/.*\/abs\//, '').replace(/v\d+$/, '');

    const title = (entry.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const summary = (entry.querySelector('summary')?.textContent || '').replace(/\s+/g, ' ').trim();
    const published = entry.querySelector('published')?.textContent || '';
    const updated = entry.querySelector('updated')?.textContent || '';

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

    const doi = entry.querySelector('doi')?.textContent || '';
    const journalRef = entry.querySelector('journal_ref')?.textContent || '';
    const comment = entry.querySelector('comment')?.textContent || '';

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
  if (dateStr.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) {
    return new Date(dateStr.replace(' ', 'T') + 'Z').toISOString();
  }
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseRss2Json(data) {
  if (data.status !== 'ok' || !data.items) return [];
  
  return data.items.map(item => {
    const idUrl = item.guid || item.link;
    const id = idUrl ? idUrl.split('/').pop() : 'unknown';
    
    const authors = item.author ? item.author.split(',').map(a => a.trim()) : ['Unknown Author'];
    const categories = item.categories || [];
    const primaryCategory = categories.length > 0 ? categories[0] : 'unknown';
    
    return {
      id,
      title: item.title ? item.title.replace(/\n/g, ' ').trim() : 'No Title',
      summary: item.description ? item.description.replace(/\n/g, ' ').trim() : 'No summary available.',
      authors,
      published: safeDateISO(item.pubDate),
      updated: safeDateISO(item.pubDate),
      pdfLink: idUrl ? idUrl.replace('abs', 'pdf') : '',
      primaryCategory,
      categories
    };
  });
}

/**
 * Fetch papers from arXiv by categories or raw query.
 */
export async function fetchPapers(categoriesOrQuery, start = 0, maxResults = 20, mode = 'recent') {
  if (!categoriesOrQuery || categoriesOrQuery.length === 0) return [];

  let searchQuery = '';
  if (Array.isArray(categoriesOrQuery)) {
    searchQuery = `(${categoriesOrQuery.map((cat) => `cat:${cat}`).join(' OR ')})`;
  } else {
    searchQuery = categoriesOrQuery;
  }

  const sortBy = 'submittedDate';

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: start.toString(),
    max_results: maxResults.toString(),
    sortBy,
    sortOrder: 'descending',
  });

  // In dev, use Vite proxy. In production, try direct or CORS proxy.
  const baseUrl = isDev ? ARXIV_DEV : ARXIV_PROD;
  const url = `${baseUrl}?${params.toString()}`;

  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let papers = [];
    if (isDev) {
      response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);
      const xmlText = await response.text();
      papers = parseArxivXml(xmlText);
    } else {
      // Fallback: use rss2json proxy which is highly reliable and handles CORS
      const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
      response = await fetch(proxyUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);
      const data = await response.json();
      papers = parseRss2Json(data);
    }
    clearTimeout(timeoutId);

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
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let papers = [];
    if (isDev) {
      response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);
      const xmlText = await response.text();
      papers = parseArxivXml(xmlText);
    } else {
      const proxyUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
      response = await fetch(proxyUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);
      const data = await response.json();
      papers = parseRss2Json(data);
    }
    clearTimeout(timeoutId);

    cache.set(cacheKey, { data: papers, timestamp: Date.now() });
    return papers;
  } catch (error) {
    console.error('Error fetching papers by id:', error);
    throw error;
  }
}

