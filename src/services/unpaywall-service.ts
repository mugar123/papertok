interface OpenAccessPayload {
  doi_url?: string; source?: string;
  best_oa_location?: { url_for_pdf?: string; url_for_landing_page?: string; url?: string; license?: string; version?: string; host_type?: string; repository_institution?: string } | null;
}
interface CacheEntry { value: ReturnType<typeof mapUnpaywallResult>; timestamp: number; ttl: number; }

import { safeCatalogUrl } from '../utils/external-url.ts';

const MEMORY_CACHE = new Map<string, CacheEntry>();
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
// Neither Unpaywall nor Crossref could speak for the DOI yet, which is what a
// paper hours old gets. The Worker keeps that answer six hours; a day here
// would hide the paper's access long after Unpaywall has indexed it.
const UNRESOLVED_TTL = 6 * 60 * 60 * 1000;
// A lookup that failed outright: an outage, a timeout, or a Worker from before
// the Crossref fallback, which answered 502 for every fresh DOI. Memory only,
// so a reload asks again; with nothing at all, a card asked on every visit.
const FAILURE_TTL = 10 * 60 * 1000;

export function normalizeDoi(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .toLowerCase();
}

export function mapUnpaywallResult(payload: OpenAccessPayload) {
  const location = payload?.best_oa_location;
  if (!location) return null;
  const pdfUrl = safeCatalogUrl(location.url_for_pdf);
  const landingPageUrl = safeCatalogUrl(location.url_for_landing_page || location.url || payload.doi_url);
  if (!pdfUrl && !landingPageUrl) return null;
  return {
    pdfUrl: pdfUrl || undefined,
    landingPageUrl: landingPageUrl || undefined,
    license: location.license || undefined,
    version: location.version || undefined,
    hostType: location.host_type || undefined,
    repositoryInstitution: location.repository_institution || undefined,
    // The Worker answers in Unpaywall's shape even when the copy came from a
    // Crossref licence, and says so here.
    accessSource: payload.source === 'crossref' ? 'crossref' : 'unpaywall',
  };
}

function readCache(doi: string) {
  const memory = MEMORY_CACHE.get(doi);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`papertok_oa_${doi}`)!) as CacheEntry | null;
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(doi, stored);
      return stored.value;
    }
  } catch { /* Ignore damaged cache entries. */ }
  return undefined;
}

function writeCache(doi: string, value: ReturnType<typeof mapUnpaywallResult>, ttl = value ? POSITIVE_TTL : NEGATIVE_TTL) {
  const entry = { value, timestamp: Date.now(), ttl };
  MEMORY_CACHE.set(doi, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`papertok_oa_${doi}`, JSON.stringify(entry)); } catch { /* Storage is optional. */ }
  }
}

function rememberFailure(doi: string) {
  MEMORY_CACHE.set(doi, { value: null, timestamp: Date.now(), ttl: FAILURE_TTL });
}

export async function findOpenAccessCopy(rawDoi: unknown) {
  const doi = normalizeDoi(rawDoi);
  if (!doi || !doi.startsWith('10.')) return null;
  const cached = readCache(doi);
  if (cached !== undefined) return cached;

  const apiBase = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  const email = import.meta.env?.VITE_UNPAYWALL_EMAIL || 'app@papertok.io';
  const url = apiBase
    ? `${apiBase}/oa?doi=${encodeURIComponent(doi)}`
    : `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 404) writeCache(doi, null);
      else rememberFailure(doi);
      return null;
    }
    const payload = await response.json() as OpenAccessPayload;
    const result = mapUnpaywallResult(payload);
    writeCache(doi, result, !result && payload?.source === 'unresolved' ? UNRESOLVED_TTL : undefined);
    return result;
  } catch (error) {
    rememberFailure(doi);
    if ((error as { name?: string } | null)?.name !== 'AbortError') console.warn('Unpaywall is unavailable', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
