import type { WorkerEnv } from './env.ts';
import type { OpenAlexBudget, OpenAlexTier, UpstreamError } from './provider-runtime.ts';

export type { OpenAlexWork } from '../src/services/adapters/openAlexTypes.ts';

import { sha256 } from './ai-explanation.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import {
  boundedText,
  canonicalCacheKey,
  fetchJsonWithTimeout,
  fetchWithDeadline,
  numberOrNull,
  observeOpenAlexBudget,
  OPENALEX_CALLS,
  reserveOpenAlexBudget,
  serveCached,
  SOURCE_UPSTREAM_TIMEOUT_MS,
} from './provider-runtime.ts';

const OPENALEX_CACHE_SECONDS = 6 * 60 * 60;
// A work OpenAlex has not indexed is an answer. The author lookup in
// `src/services/openAlexService.ts` asks for its paper's work, and for 51 of 56
// slow author links measured on 2026-09-07 that work was not indexed, so every
// click on an author of the same paper billed the same 404 again. An hour lets a
// newly indexed work show up the same day.
const OPENALEX_NOT_FOUND_CACHE_SECONDS = 60 * 60;
// The edge cache above is per data centre, so every location asks OpenAlex the
// same questions again. On launch day (2026-10-21) the day's ceiling ran out of
// units while two `/health/openalex` readings showed the key with a quarter of
// its dollars left -- the inference from them, not a measurement of the relay,
// is that the ledger refused before the money ran out (PAP-86). So an answer
// is also kept in KV, which every location reads: a day for an answer, the
// hour the edge keeps for a 404. The relay carries no identity -- an answer
// depends only on the canonical upstream parameters -- so there is nothing
// personal to keep apart. The store is NOTIFICATION_STORE under a prefix, as
// `ai-rewrite.ts` does, because no namespace of its own exists yet.
const OPENALEX_SHARED_CACHE_SECONDS = 24 * 60 * 60;
const OPENALEX_SHARED_PREFIX = 'openalex:v1:';
// OpenAlex bills per call against a daily budget, so the browser can no longer
// hold the credential. These are the entities and parameters the app actually
// asks for; the URL is rebuilt from them rather than forwarded.
const OPENALEX_ENTITIES = new Set([
  'works',
  'authors',
  'institutions',
  'sources',
  'topics',
  'concepts',
  'publishers',
  'funders',
  'keywords',
  'autocomplete',
]);
const OPENALEX_PARAMS = [
  'filter',
  'search',
  'select',
  'sort',
  'page',
  'per-page',
  'per_page',
  'cursor',
  'group_by',
  'sample',
  'seed',
  'q',
];
// The client reads these to back off for as long as OpenAlex actually asks, so
// they are relayed and, because they are not simple response headers, exposed
// to the page. Without the expose header the browser hides them and the backoff
// silently falls back to a guess.
const OPENALEX_RATE_LIMIT_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit-usd',
  'x-ratelimit-remaining-usd',
];

// What a miss resolved to, before the asking origin is put on it. Identical
// misses in flight in this isolate share one of these (see `inFlight`), and a
// shared `Response` would have one body for several readers.
type RelayedAnswer = { status: number; body: string; headers: Headers };

// A launch burst asks the same question from many tabs within the second it
// takes OpenAlex to answer the first. Each of those used to miss the edge,
// reserve its own units and make its own call. Keyed by the canonical cache
// URL; an entry leaves when its miss settles, so a failure is not shared with
// anyone who asks after it.
const inFlight = new Map<string, Promise<RelayedAnswer>>();

export function addOpenAlexCredentials(url: URL, env: WorkerEnv) {
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url;
}

// Only a refusal of the key itself is worth asking again without it: a key that
// was rejected or whose budget is spent. A 404 or an outage answers the same
// without the key, and retrying a timeout doubled the wait.
const KEY_REFUSALS = new Set([401, 403, 429]);

export async function fetchOpenAlexJsonWithFallback<T = unknown>(url: URL, env: WorkerEnv, timeoutMs: number) {
  try {
    return await fetchJsonWithTimeout<T>(url, { headers: { accept: 'application/json' } }, timeoutMs);
  } catch (error) {
    if (!KEY_REFUSALS.has(Number((error as UpstreamError)?.status)) || !env.OPENALEX_API_KEY || !url.searchParams.has('api_key')) throw error;
    const anonymousUrl = new URL(url);
    anonymousUrl.searchParams.delete('api_key');
    return fetchJsonWithTimeout<T>(anonymousUrl, { headers: { accept: 'application/json' } }, timeoutMs);
  }
}

// Rebuilds the upstream URL from an entity allowlist and a parameter allowlist.
// Nothing the caller sends reaches OpenAlex verbatim -- in particular an
// `api_key` in the query is dropped, so a caller cannot spend someone else's
// budget or pin a key of their own.
function openAlexTargetUrl(pathname: string, searchParams: URLSearchParams) {
  const [entity, ...idSegments] = pathname.slice('/openalex/'.length).split('/');
  if (!OPENALEX_ENTITIES.has(entity)) return null;

  const id = idSegments.join('/');
  // `works/doi:10.1016/j.x` legitimately carries a slash, so the id is matched
  // as a whole. A raw `../` never arrives -- the URL parser resolves it before
  // this route sees it -- but a percent-encoded one does, so the check runs on
  // the decoded form. A real identifier decodes to something without `..`.
  if (id) {
    if (!/^[A-Za-z0-9._:%|,\-/]{1,240}$/.test(id)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      return null;
    }
    if (decoded.includes('..')) return null;
  }

  const url = new URL(`https://api.openalex.org/${entity}${id ? `/${id}` : ''}`);
  for (const name of OPENALEX_PARAMS) {
    const value = searchParams.get(name);
    if (value === null || value.length > 2_000) continue;
    // Trimmed here, and the cache key is then read back off this URL. The two used
    // to disagree -- the key trimmed, the upstream URL did not -- so `filter=x`
    // and `filter=%20x%20` collided on one entry for six hours, and a spoofable
    // Origin let that entry be seeded from outside. An all-whitespace value is
    // dropped rather than sent empty, so it collides with sending nothing, which
    // is what it means.
    const trimmed = value.trim();
    if (trimmed) url.searchParams.set(name, trimmed);
  }
  return url;
}

// The headers every relayed answer carries, before the asking origin is known.
function relayHeaders(upstream?: Pick<Response, 'headers'>) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  const exposed = [];
  for (const name of OPENALEX_RATE_LIMIT_HEADERS) {
    const value = upstream?.headers.get(name);
    if (value) {
      headers.set(name, value);
      exposed.push(name);
    }
  }
  if (exposed.length > 0) headers.set('access-control-expose-headers', exposed.join(', '));
  return headers;
}

function cacheControl(status: number) {
  return status === 404
    ? `public, max-age=300, s-maxage=${OPENALEX_NOT_FOUND_CACHE_SECONDS}`
    : `public, max-age=300, s-maxage=${OPENALEX_CACHE_SECONDS}, stale-while-revalidate=86400`;
}

// The one origin-dependent header, put on for whoever is asking now, the way
// `serveCached` does for an edge hit -- except that the relayed rate-limit
// headers stay exposed beside `retry-after`, which `corsHeaders` alone would
// replace.
function forOrigin(answer: RelayedAnswer, origin: string, env: WorkerEnv) {
  const headers = new Headers(answer.headers);
  const exposed = headers.get('access-control-expose-headers');
  for (const [name, value] of Object.entries(corsHeaders(origin, env))) headers.set(name, value);
  if (exposed && headers.has('access-control-allow-origin')) {
    headers.set('access-control-expose-headers', [...new Set(['retry-after', ...exposed.split(',').map(name => name.trim())])].join(', '));
  }
  return new Response(answer.body, { status: answer.status, headers });
}

function openAlexStore(env: WorkerEnv) {
  return env.NOTIFICATION_STORE?.getWithMetadata ? env.NOTIFICATION_STORE : null;
}

// A raw filter of fifty topics or forty arXiv URLs is longer than KV's
// 512-byte key limit, so the canonical URL is hashed.
async function sharedKey(cacheKey: Request) {
  return `${OPENALEX_SHARED_PREFIX}${await sha256(cacheKey.url)}`;
}

// A store that cannot be read is a miss, not an outage: the relay still has
// OpenAlex to ask.
async function readShared(env: WorkerEnv, key: string) {
  const store = openAlexStore(env);
  if (!store) return null;
  try {
    const stored = await store.getWithMetadata<{ status?: unknown }>(key, { type: 'text' });
    const status = Number(stored.metadata?.status);
    if (stored.value === null || (status !== 200 && status !== 404)) return null;
    return { status, body: stored.value };
  } catch {
    return null;
  }
}

async function writeShared(env: WorkerEnv, key: string, status: number, body: string) {
  const store = openAlexStore(env);
  if (!store) return;
  try {
    await store.put(key, body, {
      expirationTtl: status === 404 ? OPENALEX_NOT_FOUND_CACHE_SECONDS : OPENALEX_SHARED_CACHE_SECONDS,
      metadata: { status },
    });
  } catch {
    // A missed write costs one future call.
  }
}

// The filter keys that name works by identifier. A list filtered only by them
// is a lookup of known papers, not a query.
const IDENTIFIER_FILTER_KEYS = new Set(['doi', 'openalex', 'ids.openalex', 'locations.landing_page_url']);
// The feed's own lanes: the topic lane (`primary_topic.id`) and the
// working-paper series (`primary_location.source.id`). A negated value is not
// a lane: the Explorer's reviewed-only lists exclude the series that way.
const FEED_FILTER_KEYS = new Set(['primary_topic.id', 'primary_location.source.id']);

function filterClauses(filter: string) {
  return filter.split(',').filter(Boolean).map(clause => {
    const separator = clause.indexOf(':');
    return separator < 0
      ? { key: clause, value: '' }
      : { key: clause.slice(0, separator), value: clause.slice(separator + 1) };
  });
}

/**
 * What a miss is billed and which tier it spends, read off the URL about to be
 * sent, the same URL the cache key is read from. Billing: a search is ten list
 * calls, a list one, an entity by id or DOI nothing (`OPENALEX_CALLS`); the
 * autocomplete endpoint's second segment names a type, not an entity. Tier:
 * - essential: one work by identifier (`per-page=1`), a paper being opened;
 * - enrichment: known works by identifier, the cards already on screen;
 * - exploration: a graph expansion (`select=id,ids`), every search, and any
 *   shape not listed here, so a request the rules do not know stops early
 *   rather than spending late;
 * - feed: the feed's topic lane and working-paper series.
 * No header or parameter from the client is read, so a cached bundle gets its
 * tier from what it asks for, and one URL always has one tier. A scripted
 * caller can shape a URL to look essential: the ceiling is the frontier.
 */
export function openAlexCostFor(target: URL): OpenAlexBudget {
  const [entity, id] = target.pathname.slice(1).split('/');
  if (id && entity !== 'autocomplete') return { units: OPENALEX_CALLS.entity, tier: 'essential', kind: 'entity' };
  const filter = target.searchParams.get('filter') || '';
  if (target.searchParams.has('search') || /\.search[.:]/.test(filter)) {
    return { units: OPENALEX_CALLS.search, tier: 'exploration', kind: 'search' };
  }
  const list = (tier: OpenAlexTier): OpenAlexBudget => ({ units: OPENALEX_CALLS.relay, tier, kind: 'list' });
  if (entity !== 'works') return list('exploration');
  const clauses = filterClauses(filter);
  const named = (keys: Set<string>, clause: { key: string; value: string }) => (
    keys.has(clause.key) && clause.value !== '' && !clause.value.startsWith('!')
  );
  if (clauses.length > 0 && clauses.every(clause => named(IDENTIFIER_FILTER_KEYS, clause))) {
    if (target.searchParams.get('select') === 'id,ids') return list('exploration');
    const perPage = target.searchParams.get('per-page') ?? target.searchParams.get('per_page');
    return list(perPage === '1' ? 'essential' : 'enrichment');
  }
  return list(clauses.some(clause => named(FEED_FILTER_KEYS, clause)) ? 'feed' : 'exploration');
}

// An edge miss: the shared store first, then -- and only then -- a reservation
// and the call. Resolves without an origin so that everyone waiting on the
// same miss can put their own on.
async function relayMiss(target: URL, cacheKey: Request, env: WorkerEnv): Promise<RelayedAnswer> {
  const key = await sharedKey(cacheKey);
  const shared = await readShared(env, key);
  if (shared) {
    const headers = relayHeaders();
    headers.set('cache-control', cacheControl(shared.status));
    await caches.default.put(cacheKey, new Response(shared.body, { status: shared.status, headers }));
    return { ...shared, headers };
  }

  // One instant for the reservation and the reading this answer brings, so
  // both name the same day's ledger even when the call crosses midnight.
  const now = new Date().toISOString();
  const cost = openAlexCostFor(target);
  if (cost.units > 0) {
    const budget = await reserveOpenAlexBudget(env, '', cost, now);
    if (budget.error) return { status: budget.error.status, body: await budget.error.text(), headers: budget.error.headers };
  }

  const upstream = await fetchWithDeadline(addOpenAlexCredentials(target, env), {
    headers: { accept: 'application/json' },
  });
  const body = await upstream.text();
  const headers = relayHeaders(upstream);
  // Every answer reports the key's day, a free lookup's and a refusal's too:
  // a refusal reporting nothing left closes the ledger at once.
  const observed = observeOpenAlexBudget(env, now, upstream.headers);

  // A refusal is relayed with its own status and its own `retry-after`, because
  // flattening it into a 502 would leave the client guessing how long to wait --
  // and since February 2026 that wait can be most of a day.
  if (!upstream.ok && upstream.status !== 404) {
    headers.set('cache-control', 'no-store');
    await observed;
    return { status: upstream.status, body, headers };
  }

  headers.set('cache-control', cacheControl(upstream.status));
  await caches.default.put(cacheKey, new Response(body, { status: upstream.status, headers }));
  await Promise.all([writeShared(env, key, upstream.status, body), observed]);
  return { status: upstream.status, body, headers };
}

export async function handleOpenAlex(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);

  const target = openAlexTargetUrl(requestUrl.pathname, requestUrl.searchParams);
  if (!target) return json({ code: 'INVALID_OPENALEX_REQUEST' }, 400, corsHeaders(origin, env));

  const cacheKey = canonicalCacheKey(request, Object.fromEntries(target.searchParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);

  let pending = inFlight.get(cacheKey.url);
  if (!pending) {
    pending = relayMiss(target, cacheKey, env).finally(() => inFlight.delete(cacheKey.url));
    inFlight.set(cacheKey.url, pending);
  }
  return forOrigin(await pending, origin, env);
}

// OpenAlex reports the remaining daily budget on every response. With the quota
// now denominated in money, that number is worth being able to read directly
// instead of inferring it from a feed that stopped working.
export async function checkOpenAlexHealth(env: WorkerEnv) {
  const base = { provider: 'openalex', configured: Boolean(env.OPENALEX_API_KEY) };
  try {
    const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
    url.searchParams.set('per-page', '1');
    url.searchParams.set('select', 'id');
    const response = await fetchWithDeadline(url, { headers: { accept: 'application/json' } }, SOURCE_UPSTREAM_TIMEOUT_MS);
    const budget = {
      limitUsd: numberOrNull(response.headers.get('x-ratelimit-limit-usd')),
      remainingUsd: numberOrNull(response.headers.get('x-ratelimit-remaining-usd')),
      remainingCalls: numberOrNull(response.headers.get('x-ratelimit-remaining')),
      resetSeconds: numberOrNull(response.headers.get('x-ratelimit-reset')),
    };
    if (response.ok) return { ...base, available: true, status: 200, code: '', budget };
    const payload = await response.json<{ error?: unknown; message?: unknown }>().catch(() => null);
    return {
      ...base,
      available: false,
      status: response.status,
      code: boundedText(payload?.error, 80) || `OPENALEX_HTTP_${response.status}`,
      message: boundedText(payload?.message, 200),
      budget,
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      status: null,
      code: 'OPENALEX_UNREACHABLE',
      message: boundedText((error as UpstreamError)?.message, 160),
      budget: null,
    };
  }
}
