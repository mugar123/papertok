import { trustedWorkerUrl } from './workerApiClient.js';

/**
 * Figures for a paper, used as the backdrop behind the feed card.
 *
 * The worker does the extraction; this only asks for the list and remembers it.
 * The images themselves are loaded by the browser straight from ar5iv through a
 * plain <img>, which needs no CORS grant and keeps the bytes off the worker.
 *
 * A paper with no figures is the normal case for a lot of the corpus, so the
 * cache stores empty results too — otherwise every scroll past the same card
 * would retry a conversion that is never going to exist.
 */

const figureCache = new Map();
/** In-flight requests, so a double mount does not fetch the same paper twice
 *  and then race to cache each other's result. */
const pendingRequests = new Map();
const REQUEST_TIMEOUT_MS = 10_000;

export function normalizeArxivFigureId(paper) {
  const raw = String(paper?.arxivId || '')
    .replace(/^arxiv:/i, '')
    .replace(/v\d+$/i, '')
    .trim();
  return /^\d{4}\.\d{4,5}$/.test(raw) ? raw : '';
}

export function canHaveFigures(paper) {
  return Boolean(normalizeArxivFigureId(paper));
}

async function requestFigures(url, arxivId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Figures unavailable: ${response.status}`);
    const payload = await response.json();
    const figures = Array.isArray(payload?.figures)
      ? payload.figures.filter(figure => typeof figure?.url === 'string')
      : [];
    // Only a real answer is remembered. Caching a failure here once meant an
    // aborted duplicate request could permanently blank a paper's figures.
    figureCache.set(arxivId, figures);
    return figures;
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    pendingRequests.delete(arxivId);
  }
}

export async function getPaperFigures(paper) {
  const arxivId = normalizeArxivFigureId(paper);
  if (!arxivId) return [];
  if (figureCache.has(arxivId)) return figureCache.get(arxivId);
  if (pendingRequests.has(arxivId)) return pendingRequests.get(arxivId);

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) return [];
  const url = trustedWorkerUrl(`${apiBase}/resources/figures?arxiv_id=${encodeURIComponent(arxivId)}`);
  if (!url) return [];

  const request = requestFigures(url, arxivId);
  pendingRequests.set(arxivId, request);
  return request;
}
