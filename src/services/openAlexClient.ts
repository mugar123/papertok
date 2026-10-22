export interface OpenAlexRequestOptions extends Omit<RequestInit, 'priority'> {
  timeoutMs?: number;
  cacheTtlMs?: number;
  staleIfError?: boolean;
  retries?: number;
  priority?: boolean;
}
export interface OpenAlexJsonOptions<T, Source = T> extends OpenAlexRequestOptions {
  persistentKey?: string;
  persistentTtlMs?: number;
  persistentSlim?: (data: Source) => T;
  returnMeta?: boolean;
}
export interface OpenAlexMeta { source: string; stale: boolean; savedAt: number }
interface PersistentEntry { data: unknown; savedAt: number }
interface QueuedRequest {
  task: () => Promise<Response>;
  resolve: (response: Response | PromiseLike<Response>) => void;
  reject: (reason: unknown) => void;
  priority: boolean;
}
interface ClientOptions {
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
  sleep?: (delayMs: number) => PromiseLike<unknown>;
  random?: () => number;
  mailto?: string;
  apiBase?: string;
  maxConcurrent?: number;
}

const OPENALEX_HOST = 'api.openalex.org';
const DEFAULT_MAILTO = 'app@papertok.io';
const PAPER_API_BASE = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
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

const clonePersistentData = <T>(data: T): T => {
  if (data === null || typeof data !== 'object') return data;
  if (typeof structuredClone === 'function') return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
};

const persistentPriority = (key: string) => (key.startsWith('recent-impact:') || key.startsWith('institution-impact:')
  ? 2
  : key.startsWith('entity:') ? 1 : 0);

/**
 * The store cut down to its caps: at most `MAX_PERSISTENT_ENTRIES` entries
 * and `MAX_PERSISTENT_CHARS` characters, the lowest-priority, oldest entries
 * dropped first. `sizes` remembers each entry's serialised length by key so
 * the cap is kept without serialising the blob to measure it; `newSize` is
 * the entry just written.
 */
function trimPersistentStore(store: Record<string, PersistentEntry>, sizes: Map<string, number>) {
  const entries = Object.entries(store).sort(([keyA, a], [keyB, b]) =>
    persistentPriority(keyB) - persistentPriority(keyA) || (b.savedAt || 0) - (a.savedAt || 0));
  const kept: Array<[string, PersistentEntry]> = [];
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

const defaultSleep = (delayMs: number|undefined) => new Promise(resolve => setTimeout(resolve, delayMs));

export class OpenAlexRequestError extends Error {
  declare code: string;
  declare status: number | null;
  declare retryAfterMs: number;
  constructor(message: string | undefined, options: { cause?: unknown; code?: string; status?: number; retryAfterMs?: number } = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'OpenAlexRequestError';
    this.code = options.code || 'request_failed';
    this.status = options.status || null;
    this.retryAfterMs = options.retryAfterMs || 0;
  }
}

export function isOpenAlexRateLimitError(error: unknown) {
  let current = error as { code?: string; status?: number; cause?: unknown } | null | undefined;
  while (current) {
    if (current.code === 'rate_limited' || current.status === 429) return true;
    current = current.cause as typeof current;
  }
  return false;
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()) {
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
// Set by the Worker on its own budget refusals (`OPENALEX_BUDGET_TIER_HEADER`
// in worker/provider-runtime.ts), never by OpenAlex.
const BUDGET_TIER_HEADER = 'x-papertok-budget-tier';

// Only ever called for a response that IS rate limited, so a delay that comes
// out at zero or below -- an epoch already in the past, a negative header --
// means "unusable", not "not limited": falling back to the default keeps the
// backoff a 429 legitimately asked for.
function boundRateLimitDelay(delayMs: number) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return DEFAULT_RATE_LIMIT_DELAY_MS;
  return Math.min(delayMs, MAX_RATE_LIMIT_DELAY_MS);
}

export function getOpenAlexRateLimitDelay(response: Pick<Response, 'headers' | 'status'> | null | undefined, now = Date.now()) {
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
export function identifyOpenAlexUrl(rawUrl: string | URL, mailto = DEFAULT_MAILTO, apiBase = PAPER_API_BASE) {
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
  declare fetchImpl: typeof fetch | undefined;
  declare storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  declare now: () => number;
  declare sleep: (delayMs: number) => PromiseLike<unknown>;
  declare random: () => number;
  declare mailto: string;
  declare apiBase: string;
  declare maxConcurrent: number;
  declare activeRequests: number;
  declare activePriorityRequests: number;
  declare queue: QueuedRequest[];
  declare inFlight: Map<string, Promise<Response>>;
  declare responseCache: Map<string, { response: Response; savedAt: number }>;
  declare rateLimitedUntil: number;
  declare persistentStore: Record<string, PersistentEntry> | null;
  declare persistentSizes: Map<string, number>;
  declare persistentFlush: Promise<void> | null;
  declare persistentDirty: boolean;
  constructor(options: ClientOptions = {}) {
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
    this.activePriorityRequests = 0;
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
  readPersistentStore(): Record<string, PersistentEntry> {
    if (this.persistentStore) return this.persistentStore!;
    this.persistentStore = JSON.parse(this.storage!.getItem(STORAGE_KEY) || '{}');
    return this.persistentStore!;
  }

  forgetPersistentStore() {
    this.persistentStore = null;
    this.persistentSizes = new Map();
  }

  readPersistent<T = unknown>(key: string | number, maxAgeMs = Number.POSITIVE_INFINITY) {
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
        data: clonePersistentData(entry.data) as T,
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
  writePersistent(key: string, data: unknown) {
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

  async fetch(rawUrl: string | URL, options: OpenAlexRequestOptions = {}) {
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
      sharedRequest = this.enqueue(() => this.performFetch(url, options), { priority: options.priority === true });
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

  async json<T = unknown, Source = T>(rawUrl: string | URL, options: OpenAlexJsonOptions<T, Source> & { returnMeta: true }): Promise<{ data: T; meta: OpenAlexMeta }>;
  async json<T = unknown, Source = T>(rawUrl: string | URL, options?: OpenAlexJsonOptions<T, Source> & { returnMeta?: false }): Promise<T>;
  async json<T = unknown, Source = T>(rawUrl: string | URL, options?: OpenAlexJsonOptions<T, Source>): Promise<T | { data: T; meta: OpenAlexMeta }>;
  async json<T = unknown, Source = T>(rawUrl: string | URL, options: OpenAlexJsonOptions<T, Source> = {}): Promise<T | { data: T; meta: OpenAlexMeta }> {
    const persistentKey = options.persistentKey;
    const persistentTtlMs = options.persistentTtlMs ?? Number.POSITIVE_INFINITY;
    const cached = persistentKey ? this.readPersistent<T>(persistentKey, persistentTtlMs) : null;

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
      const fetched: Source | T = await response.json();
      // `persistentSlim` turns the response into what is worth keeping — a
      // works page as the papers the app made of it, not the raw work objects
      // with their inverted-index abstracts — and what a cache hit returns is
      // that same shape, so the caller sees one shape either way.
      const data = persistentKey && typeof options.persistentSlim === 'function'
        ? options.persistentSlim(fetched as Source)
        : fetched as T;
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

  // `priority` puts the task at the head of the queue. The queue is FIFO and
  // two wide, and it is shared by everything that asks OpenAlex: the feed's
  // one search used to enter it behind every followed-entity lookup and wait
  // out their timeouts (measured 2026-09-16: 2.3 s late on a cold entry, 10 s
  // in the control run) — past the feed's own first-paint budget.
  enqueue(task: () => Promise<Response>, { priority = false } = {}) {
    return new Promise<Response>((resolve, reject) => {
      const item = { task, resolve, reject, priority };
      if (priority) this.queue.unshift(item);
      else this.queue.push(item);
      this.drainQueue();
    });
  }

  // The priority lane is one slot wider than the queue. Jumping the queue is
  // not enough when every slot is held by an optional lookup that is merely in
  // flight: measured 2026-09-16 with two followed-entity lookups active, the
  // feed's search still waited their whole 3.5 s budget for a slot. A request
  // the screen is waiting on gets out at once. Other requests count only each
  // other against the queue's width: counted with the feed's topic page, they
  // had one slot while it was in flight, and the fourth followed-entity lookup
  // ended past their shared 3.5 s budget (modelled 2026-10-21). The provider
  // still sees at most one request more than the queue's width.
  hasRoomFor(item: Pick<QueuedRequest, 'priority'>) {
    if (this.activeRequests >= this.maxConcurrent + 1) return false;
    return item.priority || this.activeRequests - this.activePriorityRequests < this.maxConcurrent;
  }

  drainQueue() {
    while (this.queue.length > 0 && this.hasRoomFor(this.queue[0])) {
      const item = this.queue.shift()!;
      this.activeRequests += 1;
      if (item.priority) this.activePriorityRequests += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeRequests -= 1;
          if (item.priority) this.activePriorityRequests -= 1;
          this.drainQueue();
        });
    }
  }

  async performFetch(url: string, options: OpenAlexRequestOptions) {
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
          // A refusal naming a budget tier is the Worker keeping the day's
          // OpenAlex budget for other kinds of request (PAP-88): an opened
          // paper, a free lookup by id or a feed lane may still be served, so
          // only this request fails. Without the header OpenAlex refused the
          // key itself, and the whole tab waits.
          if (!response.headers.has(BUDGET_TIER_HEADER)) {
            this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + retryAfterMs);
          }
          // Not asked again, however short the wait: every ask is a miss the
          // Worker reserves against the day's OpenAlex ceiling, and a refusal
          // says that budget is what is short. The caller fills the page from
          // the other sources and asks again once the wait has passed.
          throw new OpenAlexRequestError('OpenAlex rate limit reached', {
            code: 'rate_limited',
            status: 429,
            retryAfterMs,
          });
        }

        // A 504 is the Worker reporting that OpenAlex stalled through its whole
        // deadline after receiving the call: asking again bills it again.
        if (response.status >= 500 && response.status !== 504 && attempt < retries) {
          await this.sleep(this.withJitter(350 * (2 ** attempt)));
          continue;
        }

        if (response.ok) this.rateLimitedUntil = 0;
        return response;
      } catch (error) {
        if (isOpenAlexRateLimitError(error)) throw error;
        if ((error as OpenAlexRequestError).code === 'aborted') throw error;
        if (attempt >= retries || (error as OpenAlexRequestError).code === 'timeout') throw error;
        await this.sleep(this.withJitter(350 * (2 ** attempt)));
      }
    }

    return lastResponse!;
  }

  async fetchOnce(url: string, options: OpenAlexRequestOptions) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternalSignal();
    else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs);
    const fetchOptions: OpenAlexRequestOptions & Record<string, unknown> = { ...options };
    ['timeoutMs', 'cacheTtlMs', 'staleIfError', 'retries', 'persistentKey', 'persistentTtlMs', 'returnMeta', 'priority']
      .forEach(key => delete fetchOptions[key]);

    try {
      const response = await this.fetchImpl!(url, { ...fetchOptions, signal: controller.signal } as RequestInit);
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

  withJitter(delayMs: number) {
    return Math.round(delayMs * (0.9 + this.random() * 0.2));
  }
}

// 204, 205 and 304 carry no body, and the `Response` constructor refuses one for
// them, so those are handed straight back.
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

async function bufferResponse(response: Response) {
  if (BODYLESS_STATUSES.has(response.status) || !response.body) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const openAlexClient = new OpenAlexClient();

export const openAlexFetch = (url: string | URL, options?: OpenAlexRequestOptions) => openAlexClient.fetch(url, options);
export const openAlexJson = (<T = unknown, Source = T>(url: string | URL, options?: OpenAlexJsonOptions<T, Source>) => openAlexClient.json<T, Source>(url, options)) as OpenAlexClient['json'];
export const getOpenAlexHealth = () => openAlexClient.getHealth();
export const readOpenAlexPersistent = <T = unknown>(key: string, maxAgeMs?: number) => openAlexClient.readPersistent<T>(key, maxAgeMs);
export const writeOpenAlexPersistent = (key: string, data: unknown) => openAlexClient.writePersistent(key, data);
