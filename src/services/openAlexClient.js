const OPENALEX_HOST = 'api.openalex.org';
const DEFAULT_MAILTO = 'app@papertok.io';
const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AUTO_RETRY_DELAY_MS = 5000;
const STORAGE_KEY = 'papertok_openalex_cache_v1';
const MAX_PERSISTENT_ENTRIES = 200;
/**
 * How big the blob may grow, and how big one entry may be, in characters.
 *
 * Measured after one author page on the production build: 3.5 million
 * characters, most of it two raw OpenAlex works pages — thirty works each,
 * with inverted-index abstracts, authorships and locations — against a
 * localStorage quota of about five million. At that size every read was a
 * copy and every write a serialisation of the lot. The works and authors
 * pages now persist what the app made of them (`persistentSlim`, below), and
 * these caps keep the blob within a size a phone reads in a few
 * milliseconds: the lowest-priority, oldest entries go first, and an entry
 * that alone would not fit is not persisted at all.
 */
const MAX_PERSISTENT_CHARS = 1_200_000;
const MAX_PERSISTENT_ENTRY_CHARS = 150_000;
const MAX_RESPONSE_CACHE_ENTRIES = 40;

const clonePersistentData = (data) => {
  if (data === null || typeof data !== 'object') return data;
  if (typeof structuredClone === 'function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
};

const persistentPriority = (key) => (key.startsWith('recent-impact:') || key.startsWith('institution-impact:')
  ? 2
  : key.startsWith('entity:') ? 1 : 0);

/**
 * The store cut down to its caps: at most `MAX_PERSISTENT_ENTRIES` entries
 * and `MAX_PERSISTENT_CHARS` characters, the lowest-priority, oldest entries
 * dropped first. `sizes` remembers each entry's serialised length by key so
 * the cap is kept without serialising the blob to measure it; `newSize` is
 * the entry just written.
 */
function trimPersistentStore(store, sizes) {
  const entries = Object.entries(store).sort(([keyA, a], [keyB, b]) =>
    persistentPriority(keyB) - persistentPriority(keyA) || (b.savedAt || 0) - (a.savedAt || 0));
  const kept = [];
  let total = 0;
  for (const [key, entry] of entries) {
    let size = sizes.get(key);
    if (size === undefined) {
      size = JSON.stringify(entry).length;
      sizes.set(key, size);
    }
    if (kept.length >= MAX_PERSISTENT_ENTRIES || total + size > MAX_PERSISTENT_CHARS) {
      sizes.delete(key);
      continue;
    }
    kept.push([key, entry]);
    total += size;
  }
  return Object.fromEntries(kept);
}

const getDefaultStorage = () => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

const defaultSleep = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs));

export class OpenAlexRequestError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'OpenAlexRequestError';
    this.code = options.code || 'request_failed';
    this.status = options.status || null;
    this.retryAfterMs = options.retryAfterMs || 0;
  }
}

export function isOpenAlexRateLimitError(error) {
  let current = error;
  while (current) {
    if (current.code === 'rate_limited' || current.status === 429) return true;
    current = current.cause;
  }
  return false;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

// Two upstream headers decide how long the client stops calling OpenAlex, and
// neither can be trusted at face value. `x-ratelimit-reset` has no fixed unit:
// the `x-` convention (GitHub's) is an epoch in seconds, a plain delta is just
// as common, and nothing on the wire says which arrived. Read an epoch as a
// delta and ~1.77e9 becomes a 56-year backoff -- `rateLimitedUntil` lands in
// the far future, every later call throws before touching the network, and the
// only thing that clears it is a 200 that can no longer happen. `retry-after`
// has the unit pinned but not the size, and it comes from whatever proxy sits
// in front of the API.
//
// So: a value past the threshold is an instant, anything below it is a delta,
// and both branches leave through the same clamp. A day is longer than any
// real OpenAlex window and short enough that a bogus header costs one session,
// not the tab.
const RATE_LIMIT_EPOCH_THRESHOLD_S = 1e9; // ~2001-09-09: no sane delta reaches it
const MAX_RATE_LIMIT_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 60_000;

// Only ever called for a response that IS rate limited, so a delay that comes
// out at zero or below -- an epoch already in the past, a negative header --
// means "unusable", not "not limited": falling back to the default keeps the
// backoff a 429 legitimately asked for.
function boundRateLimitDelay(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return DEFAULT_RATE_LIMIT_DELAY_MS;
  return Math.min(delayMs, MAX_RATE_LIMIT_DELAY_MS);
}

export function getOpenAlexRateLimitDelay(response, now = Date.now()) {
  if (!response) return 0;
  const remainingHeader = response.headers.get('x-ratelimit-remaining');
  const remaining = remainingHeader === null ? null : Number(remainingHeader);
  const isLimited = response.status === 429
    || (response.status === 403 && remaining !== null && remaining === 0);
  if (!isLimited) return 0;

  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now);
  if (retryAfterMs > 0) return boundRateLimitDelay(retryAfterMs);

  const resetSeconds = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return boundRateLimitDelay(resetSeconds > RATE_LIMIT_EPOCH_THRESHOLD_S
      ? resetSeconds * 1000 - now
      : resetSeconds * 1000);
  }
  return DEFAULT_RATE_LIMIT_DELAY_MS;
}

// Since February 2026 OpenAlex requires an API key and bills each call against a
// daily budget; the `mailto` polite pool it replaced no longer buys anything.
// The key is money, so it cannot ship in the bundle: every OpenAlex request is
// routed through the Worker, which holds it. Every caller in the app reaches
// OpenAlex through this function, so redirecting here redirects all of them.
//
// With no Worker configured -- local development -- the request still goes
// direct on the anonymous allowance, which is exactly what it did before.
export function identifyOpenAlexUrl(rawUrl, mailto = DEFAULT_MAILTO, apiBase = PAPER_API_BASE) {
  const url = new URL(rawUrl);
  if (url.hostname !== OPENALEX_HOST) return url.toString();

  if (!apiBase) {
    if (!url.searchParams.has('mailto')) url.searchParams.set('mailto', mailto);
    return url.toString();
  }

  const proxied = new URL(`${String(apiBase).replace(/\/$/, '')}/openalex${url.pathname}`);
  url.searchParams.forEach((value, name) => {
    // The Worker attaches the credential; one arriving from here would only be
    // dropped, and `mailto` is dead weight.
    if (name !== 'api_key' && name !== 'mailto') proxied.searchParams.set(name, value);
  });
  return proxied.toString();
}

export class OpenAlexClient {
  constructor(options = {}) {
    // Safari/WebKit requires the native fetch receiver to remain the global
    // object. Calling an unbound window.fetch as an instance method can throw
    // "Illegal invocation" before any network request is made.
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.storage = options.storage === undefined ? getDefaultStorage() : options.storage;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.random = options.random || Math.random;
    this.mailto = options.mailto || DEFAULT_MAILTO;
    this.apiBase = options.apiBase ?? PAPER_API_BASE;
    this.maxConcurrent = options.maxConcurrent || 2;
    this.activeRequests = 0;
    this.queue = [];
    this.inFlight = new Map();
    this.responseCache = new Map();
    this.rateLimitedUntil = 0;
    this.persistentStore = null;
    this.persistentSizes = new Map();
    this.persistentFlush = null;
    this.persistentDirty = false;
    // Another tab's write to the key is the one way the blob changes behind
    // this tab's back; the event does not fire for this tab's own writes.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      && this.storage && this.storage === window.localStorage) {
      window.addEventListener('storage', (event) => {
        if (event.key === null || event.key === STORAGE_KEY) this.forgetPersistentStore();
      });
    }
  }

  getHealth() {
    const retryAfterMs = Math.max(0, this.rateLimitedUntil - this.now());
    return {
      available: retryAfterMs === 0,
      rateLimited: retryAfterMs > 0,
      retryAfterMs,
      queuedRequests: this.queue.length,
      activeRequests: this.activeRequests,
    };
  }

  clearMemoryCache() {
    this.responseCache.clear();
  }

  /**
   * The persistent store, read and parsed once, not once per read.
   *
   * Every read used to `getItem` the whole blob — two hundred entries, among
   * them works pages and search responses — and `JSON.parse` it, and the feed
   * reads it once per paper (`enrichment:<id>`, openAlexService.js) each time
   * it mounts. Profiled on the production build with the CPU at a quarter
   * speed (390×844, back from an author to a thirteen-card feed):
   * `readPersistent` was the largest JavaScript cost of the return, 92 ms in
   * one run and 422 ms in another, most of it inside the entrance animation.
   * Parsing once and still fetching the string each time left 115 ms: at that
   * size the copy out of storage is the cost. So the parsed store is kept,
   * and let go of when another tab writes the key (the `storage` event, which
   * fires only in the tabs that did not write) or when asked
   * (`forgetPersistentStore`).
   */
  readPersistentStore() {
    if (this.persistentStore) return this.persistentStore;
    this.persistentStore = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}');
    return this.persistentStore;
  }

  forgetPersistentStore() {
    this.persistentStore = null;
    this.persistentSizes = new Map();
  }

  readPersistent(key, maxAgeMs = Number.POSITIVE_INFINITY) {
    if (!this.storage || !key) return null;
    try {
      const store = this.readPersistentStore();
      const entry = store[key];
      if (!entry || !Number.isFinite(entry.savedAt)) return null;
      const ageMs = Math.max(0, this.now() - entry.savedAt);
      return {
        // A copy, as a fresh parse used to hand out: the store is shared
        // across reads now, and a caller that edits what it got must not
        // edit the cache.
        data: clonePersistentData(entry.data),
        savedAt: entry.savedAt,
        ageMs,
        stale: ageMs > maxAgeMs,
      };
    } catch {
      return null;
    }
  }

  /**
   * A write lands in the remembered store at once and reaches storage on the
   * next microtask, so a burst of writes — the enrichment batch writes two
   * keys per work, sixty in a row for a works page — serialises the blob
   * once instead of sixty times. Reads in between see the writes: they read
   * the memory, not the storage.
   */
  writePersistent(key, data) {
    if (!this.storage || !key) return;
    try {
      const entry = { data, savedAt: this.now() };
      const size = JSON.stringify(entry).length;
      if (size > MAX_PERSISTENT_ENTRY_CHARS) return;
      const store = { ...this.readPersistentStore(), [key]: entry };
      this.persistentSizes.set(key, size);
      this.persistentStore = trimPersistentStore(store, this.persistentSizes);
      this.persistentDirty = true;
      if (!this.persistentFlush) {
        this.persistentFlush = Promise.resolve().then(() => this.flushPersistent());
      }
    } catch {
      // Storage can be unavailable or full; network behavior must remain unaffected.
    }
  }

  /** Writes the remembered store to storage now. */
  flushPersistent() {
    this.persistentFlush = null;
    if (!this.storage || !this.persistentStore || !this.persistentDirty) return;
    this.persistentDirty = false;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.persistentStore));
    } catch {
      // Storage can be unavailable or full; the memory copy still serves this tab.
    }
  }

  async fetch(rawUrl, options = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new OpenAlexRequestError('Fetch is not available', { code: 'network_error' });
    }

    const url = identifyOpenAlexUrl(rawUrl, this.mailto, this.apiBase);
    const method = (options.method || 'GET').toUpperCase();
    const requestKey = `${method}:${url}`;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cached = this.responseCache.get(requestKey);
    const now = this.now();

    if (method === 'GET' && cached && now - cached.savedAt <= cacheTtlMs) {
      return cached.response.clone();
    }

    const retryAfterMs = Math.max(0, this.rateLimitedUntil - now);
    if (retryAfterMs > 0) {
      if (options.staleIfError && cached) return cached.response.clone();
      throw new OpenAlexRequestError('OpenAlex rate limit is active', {
        code: 'rate_limited',
        status: 429,
        retryAfterMs,
      });
    }

    let sharedRequest = method === 'GET' ? this.inFlight.get(requestKey) : null;
    if (!sharedRequest) {
      sharedRequest = this.enqueue(() => this.performFetch(url, options));
      if (method === 'GET') {
        this.inFlight.set(requestKey, sharedRequest);
        sharedRequest.finally(() => this.inFlight.delete(requestKey)).catch(() => {});
      }
    }

    try {
      const response = await sharedRequest;
      if (method === 'GET' && response.ok && cacheTtlMs > 0) {
        this.responseCache.set(requestKey, {
          response: response.clone(),
          savedAt: this.now(),
        });
        if (this.responseCache.size > MAX_RESPONSE_CACHE_ENTRIES) {
          const oldestKey = [...this.responseCache.entries()]
            .sort(([, a], [, b]) => a.savedAt - b.savedAt)[0]?.[0];
          if (oldestKey) this.responseCache.delete(oldestKey);
        }
      }
      return response.clone();
    } catch (error) {
      if (options.staleIfError && cached) return cached.response.clone();
      throw error;
    }
  }

  async json(rawUrl, options = {}) {
    const persistentKey = options.persistentKey;
    const persistentTtlMs = options.persistentTtlMs ?? Number.POSITIVE_INFINITY;
    const cached = persistentKey ? this.readPersistent(persistentKey, persistentTtlMs) : null;

    if (cached && !cached.stale) {
      return options.returnMeta
        ? { data: cached.data, meta: { source: 'persistent-cache', stale: false, savedAt: cached.savedAt } }
        : cached.data;
    }

    try {
      const response = await this.fetch(rawUrl, options);
      if (!response.ok) {
        throw new OpenAlexRequestError(`OpenAlex API error: ${response.status}`, {
          code: 'http_error',
          status: response.status,
        });
      }
      const fetched = await response.json();
      // `persistentSlim` turns the response into what is worth keeping — a
      // works page as the papers the app made of it, not the raw work objects
      // with their inverted-index abstracts — and what a cache hit returns is
      // that same shape, so the caller sees one shape either way.
      const data = persistentKey && typeof options.persistentSlim === 'function'
        ? options.persistentSlim(fetched)
        : fetched;
      if (persistentKey) this.writePersistent(persistentKey, data);
      return options.returnMeta
        ? { data, meta: { source: 'network', stale: false, savedAt: this.now() } }
        : data;
    } catch (error) {
      if (options.staleIfError && cached) {
        return options.returnMeta
          ? { data: cached.data, meta: { source: 'persistent-cache', stale: true, savedAt: cached.savedAt } }
          : cached.data;
      }
      throw error;
    }
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.drainQueue();
    });
  }

  drainQueue() {
    while (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeRequests += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeRequests -= 1;
          this.drainQueue();
        });
    }
  }

  async performFetch(url, options) {
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let lastResponse = null;
    const activeRetryAfterMs = Math.max(0, this.rateLimitedUntil - this.now());

    if (options.signal?.aborted) {
      throw new OpenAlexRequestError('OpenAlex request was cancelled', {
        code: 'aborted',
      });
    }

    if (activeRetryAfterMs > 0) {
      throw new OpenAlexRequestError('OpenAlex rate limit is active', {
        code: 'rate_limited',
        status: 429,
        retryAfterMs: activeRetryAfterMs,
      });
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.fetchOnce(url, { ...options, timeoutMs });
        lastResponse = response;

        const retryAfterMs = getOpenAlexRateLimitDelay(response, this.now());
        if (retryAfterMs > 0) {
          this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + retryAfterMs);

          if (attempt < retries && retryAfterMs <= MAX_AUTO_RETRY_DELAY_MS) {
            await this.sleep(this.withJitter(retryAfterMs));
            continue;
          }

          throw new OpenAlexRequestError('OpenAlex rate limit reached', {
            code: 'rate_limited',
            status: 429,
            retryAfterMs,
          });
        }

        if (response.status >= 500 && attempt < retries) {
          await this.sleep(this.withJitter(350 * (2 ** attempt)));
          continue;
        }

        if (response.ok) this.rateLimitedUntil = 0;
        return response;
      } catch (error) {
        if (isOpenAlexRateLimitError(error)) throw error;
        if (error.code === 'aborted') throw error;
        if (attempt >= retries || error.code === 'timeout') throw error;
        await this.sleep(this.withJitter(350 * (2 ** attempt)));
      }
    }

    return lastResponse;
  }

  async fetchOnce(url, options) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternalSignal();
    else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    const fetchOptions = { ...options };
    ['timeoutMs', 'cacheTtlMs', 'staleIfError', 'retries', 'persistentKey', 'persistentTtlMs', 'returnMeta']
      .forEach(key => delete fetchOptions[key]);

    try {
      const response = await this.fetchImpl(url, { ...fetchOptions, signal: controller.signal });
      // Drained here, inside the deadline, and handed back as a fresh Response.
      // `json()` reads the body far from this function and `fetch()` caches and
      // clones it on the way, so leaving the read outside meant the timeout
      // stopped covering the one part of the exchange that actually stalls.
      return await bufferResponse(response);
    } catch (error) {
      if (controller.signal.aborted) {
        if (externalSignal?.aborted) {
          throw new OpenAlexRequestError('OpenAlex request was cancelled', {
            code: 'aborted',
            cause: error,
          });
        }
        throw new OpenAlexRequestError('OpenAlex request timed out', {
          code: 'timeout',
          cause: error,
        });
      }
      throw new OpenAlexRequestError('OpenAlex network request failed', {
        code: 'network_error',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    }
  }

  withJitter(delayMs) {
    return Math.round(delayMs * (0.9 + this.random() * 0.2));
  }
}

// 204, 205 and 304 carry no body, and the `Response` constructor refuses one for
// them, so those are handed straight back.
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

async function bufferResponse(response) {
  if (BODYLESS_STATUSES.has(response.status) || !response.body) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const openAlexClient = new OpenAlexClient();

export const openAlexFetch = (url, options) => openAlexClient.fetch(url, options);
export const openAlexJson = (url, options) => openAlexClient.json(url, options);
export const getOpenAlexHealth = () => openAlexClient.getHealth();
export const readOpenAlexPersistent = (key, maxAgeMs) => openAlexClient.readPersistent(key, maxAgeMs);
export const writeOpenAlexPersistent = (key, data) => openAlexClient.writePersistent(key, data);
