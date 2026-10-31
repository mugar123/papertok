import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { reserveCallerMinute } from './caller-quota.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { canonicalCacheKey, fetchWithDeadline, serveCached } from './provider-runtime.ts';
import { releaseRequestQuota } from './request-quota-ledger.ts';
import { awaitUpstreamSlot, paceRetryAfterSeconds } from './upstream-pace.ts';

export const ARXIV_UPSTREAM_TIMEOUT_MS = 5000;
// arXiv's published policy: one request every three seconds, one connection.
// The Worker is the one client arXiv sees, so the beat is app-wide, kept in
// the same ledger as the Semantic Scholar one (`upstream-pace.js`). The wait
// budget is set by the client: the browser leaves `/arxiv` at 6 s
// (ARXIV_ROUTE_TIMEOUT_MS), so four seconds of waiting plus a healthy fetch
// still answers in time, and a seat further away than that is refused at
// once -- the caller has other sources, and a seat nobody will wait for is a
// seat somebody else could have used.
export const ARXIV_PACE_PERIOD_MS = 3_000;
export const ARXIV_PACE_MAX_WAIT_MS = 4_000;
// A request from outside the Worker (`handleArxiv`: a reader, a guest or a
// script; `handleAgentArxiv`: an AI client) may take only every other seat,
// 10 misses a minute app-wide, so cache-busting queries cannot hold every seat however many addresses send
// them; the caller allowance below counts one address, and one IPv6 host can
// send from a whole /64. The Worker's own callers take any seat: the
// harvest's arXiv lanes and the liked-paper lookups (`handleHarvestArxiv`),
// and share pages. A signed-in reader chooses the ids those lookups ask for
// through POST /store/papers, so one account, within its per-minute feed
// allowance, can still hold every seat. Spacing towards arXiv is unchanged:
// still one call every three seconds.
const PUBLIC_SEAT = (slot: number) => slot % 2 === 0;
// Whole seconds from `now` to the start of the next public seat after the
// current period: 1 to 6.
function nextPublicSeatSeconds(now: number) {
  let slot = Math.floor(now / ARXIV_PACE_PERIOD_MS) + 1;
  while (!PUBLIC_SEAT(slot)) slot += 1;
  return String(Math.ceil((slot * ARXIV_PACE_PERIOD_MS - now) / 1000));
}
// An hour, up from ten minutes. arXiv's listings change once a day (the
// announcement at 20:00 ET), so a page served from the edge for an hour is as
// fresh as one fetched twice -- and with one upstream call every three seconds
// for the whole app, every call the cache saves is a seat somebody else gets.
const ARXIV_CACHE_SECONDS = 60 * 60;
// The misses one address may send in a UTC minute: 5, half of the 10 seats
// PUBLIC_SEAT leaves a request from outside the Worker. One address, such as a
// script or a university behind one NAT, cannot take every public seat; two
// can, and everyone behind one NAT shares these 5. The paper harvest asks
// in-process (`handleHarvestArxiv`) and spends no caller's allowance.
const ARXIV_CALLER_MINUTE_LIMIT = 5;
const ARXIV_PARAMS = ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder'];

function safeArxivParam(name: string, rawValue: unknown) {
  // Trimmed here rather than only on the way into the cache key: the two used to
  // disagree, so `search_query=x` and `search_query=%20x%20` shared one entry
  // while asking arXiv two different questions.
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (value.length > 2_000) return '';
  if (name === 'start') return /^\d{1,6}$/.test(value) ? value : '';
  if (name === 'max_results') {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 50 ? String(parsed) : '';
  }
  if (name === 'sortBy') return ['relevance', 'lastUpdatedDate', 'submittedDate'].includes(value) ? value : '';
  if (name === 'sortOrder') return ['ascending', 'descending'].includes(value) ? value : '';
  return value;
}

export function handleArxiv(request: Request, env: WorkerEnv) {
  return relayArxiv(request, env, { perCaller: true, maxWaitMs: ARXIV_PACE_MAX_WAIT_MS });
}

// The route as the paper harvest asks it in-process: no caller to count.
export function handleHarvestArxiv(request: Request, env: WorkerEnv) {
  return relayArxiv(request, env, { perCaller: false, maxWaitMs: ARXIV_PACE_MAX_WAIT_MS });
}

/**
 * The route as the MCP server asks it in-process for an AI client: the
 * caller's allowance is counted, but a miss takes only the seat of the period
 * the beat is in, never one ahead. Readers book the seats ahead of them, so an
 * agent gets a seat no reader booked and gives way to readers (ENG-91 puts
 * agents in the lowest budget tier). An agent is a caller from outside the
 * Worker, so that seat must also be a public one.
 */
export function handleAgentArxiv(request: Request, env: WorkerEnv) {
  return relayArxiv(request, env, { perCaller: true, maxWaitMs: 0 });
}

// `perCaller` is true for a request from outside the Worker: it spends its
// address's allowance and takes only public seats.
async function relayArxiv(request: Request, env: WorkerEnv, { perCaller, maxWaitMs }: { perCaller: boolean; maxWaitMs: number }) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);

  const upstreamUrl = new URL('https://export.arxiv.org/api/query');
  for (const name of ARXIV_PARAMS) {
    const value = safeArxivParam(name, requestUrl.searchParams.get(name) || '');
    if (value) upstreamUrl.searchParams.set(name, value);
  }
  if (!upstreamUrl.searchParams.get('search_query') && !upstreamUrl.searchParams.get('id_list')) {
    return json({ error: 'Missing arXiv query' }, 400, corsHeaders(origin, env));
  }

  // Keyed on the URL that was actually built, which is the only way the two
  // cannot drift apart.
  const cacheKey = canonicalCacheKey(request, Object.fromEntries(upstreamUrl.searchParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);

  // A miss takes a seat on the beat before it goes upstream. No ledger, no
  // beat: the seat is courtesy towards arXiv, not the protection of a key,
  // and a ledger that is down must not take the source down with it.
  if (env.REQUEST_QUOTA_LEDGER) {
    // The caller's allowance comes before the beat, so a caller past it takes
    // no seat. A missing identity fails closed; a ledger that cannot answer is
    // treated as it is for the beat.
    const caller = perCaller ? await reserveCallerMinute(request, env, 'arxiv', ARXIV_CALLER_MINUTE_LIMIT) : null;
    if (caller?.reading.code === 'CALLER_IDENTITY_NOT_CONFIGURED') {
      return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
    if (caller && !caller.reading.accepted && !caller.reading.code) {
      return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        'retry-after': caller.retryAfter,
      });
    }
    if (caller?.reading.code) console.warn(`arXiv caller allowance unavailable (${caller.reading.code}); not counted`);
    const seat = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, {
      namespace: 'arxiv',
      periodMs: ARXIV_PACE_PERIOD_MS,
      maxWaitMs,
      accepts: perCaller ? PUBLIC_SEAT : undefined,
    });
    if (!seat.accepted && !seat.code) {
      // No seat, no call: the caller's unit goes back.
      if (caller?.reading.accepted && caller.reservation) {
        await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, caller.reservation).catch(() => undefined);
      }
      // After the window it was refused within, which is at least this period.
      // A caller that looks less than a period ahead is told when the next
      // seat it can take starts instead: from a public period, the period
      // after it is not one, and a retry there would be refused again.
      return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        'retry-after': perCaller && maxWaitMs < ARXIV_PACE_PERIOD_MS
          ? nextPublicSeatSeconds(Date.now())
          : paceRetryAfterSeconds(Math.max(maxWaitMs, ARXIV_PACE_PERIOD_MS)),
      });
    }
    if (seat.code) console.warn(`arXiv beat unavailable (${seat.code}); sending unpaced`);
  }

  const response = await fetchWithDeadline(upstreamUrl.toString(), {
    headers: {
      accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  }, ARXIV_UPSTREAM_TIMEOUT_MS);
  if (!response.ok) {
    // The status travels on the error so the router can tell arXiv's own 429
    // from an outage -- they used to leave as the same 502.
    const error: UpstreamError = new Error(`arXiv error: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  // Read under the same deadline: arXiv is the one upstream that answers XML, and
  // a feed that stops mid-document is a stall, not a short answer.
  const xml = await response.text();
  if (!xml.includes('<feed')) throw new Error('Invalid arXiv response');

  const workerResponse = new Response(xml, {
    status: 200,
    headers: {
      ...corsHeaders(origin, env),
      'content-type': 'application/atom+xml; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': `public, max-age=120, s-maxage=${ARXIV_CACHE_SECONDS}, stale-while-revalidate=3600`,
    },
  });
  await caches.default.put(cacheKey, workerResponse.clone());
  return workerResponse;
}
