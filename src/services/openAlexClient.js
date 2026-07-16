const OPENALEX_HOST = 'api.openalex.org';
const DEFAULT_MAILTO = 'app@papertok.io';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_AUTO_RETRY_DELAY_MS = 5000;
const STORAGE_KEY = 'papertok_openalex_cache_v1';
const MAX_PERSISTENT_ENTRIES = 200;
const MAX_RESPONSE_CACHE_ENTRIES = 40;

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

export function identifyOpenAlexUrl(rawUrl, mailto = DEFAULT_MAILTO) {
  const url = new URL(rawUrl);
  if (url.hostname === OPENALEX_HOST && !url.searchParams.has('mailto')) {
    url.searchParams.set('mailto', mailto);
  }
  return url.toString();
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
    this.maxConcurrent = options.maxConcurrent || 2;
    this.activeRequests = 0;
    this.queue = [];
    this.inFlight = new Map();
    this.responseCache = new Map();
    this.rateLimitedUntil = 0;
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

  readPersistent(key, maxAgeMs = Number.POSITIVE_INFINITY) {
    if (!this.storage || !key) return null;
    try {
      const store = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}');
      const entry = store[key];
      if (!entry || !Number.isFinite(entry.savedAt)) return null;
      const ageMs = Math.max(0, this.now() - entry.savedAt);
      return {
        data: entry.data,
        savedAt: entry.savedAt,
        ageMs,
        stale: ageMs > maxAgeMs,
      };
    } catch {
      return null;
    }
  }

  writePersistent(key, data) {
    if (!this.storage || !key) return;
    try {
      const store = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}');
      store[key] = { data, savedAt: this.now() };

      const entries = Object.entries(store)
        .sort(([keyA, a], [keyB, b]) => {
          const priority = key => key.startsWith('institution-impact:')
            ? 2
            : key.startsWith('entity:') ? 1 : 0;
          return priority(keyB) - priority(keyA) || (b.savedAt || 0) - (a.savedAt || 0);
        })
        .slice(0, MAX_PERSISTENT_ENTRIES);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Storage can be unavailable or full; network behavior must remain unaffected.
    }
  }

  async fetch(rawUrl, options = {}) {
    if (typeof this.fetchImpl !== 'function') {
      throw new OpenAlexRequestError('Fetch is not available', { code: 'network_error' });
    }

    const url = identifyOpenAlexUrl(rawUrl, this.mailto);
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
      const data = await response.json();
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

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), this.now()) || 60000;
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
        if (attempt >= retries || error.code === 'timeout') throw error;
        await this.sleep(this.withJitter(350 * (2 ** attempt)));
      }
    }

    return lastResponse;
  }

  async fetchOnce(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    const fetchOptions = { ...options };
    ['timeoutMs', 'cacheTtlMs', 'staleIfError', 'retries', 'persistentKey', 'persistentTtlMs', 'returnMeta']
      .forEach(key => delete fetchOptions[key]);

    try {
      return await this.fetchImpl(url, { ...fetchOptions, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
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
    }
  }

  withJitter(delayMs) {
    return Math.round(delayMs * (0.9 + this.random() * 0.2));
  }
}

export const openAlexClient = new OpenAlexClient();

export const openAlexFetch = (url, options) => openAlexClient.fetch(url, options);
export const openAlexJson = (url, options) => openAlexClient.json(url, options);
export const getOpenAlexHealth = () => openAlexClient.getHealth();
export const readOpenAlexPersistent = (key, maxAgeMs) => openAlexClient.readPersistent(key, maxAgeMs);
export const writeOpenAlexPersistent = (key, data) => openAlexClient.writePersistent(key, data);
