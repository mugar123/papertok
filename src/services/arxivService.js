/**
 * arXiv API Service
 * Uses Vite proxy in dev, CORS proxy in production (GitHub Pages).
 */

const isDev = import.meta.env?.DEV === true;
import { PaperBuilder } from './PaperBuilder.js';
import CATEGORIES from '../data/categories.js';

const ARXIV_DEV = '/api/arxiv';
const ARXIV_PROD = 'https://export.arxiv.org/api/query';
const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const ARXIV_PREFIXES = ['cs', 'math', 'physics', 'eess', 'q-bio', 'q-fin', 'stat', 'econ', 'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph', 'math-ph'];
const CATEGORY_DEFINITIONS = new Map(
  Object.values(CATEGORIES).flatMap(area =>
    Object.entries(area.subcategories || {}).map(([id, category]) => [id, category])
  )
);

function isArxivCategory(category) {
  return ARXIV_PREFIXES.some(prefix => category === prefix || category.startsWith(`${prefix}.`));
}

function categoryMatchScore(paper, categoryId) {
  if (paper.categories?.includes(categoryId) || paper.primaryCategory === categoryId) return Number.POSITIVE_INFINITY;

  const label = CATEGORY_DEFINITIONS.get(categoryId)?.labelEn || categoryId.replace(/\./g, ' ');
  const terms = label.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 4);
  const text = `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

export function assignRequestedCategories(papers, requestedCategories) {
  if (!Array.isArray(requestedCategories) || requestedCategories.length === 0) return papers;

  return papers.map(paper => {
    const selectedCategory = requestedCategories.reduce((best, categoryId) => {
      return categoryMatchScore(paper, categoryId) > categoryMatchScore(paper, best) ? categoryId : best;
    }, requestedCategories[0]);
    const providerCategories = paper.allCategories || paper.categories || [];

    return {
      ...paper,
      primaryCategory: selectedCategory,
      allCategories: [...new Set([selectedCategory, ...providerCategories])],
    };
  });
}

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
    const published = safeDateISO(publishedRaw);

    const isPublishedInArxiv = !!(doi || journalRef || (comment && comment.match(/(accepted|published|appears|to appear) in/i)));

    papers.push(PaperBuilder.create({
      id: arxivId,
      arxivId,
      sources: { primary: 'arxiv', enrichedBy: [] },
      title,
      abstract: summary,
      authors: authors.map(name => ({ name })),
      doi,
      journal: journalRef,
      year: new Date(published).getFullYear(),
      publicationType: isPublishedInArxiv ? 'article' : 'preprint',
      publicationStatus: isPublishedInArxiv ? 'published' : 'preprint',
      openAccess: true,
      pdfUrl,
      landingPageUrl: `https://arxiv.org/abs/${arxivId}`,
      categories: allCategories,
      keywords: allCategories,
      primaryCategory,
      published,
    }));
  });

  return papers;
}

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


/**
 * Helper to fetch and parse arXiv XML or JSON using cascading proxies in production
 */
async function fetchArxivData(url) {
  // The PaperTok Worker avoids depending on unreliable public CORS proxies in production.
  if (PAPER_API_BASE) {
    try {
      const query = new URL(url).search;
      const response = await fetchWithTimeout(`${PAPER_API_BASE}/arxiv${query}`, 5_500);
      if (!response.ok) throw new Error(`PaperTok arXiv API error: ${response.status}`);
      const parsed = parseArxivXml(await response.text());
      if (parsed.length > 0) return parsed;
    } catch (error) {
      console.warn('PaperTok arXiv API failed, using fallback', error);
    }
  }

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

  const fallbackRequests = [
    (async () => {
    const proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
      const response = await fetchWithTimeout(proxyUrl, 4_500);
      if (!response.ok) throw new Error(`corsproxy error: ${response.status}`);
      const parsed = parseArxivXml(await response.text());
      if (parsed.length === 0) throw new Error('corsproxy returned no arXiv entries');
      return parsed;
    })(),
    (async () => {
      const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
      const response = await fetchWithTimeout(proxyUrl, 4_500);
      if (!response.ok) throw new Error(`allorigins error: ${response.status}`);
      const data = await response.json();
      if (!data.contents) throw new Error('allorigins returned no content');
      let xmlText = data.contents;
      if (xmlText.startsWith('data:')) {
        const base64Data = xmlText.split(',')[1];
        xmlText = atob(base64Data);
      }
      const parsed = parseArxivXml(xmlText);
      if (parsed.length === 0) throw new Error('allorigins returned no arXiv entries');
      return parsed;
    })(),
  ];

  const fallbackResults = await Promise.allSettled(fallbackRequests);
  const successfulFallback = fallbackResults.find(result => result.status === 'fulfilled');
  if (successfulFallback) return successfulFallback.value;

  const cause = fallbackResults.find(result => result.status === 'rejected')?.reason;
  console.error('All arXiv routes failed', cause);
  throw new Error('No se pudo conectar con arXiv. Inténtalo de nuevo en unos segundos.', { cause });
}

/**
 * Fetch papers from arXiv by categories or raw query.
 */
export async function fetchPapers(categoriesOrQuery, start = 0, maxResults = 20, mode = 'recent', sortByOverride = 'submittedDate', options = {}) {
  if (!categoriesOrQuery || categoriesOrQuery.length === 0) return [];

  let searchQuery = categoriesOrQuery;
  if (Array.isArray(categoriesOrQuery)) {
    // Determine if a category should be searched as a cat: or as a keyword search
    searchQuery = `(${categoriesOrQuery.map((cat) => {
      if (isArxivCategory(cat)) {
        return `cat:${cat}`;
      } else {
        const searchPhrase = CATEGORY_DEFINITIONS.get(cat)?.labelEn || cat.replace(/\./g, ' ');
        return `all:"${searchPhrase}"`;
      }
    }).join(' OR ')})`;
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
  if (!options.forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    const fetchedPapers = await fetchArxivData(url);
    const papers = Array.isArray(categoriesOrQuery)
      ? assignRequestedCategories(fetchedPapers, categoriesOrQuery)
      : fetchedPapers;
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
