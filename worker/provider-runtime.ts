import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { QuotaRequest } from './request-quota-ledger.ts';

export interface UpstreamError extends Error {
  status?: number;
  retryAfter?: string;
  code?: string;
}

export interface MinuteCeiling {
  namespace: string;
  variable: keyof WorkerEnv;
  fallback: number;
  paced?: boolean;
}

interface CacheOptions {
  identity?: Pick<VerifiedIdentity, 'uid'> | null;
  canonicalParams?: Record<string, unknown>;
  openAlexCalls?: number;
  // The answer belongs to one reader: its key must name them, and the browser
  // is told not to store or share it.
  personal?: boolean;
}

type QuotaGate = { error?: Response; reservation?: QuotaRequest };

import { allowedOrigins, corsHeaders, json } from './http.ts';
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';
import { awaitUpstreamSlot, PACE_RETRY_AFTER_SECONDS } from './upstream-pace.ts';

// The default upstream deadlines for the provider modules; some modules set their
// own. The ceiling on any of them is what the browser is willing to wait: the
// client gives the specialist sources 10 s, so a Worker that outlasts that is
// answering nobody.
const UPSTREAM_TIMEOUT_MS = 8000;
export const SOURCE_UPSTREAM_TIMEOUT_MS = 6000;

// What a degraded answer is worth. A provider hiccup that lasts a second used to
// own its cache entry for the entire normal TTL -- six hours for physics, seven
// days for the citation graph -- so a single 500 blanked one query for everybody.
// Two minutes is long enough to absorb the retry burst of a feed fan-out and
// short enough that recovery is invisible.
export const DEGRADED_CACHE_SECONDS = 120;
const DEFAULT_OPENALEX_GLOBAL_MINUTE_LIMIT = 300;
// The budget OpenAlex bills against is *daily* ($1/day, ~10.000 calls measured on
// `/health/openalex`), and until now the only ceiling was per minute: 300/min is
// 432.000/day, which bounds nothing. This leaves ~2.000 calls of headroom for the
// digest cron -- which spends outside this ledger -- and the health probe.
const DEFAULT_OPENALEX_GLOBAL_DAILY_LIMIT = 8_000;
// What a cold answer costs OpenAlex, per route, worst case. Reserved in one go
// before the work starts: a route that spends nine calls and reserves one is a
// route the daily ceiling does not actually cover.
export const OPENALEX_CALLS = Object.freeze({
  relay: 1,
  // One `works/doi:` lookup, then up to two batches of twenty for each of the two
  // reference filters and the same again for citations.
  citationGraph: 9,
});
export const SOURCE_CACHE_SECONDS = {
  biorxiv: 10 * 60,
  europepmc: 30 * 60,
  // Ten minutes is what the browser cache in `src/utils/sourceCache.ts` already
  // considered invisible staleness for a paper feed, and it is short enough that
  // a batch whose efetch half failed heals on its own rather than sitting behind
  // a six-hour TTL.
  pubmed: 10 * 60,
  s2: 30 * 60,
  core: 6 * 60 * 60,
  osti: 60 * 60,
  nasa: 60 * 60,
  physics: 6 * 60 * 60,
  scopus: 6 * 60 * 60,
  openreview: 30 * 60,
  huggingface: 15 * 60,
  icite: 24 * 60 * 60,
  huggingFaceResources: 7 * 24 * 60 * 60,
};
const DEFAULT_PROVIDER_USER_MINUTE_LIMIT = 60;
const DEFAULT_PROVIDER_GLOBAL_MINUTE_LIMIT = 2_000;

// Ceilings for routes whose upstream limit is per provider rather than per user,
// and which the guest feed reads, so they cannot be gated behind an identity the
// way the credential-backed routes are. This is the same trade `/openalex/*`
// makes: origin gate plus edge cache plus a global per-minute ceiling reserved
// only after a cache miss.
//
// `/related` and `/recommendations` share the `s2` namespace with `/sources/s2`
// on purpose. All three spend the same Semantic Scholar allowance, and a
// ceiling that only covered one of them would leave alive exactly the failure
// this replaces -- a limiter that counts per caller instead of per provider.
//
// `paced` puts a route on the one-a-second beat of `upstream-pace.js` under its
// minute ceiling. Semantic Scholar is the provider that needs it: it admits one
// request per second per key, and a per-minute ceiling of sixty is the same
// average with no say over which second. PubMed is not paced: the key buys ten
// a second and `withPubmedRetry` absorbs the burst.
const DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT = 60;
const DEFAULT_S2_GLOBAL_MINUTE_LIMIT = 60;
const SHARED_MINUTE_CEILINGS: Readonly<Partial<Record<string, MinuteCeiling>>> = Object.freeze({
  // Each miss spends three E-utilities calls, six if every one is refused once
  // and retried -- what NCBI actually refuses is per-second bursts, which no
  // per-minute ceiling can see; `withPubmedRetry` is what absorbs those. So 60
  // route misses a minute are at most 360 calls, and `NCBI_API_KEY` (10 req/s)
  // buys 100 misses a minute at that worst case. 60 is a deliberate margin, not
  // the anonymous 3 req/s it once mirrored, and it has never been the binding
  // limit (151/151 reservations accepted, 2026-09-01).
  '/sources/pubmed': { namespace: 'pubmed', variable: 'PUBMED_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT },
  '/sources/s2': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT, paced: true },
  '/related': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT, paced: true },
  '/recommendations': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT, paced: true },
});

// The key is built from the values the handler is about to send upstream, never
// from the ones that arrived. Those are two different things everywhere in this
// file -- `limit=99` is clamped to 10, a DOI is lowercased, a filter is
// trimmed -- and keying on the raw ones made every variant of a discarded or
// normalised parameter a fresh miss for one identical upstream call. On the
// routes OpenAlex bills that was money: every spelling of one DOI on
// `/citation-graph` paid for the same calls again.
//
// The contract this puts on callers is the reverse of the old parameter
// allowlist, and stricter: whatever affects the answer must appear here, because
// nothing else does. Anything absent is not merely un-keyed, it is shared.
//
// The origin is deliberately not in the key. It used to be, because the stored
// response carries `access-control-allow-origin` and the Cache API ignores
// `Vary`, so an entry stored under one origin's header would have been served,
// header and all, to the next. That protected one header at the price of one
// upstream call per origin -- and for `/health/scopus`, cached precisely to
// guard a weekly allowance, a monitor with no `Origin` and a browser with one
// were two calls for one answer. `serveCached` rebuilds the header instead.
export function canonicalCacheKey(request: Pick<Request, 'url'>, canonicalParams: Record<string, unknown> = {}) {
  const cacheUrl = new URL(`https://papertok.internal/cache${new URL(request.url).pathname}`);
  for (const [name, value] of Object.entries(canonicalParams)) {
    if (value !== null && value !== undefined && value !== '') {
      cacheUrl.searchParams.set(name, String(value));
    }
  }
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

// One stored body for every origin, with the one origin-dependent header put
// back for whoever is asking now. `vary: Origin` travels with it so the caches
// downstream of this one -- the browser's, any intermediary's -- do not
// cross-serve what this one no longer needs to keep apart.
//
// A personal answer is stored at the edge under a key that names its reader,
// and leaves here as `private, no-store` whether it was a hit or a miss.
export function serveCached(cached: Response, origin: string, env: WorkerEnv, { personal = false }: Pick<CacheOptions, 'personal'> = {}) {
  const headers = new Headers(cached.headers);
  headers.delete('access-control-allow-origin');
  headers.delete('vary');
  for (const [name, value] of Object.entries(corsHeaders(origin, env))) headers.set(name, value);
  if (personal) headers.set('cache-control', 'private, no-store');
  return new Response(cached.body, { status: cached.status, headers });
}

function boundedLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value as string, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

// Returns the ledger request it reserved with, not just a verdict: a later gate
// may refuse this caller after this unit is spent, and the refund has to name
// this unit -- this minute, this user -- rather than one recomputed later.
async function reserveProtectedProviderQuota(identity: CacheOptions['identity'], env: WorkerEnv, origin: string): Promise<QuotaGate> {
  if (!identity) return {};
  const minute = new Date().toISOString().slice(0, 16);
  const ledgerRequest = {
    periodKey: `provider:${minute}`,
    subject: `provider:${identity.uid}`,
    subjectLimit: boundedLimit(
      env.PROVIDER_USER_MINUTE_LIMIT,
      DEFAULT_PROVIDER_USER_MINUTE_LIMIT,
      500,
    ),
    globalLimit: boundedLimit(
      env.PROVIDER_GLOBAL_MINUTE_LIMIT,
      DEFAULT_PROVIDER_GLOBAL_MINUTE_LIMIT,
      100_000,
    ),
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
  if (!reservation.accepted && reservation.code) {
    return { error: json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    }) };
  }
  if (!reservation.accepted) {
    return { error: json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
      'retry-after': '60',
    }) };
  }
  return { reservation: ledgerRequest };
}

export function getSafeLimit(value: unknown, fallback = 8, max = 10) {
  const parsed = Number.parseInt(value as string, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

// The sibling of `reserveProtectedProviderQuota` for routes with no identity to
// charge, and the sibling of `reserveOpenAlexBudget` for providers that bill in
// requests rather than in money. It stays separate from that one because the
// budgets are different in kind: OpenAlex needs a daily ceiling because the
// allowance is a daily sum of dollars, while NCBI and Semantic Scholar publish a
// rate -- requests per second -- which a per-minute ceiling is the direct
// expression of, and a daily one would not bound at all.
//
// Returns the ledger request it reserved with, not just a verdict, because the
// beat behind it may refuse the caller after this unit is spent and has to give
// back *this* unit: the same minute, the same subject. Recomputing the minute at
// release time credits the next one whenever the request straddled the boundary.
export async function reserveSharedMinuteQuota(ceiling: MinuteCeiling, env: WorkerEnv, origin: string): Promise<QuotaGate> {
  const minute = new Date().toISOString().slice(0, 16);
  const limit = boundedLimit(env[ceiling.variable], ceiling.fallback, 100_000);
  const ledgerRequest = {
    periodKey: `${ceiling.namespace}:${minute}`,
    subject: `${ceiling.namespace}:shared`,
    subjectLimit: limit,
    globalLimit: limit,
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
  if (!reservation.accepted && reservation.code) {
    return { error: json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    }) };
  }
  if (!reservation.accepted) {
    return { error: json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
      'retry-after': '60',
    }) };
  }
  return { reservation: ledgerRequest };
}

// The beat under the ceiling, for the providers that count per second. It runs
// last of the reserving gates because it is the only one that costs wall-clock:
// a caller the minute ceiling or the identity quota is about to turn away must
// not first take a second away from somebody who would have used it.
//
// It refunds nothing itself. The units the gates before it took are held by
// `reserveGates`, which gives every one of them back when this refuses -- the
// beat used to refund the minute unit on its own and had no way to know the
// identity unit existed.
//
// Its own seat is the one exception to "every gate returns what it took": an
// accepted second never enters `held`. Giving it back would be meaningless --
// it is wall-clock time already slept into, and `awaitUpstreamSlot` only ever
// proposes the current second or a later one, so it would refuse to re-grant
// one already elapsed. That is safe only because no gate runs after an
// accepted beat today -- the paced routes, `/sources/s2`, `/related` and
// `/recommendations`, never pass `openAlexCalls` -- but a route that combined both would leak
// this seat, with nothing left downstream to catch it.
async function awaitSharedPace(ceiling: MinuteCeiling | undefined, env: WorkerEnv, origin: string) {
  if (!ceiling?.paced) return null;
  const slot = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, { namespace: ceiling.namespace });
  if (slot.accepted) return null;
  if (slot.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  // The beat's own window, not a literal next to a comment that promised it.
  return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    'retry-after': PACE_RETRY_AFTER_SECONDS,
  });
}

// Every unit an earlier gate took goes back when a later gate says no: the
// caller made no provider call, and the ledger counts provider calls. Each
// release has its own try/catch, so a refund that fails leaks only its own
// unit, whatever position it sits in -- the loop moves on regardless. Newest
// first is insurance for a different case, the isolate being cut short
// mid-loop: whatever the loop has not reached yet is what leaks, and
// reversing means that is the oldest -- and cheapest to lose -- unit. Same
// shape as `releaseAIQuota`: a refund that cannot be delivered is a leak, not
// a reason to change the answer the caller is owed.
export async function releaseHeld(env: WorkerEnv, held: QuotaRequest[]) {
  for (const reservation of [...held].reverse()) {
    try {
      await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, reservation);
    } catch {
      // Leak, not error.
    }
  }
}

// The reserving gates, in order, each pushing what it took onto `held`. Returns
// the first refusal, or null when every gate accepted; throws when a ledger
// cannot be reached, after giving back whatever was taken before it -- each
// gate is a different Durable Object, and any of them can fail with the
// earlier ones already spent. The fetcher is deliberately not inside this: a
// fetch that fails may still have reached the provider, and the ledger counts
// provider calls, not answers.
async function reserveGates(origin: string, env: WorkerEnv, options: CacheOptions, ceiling: MinuteCeiling | undefined, held: QuotaRequest[]) {
  try {
    const minute = ceiling ? await reserveSharedMinuteQuota(ceiling, env, origin) : {};
    if (minute.error) return minute.error;
    if (minute.reservation) held.push(minute.reservation);
    const identity = await reserveProtectedProviderQuota(options.identity || null, env, origin);
    if (identity.error) return identity.error;
    if (identity.reservation) held.push(identity.reservation);
    const paceError = await awaitSharedPace(ceiling, env, origin);
    if (paceError) return paceError;
    if (options.openAlexCalls) {
      const budget = await reserveOpenAlexBudget(env, origin, options.openAlexCalls);
      if (budget.error) return budget.error;
      held.push(...budget.reservations);
    }
    return null;
  } catch (error) {
    await releaseHeld(env, held);
    throw error;
  }
}

// `ttl` may be a function of the payload, because whether an answer deserves its
// full TTL is something only the fetcher's result can say: a 200 assembled from a
// fallback after the real provider refused is not worth six hours.
export async function cacheResponse<T>(request: Request, origin: string, env: WorkerEnv, ttl: number | ((payload: T) => number), fetcher: () => Promise<T>, options: CacheOptions = {}) {
  if (options.personal && !options.identity?.uid) throw new Error('A personal response needs the verified identity it is keyed by.');
  const cacheKey = canonicalCacheKey(request, options.personal
    ? { ...options.canonicalParams, uid: options.identity!.uid }
    : options.canonicalParams);
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env, options);
  // Resolved once here and handed to both gates: the beat used to re-parse the
  // URL to find the same ceiling the minute reservation had just looked up.
  const ceiling = SHARED_MINUTE_CEILINGS[new URL(request.url).pathname];
  const held: QuotaRequest[] = [];
  const refusal = await reserveGates(origin, env, options, ceiling, held);
  if (refusal) {
    await releaseHeld(env, held);
    return refusal;
  }
  const payload = await fetcher();
  const seconds = typeof ttl === 'function' ? ttl(payload) : ttl;
  // A short TTL exists because the answer is suspect, so it does not also get to
  // be served stale for a day while it revalidates -- and the browser must not
  // hold it longer than the edge does.
  const directives = ['public', `max-age=${Math.min(300, seconds)}`, `s-maxage=${seconds}`];
  if (seconds > DEGRADED_CACHE_SECONDS) directives.push('stale-while-revalidate=86400');
  const response = json(payload, 200, {
    ...corsHeaders(origin, env),
    'cache-control': directives.join(', '),
  });
  await caches.default.put(cacheKey, response.clone());
  return options.personal ? serveCached(response, origin, env, options) : response;
}

// Every upstream call in this file goes through here, and the deadline covers
// the whole exchange -- headers and body alike. The distinction is not academic:
// a timer cleared in a `finally` stops covering the response the moment `fetch`
// resolves, which is when the *headers* arrive, so an upstream that answers its
// headers and then dribbles the body used to hang exactly like one that never
// answered at all. An `AbortSignal.timeout` has no timer to clear: it stays armed
// until the body has been read in full, and cuts the read too. Measured against a
// server that sends headers and then goes quiet, the old shape was still waiting
// when the test gave up; this one aborts on the mark.
//
// A caller signal is *added* to the deadline rather than replacing it, and the
// difference is the whole reason this is worth a comment. In the browser a signal
// carries a **budget** -- the AI explanation is allowed seventy seconds -- so
// `withRequestDeadline` lets it win. Here it carries a **cancellation**:
// `request.signal` is the browser that hung up, and hanging up says nothing about
// how long the upstream may take. Letting it replace the deadline would hand the
// next route that passes one an unbounded wait, which is exactly what this helper
// exists to remove. `AbortSignal.any` keeps whichever fired first as the reason,
// so a cancellation still surfaces as `AbortError` and only a real deadline as
// `TimeoutError`. `email-notifications.js` keeps a private copy with the same
// signal rule; change both together.
export function fetchWithDeadline(url: RequestInfo | URL, options: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
}

export async function fetchJsonWithTimeout<T = unknown>(url: RequestInfo | URL, options: RequestInit = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<T> {
  const response = await fetchWithDeadline(url, options, timeoutMs);
  if (!response.ok) {
    // The status travels on the error because callers need to tell a provider
    // that answered "I do not have this" from one that did not answer at all.
    const error: UpstreamError = new Error(`Upstream error: ${response.status}`);
    error.status = response.status;
    // And the provider's own backoff, when it gave one. Inventing a number here
    // would be guessing at somebody else's window.
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  return response.json<T>();
}

export function safeSourceQuery(value: unknown) {
  const query = [...String(value || '')]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return query.length <= 500 ? query : '';
}

// The `limit` bounds are a parameter because the two page-sized sources do not
// agree with the other nine. PubMed and Semantic Scholar were read straight from
// the browser in batches of 25, and capping them at the 10 the domain sources use
// would quietly shrink every result set that migrates here.
export function sourceRequestContext(request: Request, env: WorkerEnv, { limitFallback = 8, limitMax = 10 } = {}) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) {
    return { error: json({ error: 'Origin not allowed' }, 403) };
  }
  return {
    requestUrl,
    origin,
    page: getSafeLimit(requestUrl.searchParams.get('page'), 1, 100),
    limit: getSafeLimit(requestUrl.searchParams.get('limit'), limitFallback, limitMax),
    sort: requestUrl.searchParams.get('sort') === 'recent' ? 'recent' : 'relevance',
  };
}

// Page and limit are normalized by `sourceRequestContext` before they reach any
// upstream, so those are the values the key has to carry. `sort` is deliberately
// not folded in here: three of these routes never send it upstream, and a key
// that carries an input the answer does not depend on is just a second entry for
// one response.
export function sourceCacheParams(context: { page: number; limit: number }, extra?: Record<string, unknown>) {
  return { page: String(context.page), limit: String(context.limit), ...extra };
}

// Every `/sources/*` upstream reaches the network through here, and none of
// them used to carry a deadline: a hung provider held the subrequest open with
// nothing to cut it, while the browser had already given up. Six seconds is
// deliberately above the client's 4 s per-source budget — the slowest real
// upstream measured is OpenReview at 5.2 s cold, and letting it finish still
// pays off because the answer lands in the edge cache for the next reader,
// even though the reader who triggered it has moved on.
export function fetchJsonUpstream<T = unknown>(url: RequestInfo | URL, headers: Record<string, string> = {}, timeoutMs = SOURCE_UPSTREAM_TIMEOUT_MS) {
  return fetchJsonWithTimeout<T>(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      ...headers,
    },
  }, timeoutMs);
}

export function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null;
}

export function boundedText(value: unknown, maxLength: number) {
  return [...String(value || '')]
    .map(character => (character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Every OpenAlex call this Worker pays for goes through here, and it is the only
// thing standing between a scripted caller and the day's budget: the Origin gate
// is advisory by construction -- a request with no `Origin` header at all has
// nothing to check, and one is trivially forged -- so a ceiling is the frontier,
// not the header. The guest feed reads OpenAlex without a session, so the ceiling
// is global rather than per user, and it is reserved only after a cache miss so
// repeated queries cost nothing.
//
// Minute first, day second, and the minute given back if the day says no. This
// used to leave the minute unit to expire as the lesser of two leaks, chosen
// before giving a unit back was a pattern here; now nothing is left spent for
// a call that was never made. What was taken travels back to the caller, the
// same shape as every other gate, so whoever owns the refund can name it.
export async function reserveOpenAlexBudget(env: WorkerEnv, origin: string, amount: number) {
  const now = new Date().toISOString();
  const periods: Array<[string, number, string]> = [
    [`openalex:${now.slice(0, 16)}`, boundedLimit(
      env.OPENALEX_GLOBAL_MINUTE_LIMIT,
      DEFAULT_OPENALEX_GLOBAL_MINUTE_LIMIT,
      100_000,
    ), '60'],
    // Not the true seconds until UTC midnight: a `retry-after` of several hours is
    // a client that stops asking until someone reloads the tab, and the daily
    // ceiling is an emergency brake, not a normal state.
    [`openalex:day:${now.slice(0, 10)}`, boundedLimit(
      env.OPENALEX_GLOBAL_DAILY_LIMIT,
      DEFAULT_OPENALEX_GLOBAL_DAILY_LIMIT,
      1_000_000,
    ), '300'],
  ];
  const taken: QuotaRequest[] = [];
  for (const [periodKey, limit, retryAfter] of periods) {
    const ledgerRequest = {
      periodKey,
      subject: 'openalex:shared',
      subjectLimit: limit,
      globalLimit: limit,
      amount,
    };
    const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
    if (!reservation.accepted) {
      await releaseHeld(env, taken);
      if (reservation.code) {
        return { error: json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
          ...corsHeaders(origin, env),
          'cache-control': 'no-store',
        }) };
      }
      return { error: json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        'retry-after': retryAfter,
      }) };
    }
    taken.push(ledgerRequest);
  }
  return { reservations: taken };
}
