const MEMORY_CACHE = new Map();
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;

export function normalizeDoi(value) {
  return String(value || '')
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
    .toLowerCase();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

export function mapUnpaywallResult(payload) {
  const location = payload?.best_oa_location;
  if (!location) return null;
  const pdfUrl = safeHttpUrl(location.url_for_pdf);
  const landingPageUrl = safeHttpUrl(location.url || payload.doi_url);
  if (!pdfUrl && !landingPageUrl) return null;
  return {
    pdfUrl: pdfUrl || undefined,
    landingPageUrl: landingPageUrl || undefined,
    license: location.license || undefined,
    version: location.version || undefined,
    hostType: location.host_type || undefined,
  };
}

function readCache(doi) {
  const memory = MEMORY_CACHE.get(doi);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`papertok_oa_${doi}`));
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(doi, stored);
      return stored.value;
    }
  } catch { /* Ignore damaged cache entries. */ }
  return undefined;
}

function writeCache(doi, value) {
  const entry = { value, timestamp: Date.now(), ttl: value ? POSITIVE_TTL : NEGATIVE_TTL };
  MEMORY_CACHE.set(doi, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`papertok_oa_${doi}`, JSON.stringify(entry)); } catch { /* Storage is optional. */ }
  }
}

export async function findOpenAccessCopy(rawDoi) {
  const doi = normalizeDoi(rawDoi);
  if (!doi || !doi.startsWith('10.')) return null;
  const cached = readCache(doi);
  if (cached !== undefined) return cached;

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  const email = import.meta.env.VITE_UNPAYWALL_EMAIL || 'app@papertok.io';
  const url = apiBase
    ? `${apiBase}/oa?doi=${encodeURIComponent(doi)}`
    : `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 404) writeCache(doi, null);
      return null;
    }
    const result = mapUnpaywallResult(await response.json());
    writeCache(doi, result);
    return result;
  } catch (error) {
    if (error?.name !== 'AbortError') console.warn('Unpaywall no está disponible', error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

