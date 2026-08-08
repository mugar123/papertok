import { PaperBuilder } from './PaperBuilder.js';
import { normalizeCitationDoi } from '../utils/citationGraph.js';
import { fetchPapersByDois } from './openAlexService.js';
import { findOpenAccessCopy } from './unpaywallService.js';

const CACHE = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MISSING_ABSTRACTS = new Set([
  '',
  'abstract unavailable.',
  'no abstract available.',
  'no summary available.',
  'resumen no disponible.',
]);

function hasSourcedAbstract(value) {
  return !MISSING_ABSTRACTS.has(String(value || '').trim().toLowerCase());
}

function mergeHydratedPaper(paper, openAlexPaper, openCopy) {
  const enrichedBy = new Set(paper?.sources?.enrichedBy || []);
  if (openAlexPaper) enrichedBy.add('openalex');
  if (openCopy) enrichedBy.add('unpaywall');

  const hydrated = {
    ...paper,
    sources: {
      primary: paper?.sources?.primary || 'opencitations',
      enrichedBy: [...enrichedBy],
    },
    citationMetadataResolved: true,
  };

  if (openAlexPaper) {
    const preferEnrichedAbstract = !hasSourcedAbstract(paper?.abstract)
      && hasSourcedAbstract(openAlexPaper.abstract);
    const fields = [
      'journal',
      'publisher',
      'publicationType',
      'publicationStatus',
      'peerReviewed',
      'published',
      'year',
      'citationCount',
      'citationCountKnown',
      'concepts',
      'categories',
      'keywords',
    ];
    fields.forEach(field => {
      const value = openAlexPaper[field];
      const missing = hydrated[field] === undefined
        || hydrated[field] === null
        || hydrated[field] === ''
        || (Array.isArray(hydrated[field]) && hydrated[field].length === 0);
      if (missing && value !== undefined && value !== null && value !== '') hydrated[field] = value;
    });
    if (preferEnrichedAbstract) hydrated.abstract = openAlexPaper.abstract;
    if ((!hydrated.authors || hydrated.authors.length === 0) && openAlexPaper.authors?.length) {
      hydrated.authors = openAlexPaper.authors;
    }
    if (!hydrated.landingPageUrl && openAlexPaper.landingPageUrl) {
      hydrated.landingPageUrl = openAlexPaper.landingPageUrl;
    }
    if (openAlexPaper.openAccess === true) {
      hydrated.openAccess = true;
      hydrated.pdfUrl = hydrated.pdfUrl || openAlexPaper.pdfUrl;
    }
  }

  if (openCopy) {
    hydrated.openAccess = true;
    hydrated.openAccessPdfUrl = openCopy.pdfUrl || hydrated.openAccessPdfUrl;
    hydrated.landingPageUrl = hydrated.landingPageUrl || openCopy.landingPageUrl || '';
    hydrated.accessSource = openCopy.accessSource || 'unpaywall';
    hydrated.license = openCopy.license || hydrated.license;
  }

  return hydrated;
}

export async function hydrateCitationGraphPaper(paper, dependencies = {}) {
  const doi = getCitationGraphDoi(paper);
  if (!doi) return paper;

  const fetchPapers = dependencies.fetchPapersByDois || fetchPapersByDois;
  const findOpenCopy = dependencies.findOpenAccessCopy || findOpenAccessCopy;
  const [openAlexResult, accessResult] = await Promise.allSettled([
    fetchPapers([doi]),
    findOpenCopy(doi),
  ]);
  const openAlexPaper = openAlexResult.status === 'fulfilled'
    ? openAlexResult.value?.find(candidate => normalizeCitationDoi(candidate?.doi) === doi) || null
    : null;
  const openCopy = accessResult.status === 'fulfilled' ? accessResult.value : null;
  return mergeHydratedPaper(paper, openAlexPaper, openCopy);
}

export function getCitationGraphDoi(paper) {
  const doi = normalizeCitationDoi(paper?.doi);
  return /^10\.\d{4,9}\/.+/.test(doi) ? doi : '';
}

export function mapCitationGraphPayload(payload) {
  const mapPapers = items => (Array.isArray(items) ? items : []).map(item => PaperBuilder.create(item));
  return {
    references: mapPapers(payload?.references),
    citations: mapPapers(payload?.citations),
    counts: {
      references: Math.max(0, Number(payload?.counts?.references) || 0),
      citations: Math.max(0, Number(payload?.counts?.citations) || 0),
    },
    source: payload?.source || 'opencitations',
    partial: Boolean(payload?.partial),
  };
}

export async function getCitationGraph(paper, limit = 8) {
  const doi = getCitationGraphDoi(paper);
  if (!doi) return null;

  const safeLimit = Math.max(1, Math.min(10, Number(limit) || 8));
  const cacheKey = `${doi}:${safeLimit}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new Error('Citation graph API is not configured');

  const url = new URL(`${apiBase}/citation-graph`);
  url.searchParams.set('doi', doi);
  url.searchParams.set('limit', String(safeLimit));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Citation graph API error: ${response.status}`);
    const data = mapCitationGraphPayload(await response.json());
    CACHE.set(cacheKey, { data, timestamp: Date.now() });
    return data;
  } finally {
    clearTimeout(timeoutId);
  }
}
