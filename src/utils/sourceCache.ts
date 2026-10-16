/**
 * Small TTL cache for source adapter responses, backed by localStorage.
 *
 * Written when PubMed's E-utilities ran as three serial requests straight from
 * the browser — 1.35–2.05 s per feed load, every load, because nothing along that
 * path was cacheable. `/sources/pubmed` now runs that chain inside the Worker and
 * caches the answer at the edge, so this is no longer the only cache in front of
 * it; it is the nearer one. A hit here still costs no request at all, and ten
 * minutes of staleness is invisible in a feed of scientific papers while two
 * seconds of skeleton on every revisit is not.
 *
 * One storage key holds every entry so eviction is a single read-modify-write,
 * and the entry count is capped: this must never compete with the feed
 * snapshot for quota. Every failure path degrades to "no cache", never to an
 * error the caller sees.
 */

const CACHE_KEY = 'papertok_source_cache_v1';
const MAX_ENTRIES = 6;

function getStore(storage) {
  try {
    const raw = storage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readSourceCache(key, ttlMs, storage = globalThis.localStorage) {
  if (!storage || !key || !(ttlMs > 0)) return null;
  try {
    const entry = getStore(storage)[key];
    if (!entry || typeof entry.t !== 'number') return null;
    if (Date.now() - entry.t > ttlMs) return null;
    return entry.v ?? null;
  } catch {
    return null;
  }
}

export function writeSourceCache(key, value, storage = globalThis.localStorage) {
  if (!storage || !key || value === undefined) return;
  try {
    const store = getStore(storage);
    store[key] = { t: Date.now(), v: value };
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (store[a]?.t || 0) - (store[b]?.t || 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach(stale => { delete store[stale]; });
    }
    storage.setItem(CACHE_KEY, JSON.stringify(store));
  } catch {
    // Quota or serialization trouble: drop the whole cache rather than let a
    // wedged entry make every future write fail the same way.
    try {
      storage.removeItem(CACHE_KEY);
    } catch {
      // Storage is entirely unavailable; caching is simply off.
    }
  }
}
