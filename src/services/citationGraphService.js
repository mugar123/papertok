import { PaperBuilder } from './PaperBuilder.js';
import { normalizeCitationDoi } from '../utils/citationGraph.js';

const CACHE = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

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
