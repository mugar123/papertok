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
 * Fetch papers from arXiv by categories.
 */
export async function fetchPapers(categories, start = 0, maxResults = 20, mode = 'recent') {
  if (!categories || categories.length === 0) return [];

  const categoryQuery = `(${categories.map((cat) => `cat:${cat}`).join(' OR ')})`;
  const sortBy = mode === 'top' ? 'relevance' : 'submittedDate';

  const params = new URLSearchParams({
    search_query: categoryQuery,
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

    if (isDev) {
      response = await fetch(url);
    } else {
      // In production, try direct first (arXiv may allow CORS)
      try {
        response = await fetch(url);
      } catch {
        // Fallback: use a CORS proxy
        const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
        response = await fetch(proxyUrl);
      }
    }

    if (!response.ok) throw new Error(`arXiv API error: ${response.status}`);

    const xmlText = await response.text();
    const papers = parseArxivXml(xmlText);

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
  // Format the author name for the query: au:"John Doe"
  const formattedName = authorName.trim().replace(/\s+/g, '+');
  const query = `au:"${formattedName}"`;
  return fetchPapers(query, 0, maxResults, 'submittedDate');
}

