import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { reserveCallerMinute } from './caller-quota.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { canonicalCacheKey, fetchWithDeadline, serveCached } from './provider-runtime.ts';
import { PACE_ANSWER_ALLOWANCE_MS, releaseRequestQuota } from './request-quota-ledger.ts';
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
// allowance, can still hold every seat. The email digest takes only the seats
// requests from outside the Worker may not take.
//
// The guarantee towards arXiv (ENG-184): every call the Worker sends to
// export.arxiv.org goes out at least ARXIV_PACE_PERIOD_MS after the one before
// it, whichever caller sent either, as measured on the request ledger's clock.
// The ledger gives each seat a send time and a window after it, up to 250 ms
// (PACE_ANSWER_ALLOWANCE_MS) for the answer's way back or a late timer, and
// keeps every window three seconds from every other one, before or after it.
// A caller that cannot send within its window, because the answer or its timer
// came late, does not send on that seat. A caller sends only after its seat is
// confirmed. When the ledger answers with an error it does not send at all, and
// its caller falls back as for a refused seat; only a Worker without a ledger
// binding (local runs) sends unpaced. A send time the caller would have to
// wait past its bound for is refused like a taken seat, so the next seat in
// reach is tried instead.
const PUBLIC_SEAT = (slot: number) => slot % 2 === 0;
type ArxivCaller = 'reader' | 'agent' | 'worker' | 'digest' | 'test-email';
// The Worker's own calls and the digest give way to readers (ENG-184 review):
// they take a seat only once its period has begun, and only to send at once,
// so they never hold a send time ahead that a reader arriving later would
// need. A reader who arrives after such a call went out has at least
// ARXIV_PACE_MAX_WAIT_MS of wait for the three seconds after it. Pushed off a
// seat by spacing, they do not move into a reader's seat: before ENG-184 they
// would have taken the seat they were pushed off.
const OWN_SEAT = (slot: number) => !PUBLIC_SEAT(slot);
// On a seat that is not public they send only early enough that their window
// ends 250 ms before the next public seat starts. A reader who arrives after
// such a call then sends within 3.25 s, and their own window, even at its
// latest, ends by the end of their period, so the reader on the public seat
// after them is not pushed back. Sent any later, a Worker lookup or the digest
// pushed a reader to the end of their period, and the next reader, who would
// have waited 4 s on main, was refused (outside review of #443).
const GIVES_WAY_BY = (slot: number) => (PUBLIC_SEAT(slot)
  ? Infinity
  : (slot + 1) * ARXIV_PACE_PERIOD_MS - 2 * PACE_ANSWER_ALLOWANCE_MS);
// The digest's wait covers one seat for each query of a schedule batch
// (SCHEDULE_PAGE_SIZE, 3 subscribers at once, in `email-notifications.ts`),
// two periods apart, and one more for a seat the Worker's lookups take.
const DIGEST_MAX_WAIT_MS = (3 + 1) * 2 * ARXIV_PACE_PERIOD_MS;
const ARXIV_SEATS: Record<ArxivCaller, {
  maxWaitMs: number;
  givesWay?: boolean;
  accepts?: (slot: number) => boolean;
  acceptsAfterSpacing?: (slot: number) => boolean;
}> = {
  reader: { maxWaitMs: ARXIV_PACE_MAX_WAIT_MS, accepts: PUBLIC_SEAT },
  // See `handleAgentArxiv`.
  agent: { maxWaitMs: 0, accepts: PUBLIC_SEAT },
  worker: { maxWaitMs: ARXIV_PACE_MAX_WAIT_MS, givesWay: true, acceptsAfterSpacing: OWN_SEAT },
  // A cron, so it can wait for a seat of its own, which never is one a reader
  // could have had.
  digest: { maxWaitMs: DIGEST_MAX_WAIT_MS, givesWay: true, accepts: OWN_SEAT },
  // The same query for a test email, whose sender waits on the request: no
  // longer than a reader.
  'test-email': { maxWaitMs: ARXIV_PACE_MAX_WAIT_MS, givesWay: true, accepts: OWN_SEAT },
};

/**
 * Takes a seat on the arXiv beat for one call, and waits until that call may
 * go out. Every caller that sends to export.arxiv.org goes through here.
 */
export async function takeArxivSeat(ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], caller: ArxivCaller) {
  const seat = await awaitUpstreamSlot(ledger, {
    namespace: 'arxiv',
    periodMs: ARXIV_PACE_PERIOD_MS,
    spacingMs: ARXIV_PACE_PERIOD_MS,
    givesWayBy: GIVES_WAY_BY,
    ...ARXIV_SEATS[caller],
  });
  // A ledger that answers with an error cannot space the call, so it is
  // refused like a taken seat.
  if (seat.code === 'QUOTA_LEDGER_UNAVAILABLE') {
    console.warn('arXiv beat unavailable; not sending');
    return { accepted: false, code: undefined };
  }
  return seat;
}
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
  return relayArxiv(request, env, 'reader');
}

// The route as the paper harvest asks it in-process: no caller to count.
export function handleHarvestArxiv(request: Request, env: WorkerEnv) {
  return relayArxiv(request, env, 'worker');
}

/**
 * The route as the MCP server asks it in-process for an AI client: the
 * caller's allowance is counted, but a miss takes only the seat of the period
 * the beat is in, never one ahead. Readers book the seats ahead of them, so an
 * agent never takes a seat a reader booked (ENG-91 puts agents in the lowest
 * budget tier). It can still take the seat of a reader who arrives after it in
 * the period's first two seconds: the next public seat is then more than
 * ARXIV_PACE_MAX_WAIT_MS away, so that reader is refused. An agent
 * is a caller from outside the Worker, so its seat must also be a public one,
 * and even on an idle Worker about half of uncached agent lookups are refused.
 * An agent does not wait for its call to be spaced either: when the last arXiv
 * call went out less than three seconds ago, its lookup is refused.
 */
export function handleAgentArxiv(request: Request, env: WorkerEnv) {
  return relayArxiv(request, env, 'agent');
}

// A request from outside the Worker (a reader or an agent) spends its
// address's allowance and takes only public seats.
async function relayArxiv(request: Request, env: WorkerEnv, callerKind: 'reader' | 'agent' | 'worker') {
  const perCaller = callerKind !== 'worker';
  const { maxWaitMs } = ARXIV_SEATS[callerKind];
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
    const seat = await takeArxivSeat(env.REQUEST_QUOTA_LEDGER, callerKind);
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
    if (seat.code) console.warn(`arXiv beat not configured (${seat.code}); sending unpaced`);
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
