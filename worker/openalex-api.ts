import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

export type { OpenAlexWork } from '../src/services/adapters/openAlexTypes.ts';

import { allowedOrigins, corsHeaders, json } from './http.ts';
import {
  boundedText,
  canonicalCacheKey,
  fetchJsonWithTimeout,
  fetchWithDeadline,
  numberOrNull,
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

function openAlexResponseHeaders(upstream: Response, origin: string, env: WorkerEnv) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...corsHeaders(origin, env),
  });
  const exposed = [];
  for (const name of OPENALEX_RATE_LIMIT_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
      exposed.push(name);
    }
  }
  if (exposed.length > 0) headers.set('access-control-expose-headers', exposed.join(', '));
  return headers;
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

  const searching = target.searchParams.has('search') || /\.search[.:]/.test(target.searchParams.get('filter') || '');
  const budget = await reserveOpenAlexBudget(env, origin, searching ? OPENALEX_CALLS.search : OPENALEX_CALLS.relay);
  if (budget.error) return budget.error;

  const upstream = await fetchWithDeadline(addOpenAlexCredentials(target, env), {
    headers: { accept: 'application/json' },
  });
  const body = await upstream.text();
  const headers = openAlexResponseHeaders(upstream, origin, env);

  // A refusal is relayed with its own status and its own `retry-after`, because
  // flattening it into a 502 would leave the client guessing how long to wait --
  // and since February 2026 that wait can be most of a day.
  if (upstream.status === 404) {
    headers.set('cache-control', `public, max-age=300, s-maxage=${OPENALEX_NOT_FOUND_CACHE_SECONDS}`);
    const response = new Response(body, { status: 404, headers });
    await caches.default.put(cacheKey, response.clone());
    return response;
  }
  if (!upstream.ok) {
    headers.set('cache-control', 'no-store');
    return new Response(body, { status: upstream.status, headers });
  }

  headers.set('cache-control', `public, max-age=300, s-maxage=${OPENALEX_CACHE_SECONDS}, stale-while-revalidate=86400`);
  const response = new Response(body, { status: 200, headers });
  await caches.default.put(cacheKey, response.clone());
  return response;
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
