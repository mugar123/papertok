import { buildOpenAlexTrendFilter, normalizeReportFilters } from '../src/services/openAlexReportQuery.js';
import { buildScopusSearchQuery } from '../src/services/scopusQuery.js';
import {
  AIExplanationError,
  checkAIProviderHealth,
  handleAIExplanation,
  isDeepseekConfigured,
  isKimiConfigured,
  peekAIQuota,
  verifyFirebaseAccount,
} from './ai-explanation.js';
import { handlePaperRewrite } from './ai-rewrite.js';
import { handlePassageAnnotation } from './ai-annotation.js';
import {
  checkEmailProviderHealth,
  EmailNotificationError,
  getEmailDeliveryLedgerHealth,
  getEmailScheduleHealth,
  handleEmailNotificationRequest,
  handleEmailUnsubscribe,
  runEmailNotificationSchedule,
} from './email-notifications.js';
import {
  deduplicateCitationGraphPapers,
  extractCitationDoi,
  extractCitationOpenAlexId,
  normalizeCitationDoi,
  normalizeCitationRows,
} from '../src/utils/citationGraph.js';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.js';
import {
  handlePublicListRequest,
  PUBLIC_LIST_PATHS,
  PublicListApiError,
} from './public-list-api.js';
import {
  ACCOUNT_DELETE_PATH,
  AccountDeletionError,
  handleAccountDeletionRequest,
} from './account-deletion.js';
import {
  fetchPaperFigures,
  FIGURE_CACHE_SECONDS,
  FIGURE_EMPTY_CACHE_SECONDS,
  isArxivFigureId,
} from './paper-figures.js';
import {
  handleThreadAnchorRequest,
  threadAnchorErrorResponse,
} from './thread-anchor.js';
import { isServiceAccountConfigured } from './firestore-admin.js';
import { reserveRequestQuota } from './request-quota-ledger.js';

export { KimiBudgetLedger } from './kimi-budget-ledger.js';
export { EmailDeliveryLedger } from './email-delivery-ledger.js';
export { RequestQuotaLedger } from './request-quota-ledger.js';

// `mugar123.github.io` sigue en la lista: GitHub Pages redirige el sitio viejo
// al dominio nuevo, pero un service worker ya instalado alli puede servir el
// bundle cacheado una vez mas antes de ver la redireccion.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://papertok.app',
  'https://www.papertok.app',
  'https://mugar123.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
// Upstream deadlines, all in one place because every group that adds a route
// needs one. The ceiling on any of them is what the browser is willing to wait:
// the client gives `/report/trends` 10 s and the specialist sources 10 s, so a
// Worker that outlasts that is answering nobody.
const UPSTREAM_TIMEOUT_MS = 8000;
const SOURCE_UPSTREAM_TIMEOUT_MS = 6000;
const ARXIV_UPSTREAM_TIMEOUT_MS = 5000;

const CACHE_SECONDS = 6 * 60 * 60;
const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const CITATION_GRAPH_CACHE_SECONDS = 7 * 24 * 60 * 60;
const OA_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ARXIV_CACHE_SECONDS = 10 * 60;
const EMAIL_HEALTH_CACHE_SECONDS = 5 * 60;
const SCOPUS_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_HEALTH_CACHE_SECONDS = 10 * 60;
const OPENALEX_CACHE_SECONDS = 6 * 60 * 60;
// What a degraded answer is worth. A provider hiccup that lasts a second used to
// own its cache entry for the entire normal TTL -- six hours for physics, seven
// days for the citation graph -- so a single 500 blanked one query for everybody.
// Two minutes is long enough to absorb the retry burst of a feed fan-out and
// short enough that recovery is invisible.
const DEGRADED_CACHE_SECONDS = 120;
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
const DEFAULT_OPENALEX_GLOBAL_MINUTE_LIMIT = 300;
// The budget OpenAlex bills against is *daily* ($1/day, ~10.000 calls measured on
// `/health/openalex`), and until now the only ceiling was per minute: 300/min is
// 432.000/day, which bounds nothing. This leaves ~2.000 calls of headroom for the
// digest cron -- which spends outside this ledger -- and the health probe.
const DEFAULT_OPENALEX_GLOBAL_DAILY_LIMIT = 8_000;
// What a cold answer costs OpenAlex, per route, worst case. Reserved in one go
// before the work starts: a route that spends nine calls and reserves one is a
// route the daily ceiling does not actually cover.
const OPENALEX_CALLS = Object.freeze({
  relay: 1,
  // The two periods the report compares.
  trends: 2,
  // One `works/doi:` lookup, then up to two batches of twenty for each of the two
  // reference filters and the same again for citations.
  citationGraph: 9,
});
const SOURCE_CACHE_SECONDS = {
  biorxiv: 10 * 60,
  europepmc: 30 * 60,
  // Ten minutes is what the browser cache in `src/utils/sourceCache.js` already
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
const ARXIV_PARAMS = ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder'];
const PROTECTED_PROVIDER_PATHS = new Set([
  '/report/trends',
  '/related',
  '/citation-graph',
  '/sources/core',
  '/sources/physics',
  '/sources/scopus',
]);
const DEFAULT_PROVIDER_USER_MINUTE_LIMIT = 60;
const DEFAULT_PROVIDER_GLOBAL_MINUTE_LIMIT = 2_000;

// Ceilings for routes whose upstream limit is per provider rather than per user,
// and which the guest feed reads, so they cannot be gated behind an identity the
// way the credential-backed routes are. This is the same trade `/openalex/*`
// makes: origin gate plus edge cache plus a global per-minute ceiling reserved
// only after a cache miss.
//
// `/related` shares the `s2` namespace with `/sources/s2` on purpose. Both spend
// the same Semantic Scholar allowance, and a ceiling that only covered one of
// them would leave alive exactly the failure this replaces -- a limiter that
// counts per caller instead of per provider.
const DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT = 60;
const DEFAULT_S2_GLOBAL_MINUTE_LIMIT = 60;
const SHARED_MINUTE_CEILINGS = Object.freeze({
  // Each miss spends three E-utilities calls, six if every one is refused once
  // and retried -- what NCBI actually refuses is per-second bursts, which no
  // per-minute ceiling can see; `withPubmedRetry` is what absorbs those. So 60
  // route misses a minute are at most 360 calls, and `NCBI_API_KEY` (10 req/s)
  // buys 100 misses a minute at that worst case. 60 is a deliberate margin, not
  // the anonymous 3 req/s it once mirrored, and it has never been the binding
  // limit (151/151 reservations accepted, 2026-09-01).
  '/sources/pubmed': { namespace: 'pubmed', variable: 'PUBMED_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT },
  '/sources/s2': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT },
  '/related': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT },
});

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...headers,
    },
  });
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function allowedOrigins(env) {
  return new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
  ]);
}

function corsHeaders(origin, env) {
  return allowedOrigins(env).has(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

// The key is built from the values the handler is about to send upstream, never
// from the ones that arrived. Those are two different things everywhere in this
// file -- `limit=99` is clamped to 10, `categories=zzz` is dropped, a DOI is
// lowercased, a filter is trimmed -- and keying on the raw ones made every
// variant of a discarded parameter a fresh miss for one identical upstream call.
// On the routes OpenAlex bills that was money: `categories=zzz1`, `zzz2`, ...
// each cost two calls against a $1/day budget.
//
// The contract this puts on callers is the reverse of the old parameter
// allowlist, and stricter: whatever affects the answer must appear here, because
// nothing else does. Anything absent is not merely un-keyed, it is shared.
function canonicalCacheKey(request, origin, canonicalParams = {}) {
  const cacheUrl = new URL(`https://papertok.internal/cache${new URL(request.url).pathname}`);
  for (const [name, value] of Object.entries(canonicalParams)) {
    if (value !== null && value !== undefined && value !== '') {
      cacheUrl.searchParams.set(name, String(value));
    }
  }
  cacheUrl.searchParams.set('_origin', origin || 'no-origin');
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

async function authenticateProtectedProviderRequest(request, env, pathname) {
  if (!PROTECTED_PROVIDER_PATHS.has(pathname)) return null;
  return verifyFirebaseIdentity(request, env);
}

async function reserveProtectedProviderQuota(identity, env, origin) {
  if (!identity) return null;
  const minute = new Date().toISOString().slice(0, 16);
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
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
  });
  if (!reservation.accepted && reservation.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  if (!reservation.accepted) {
    return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
      'retry-after': '60',
    });
  }
  return null;
}

async function fetchOpenAlexPeriod(period, filters, env) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', buildOpenAlexTrendFilter(period, filters));
  url.searchParams.set('group_by', 'topics.id');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);

  const response = await fetchWithDeadline(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenAlex error: ${response.status}`);
  const data = await response.json();
  return {
    total: Math.max(0, Number(data?.meta?.count) || 0),
    groups: Array.isArray(data?.group_by) ? data.group_by : [],
  };
}

async function handleTrends(request, env, identity) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);

  const dates = {
    from: requestUrl.searchParams.get('from'),
    to: requestUrl.searchParams.get('to'),
    previousFrom: requestUrl.searchParams.get('previous_from'),
    previousTo: requestUrl.searchParams.get('previous_to'),
  };
  if (!Object.values(dates).every(isDate)) return json({ error: 'Invalid date range' }, 400, corsHeaders(origin, env));

  const filters = normalizeReportFilters({
    categories: (requestUrl.searchParams.get('categories') || '').split(',').filter(Boolean).slice(0, 12),
    countries: (requestUrl.searchParams.get('countries') || '').split(',').filter(Boolean).slice(0, 20),
  });

  return cacheResponse(request, origin, env, CACHE_SECONDS, async () => {
    const [current, previous] = await Promise.all([
      fetchOpenAlexPeriod({ fromStr: dates.from, toStr: dates.to }, filters, env),
      fetchOpenAlexPeriod({ fromStr: dates.previousFrom, toStr: dates.previousTo }, filters, env),
    ]);
    return { current, previous };
  }, {
    identity,
    openAlexCalls: OPENALEX_CALLS.trends,
    canonicalParams: {
      // The dates are exact by `isDate`, so they are already canonical. The
      // filters are not: `normalizeReportFilters` drops anything outside
      // `REPORT_OPENALEX_FIELDS` and anything that is not ISO-2, then sorts and
      // deduplicates what is left. Keying on what arrived meant `categories=zzz1`
      // and `zzz2` -- and `cs,math` against `math,cs` -- were separate misses for
      // one identical upstream query, at two billed OpenAlex calls each.
      from: dates.from,
      to: dates.to,
      previous_from: dates.previousFrom,
      previous_to: dates.previousTo,
      categories: filters.categories.join(','),
      countries: filters.countries.join(','),
    },
  });
}

function getSafeLimit(value, fallback = 8, max = 10) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

// The sibling of `reserveProtectedProviderQuota` for routes with no identity to
// charge, and the sibling of `reserveOpenAlexBudget` for providers that bill in
// requests rather than in money. It stays separate from that one because the
// budgets are different in kind: OpenAlex needs a daily ceiling because the
// allowance is a daily sum of dollars, while NCBI and Semantic Scholar publish a
// rate -- requests per second -- which a per-minute ceiling is the direct
// expression of, and a daily one would not bound at all.
async function reserveSharedMinuteQuota(request, env, origin) {
  const ceiling = SHARED_MINUTE_CEILINGS[new URL(request.url).pathname];
  if (!ceiling) return null;
  const minute = new Date().toISOString().slice(0, 16);
  const limit = boundedLimit(env[ceiling.variable], ceiling.fallback, 100_000);
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `${ceiling.namespace}:${minute}`,
    subject: `${ceiling.namespace}:shared`,
    subjectLimit: limit,
    globalLimit: limit,
  });
  if (!reservation.accepted && reservation.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  if (!reservation.accepted) {
    return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
      'retry-after': '60',
    });
  }
  return null;
}

// `ttl` may be a function of the payload, because whether an answer deserves its
// full TTL is something only the fetcher's result can say: a 200 assembled from a
// fallback after the real provider refused is not worth six hours.
async function cacheResponse(request, origin, env, ttl, fetcher, options = {}) {
  const cacheKey = canonicalCacheKey(request, origin, options.canonicalParams);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const sharedQuotaError = await reserveSharedMinuteQuota(request, env, origin);
  if (sharedQuotaError) return sharedQuotaError;
  const quotaError = await reserveProtectedProviderQuota(options.identity || null, env, origin);
  if (quotaError) return quotaError;
  if (options.openAlexCalls) {
    const budgetError = await reserveOpenAlexBudget(env, origin, options.openAlexCalls);
    if (budgetError) return budgetError;
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
  return response;
}

async function handleRelated(request, env, identity) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  // Trimmed once, then used for the key and for the upstream URL alike. It used
  // to be trimmed only on the way into the cache key, so `paper_id=x` and
  // `paper_id=%20x%20` shared an entry while asking Semantic Scholar two
  // different questions -- whichever landed first owned the answer for a day.
  const paperId = (requestUrl.searchParams.get('paper_id') || '').trim();
  if (!/^(?:DOI:10\.|ARXIV:|[a-f0-9]{40}$)/i.test(paperId) || paperId.length > 300) {
    return json({ error: 'Invalid paper id' }, 400, corsHeaders(origin, env));
  }
  // Twenty, not the eight-of-ten the other routes use: the feed's recommendation
  // seeding asked Semantic Scholar for twenty directly, and this route is what it
  // now goes through.
  const limit = getSafeLimit(requestUrl.searchParams.get('limit'), 8, 20);
  return cacheResponse(request, origin, env, RELATED_CACHE_SECONDS, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${limit}`;
    const headers = { accept: 'application/json' };
    if (env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = env.SEMANTIC_SCHOLAR_API_KEY;
    const response = await fetchWithDeadline(url, { headers }, SOURCE_UPSTREAM_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Semantic Scholar error: ${response.status}`);
    return response.json();
  }, { identity, canonicalParams: { paper_id: paperId, limit: String(limit) } });
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
// `TimeoutError`.
export function fetchWithDeadline(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const response = await fetchWithDeadline(url, options, timeoutMs);
  if (!response.ok) {
    // The status travels on the error because callers need to tell a provider
    // that answered "I do not have this" from one that did not answer at all.
    const error = new Error(`Upstream error: ${response.status}`);
    error.status = response.status;
    // And the provider's own backoff, when it gave one. Inventing a number here
    // would be guessing at somebody else's window.
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  return response.json();
}

function addOpenAlexCredentials(url, env) {
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url;
}

async function fetchOpenAlexJsonWithFallback(url, env, timeoutMs) {
  try {
    return await fetchJsonWithTimeout(url, { headers: { accept: 'application/json' } }, timeoutMs);
  } catch (error) {
    if (!env.OPENALEX_API_KEY || !url.searchParams.has('api_key')) throw error;
    const anonymousUrl = new URL(url);
    anonymousUrl.searchParams.delete('api_key');
    return fetchJsonWithTimeout(anonymousUrl, { headers: { accept: 'application/json' } }, timeoutMs);
  }
}

function reconstructOpenAlexAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  return Object.entries(invertedIndex)
    .flatMap(([word, positions]) => (Array.isArray(positions) ? positions : []).map(position => [position, word]))
    .sort(([positionA], [positionB]) => positionA - positionB)
    .map(([, word]) => word)
    .join(' ');
}

function mapCitationGraphWork(work) {
  if (!work?.id || !work?.title) return null;
  const doi = normalizeCitationDoi(work.doi || work.ids?.doi);
  const openAlexId = String(work.id).split('/').pop();
  const bestLocation = work.best_oa_location || work.primary_location || {};
  const publicationType = work.type || 'article';
  const isPreprint = publicationType === 'preprint';
  const abstract = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  return {
    id: doi || `openalex:${openAlexId}`,
    openAlexId,
    sources: { primary: 'openalex', enrichedBy: ['opencitations'] },
    title: work.title,
    abstract: abstract ? abstract.slice(0, 4000) : 'Resumen no disponible.',
    authors: (work.authorships || []).slice(0, 20).map(authorship => ({
      id: String(authorship.author?.id || '').split('/').pop() || undefined,
      name: authorship.author?.display_name || '',
    })).filter(author => author.name),
    doi: doi || undefined,
    year: work.publication_year,
    published: work.publication_date || (work.publication_year ? `${work.publication_year}-01-01` : ''),
    journal: work.primary_location?.source?.display_name,
    publicationType,
    publicationStatus: isPreprint ? 'preprint' : 'published',
    peerReviewed: !isPreprint,
    openAccess: Boolean(work.open_access?.is_oa || bestLocation.pdf_url),
    pdfUrl: bestLocation.pdf_url || undefined,
    landingPageUrl: bestLocation.landing_page_url || (doi ? `https://doi.org/${doi}` : work.id),
    citationCount: Number.isFinite(work.cited_by_count) ? work.cited_by_count : 0,
    citationCountKnown: Number.isFinite(work.cited_by_count),
    concepts: (work.concepts || []).filter(concept => (concept.score ?? 1) > 0).slice(0, 8),
    topics: (work.topics || []).slice(0, 3),
    primaryTopic: work.primary_topic || null,
  };
}

function mapOpenCitationsMetaWork(work) {
  const doi = extractCitationDoi(work?.id);
  if (!doi || !work?.title) return null;
  const openAlexId = extractCitationOpenAlexId(work.id);
  const publicationType = String(work.type || 'article').toLowerCase().replace(/\s+/g, '-');
  const authorNames = String(work.author || '').split(';').map(author => author
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim()).filter(Boolean);
  const venue = String(work.venue || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const year = Number.parseInt(String(work.pub_date || '').slice(0, 4), 10);
  return {
    id: doi,
    openAlexId: openAlexId || undefined,
    sources: { primary: 'opencitations', enrichedBy: [] },
    title: work.title,
    abstract: 'Resumen no disponible.',
    authors: authorNames.slice(0, 20).map(name => ({ name })),
    doi,
    year: Number.isFinite(year) ? year : undefined,
    published: work.pub_date || '',
    journal: venue || undefined,
    publisher: String(work.publisher || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim() || undefined,
    publicationType,
    publicationStatus: publicationType === 'preprint' ? 'preprint' : 'published',
    peerReviewed: publicationType !== 'preprint',
    openAccess: false,
    landingPageUrl: `https://doi.org/${doi}`,
    citationCount: 0,
    citationCountKnown: false,
  };
}

const CITATION_GRAPH_OPENALEX_SELECT = [
  'id',
  'doi',
  'ids',
  'title',
  'abstract_inverted_index',
  'authorships',
  'publication_year',
  'publication_date',
  'type',
  'primary_location',
  'best_oa_location',
  'open_access',
  'cited_by_count',
  'concepts',
  'topics',
  'primary_topic',
].join(',');

async function fetchOpenAlexCurrentWork(doi, env) {
  const url = addOpenAlexCredentials(
    new URL(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`),
    env,
  );
  url.searchParams.set('select', 'id,referenced_works,cited_by_count');
  try {
    return { work: await fetchOpenAlexJsonWithFallback(url, env, 6500), failed: false };
  } catch (error) {
    // A DOI OpenAlex has never heard of is an answer, and the graph built without
    // it is the real one. Anything else is an outage, and the difference decides
    // whether the result may own its cache entry for a week.
    return { work: null, failed: error?.status !== 404 };
  }
}

async function fetchOpenAlexWorksByFilter(filterName, values, env) {
  const uniqueValues = [...new Set(values.filter(Boolean))].slice(0, 40);
  const chunks = [];
  for (let index = 0; index < uniqueValues.length; index += 20) {
    chunks.push(uniqueValues.slice(index, index + 20));
  }
  const batches = await Promise.allSettled(chunks.map(async chunk => {
    const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
    url.searchParams.set('filter', `${filterName}:${chunk.join('|')}`);
    url.searchParams.set('per-page', String(chunk.length));
    url.searchParams.set('select', CITATION_GRAPH_OPENALEX_SELECT);
    const payload = await fetchOpenAlexJsonWithFallback(url, env, 7500);
    return payload?.results || [];
  }));
  // A rejected batch is a shorter answer, and until now it was a shorter answer
  // that looked exactly like a complete one -- and got cached for seven days.
  return {
    works: batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []),
    failed: batches.some(batch => batch.status === 'rejected'),
  };
}

async function fetchOpenCitationsMetadata(connections, env) {
  const dois = [...new Set(connections.map(item => item.doi).filter(Boolean))].slice(0, 16);
  const chunks = [];
  for (let index = 0; index < dois.length; index += 5) chunks.push(dois.slice(index, index + 5));
  const headers = { accept: 'application/json' };
  if (env.OPENCITATIONS_ACCESS_TOKEN) headers.authorization = env.OPENCITATIONS_ACCESS_TOKEN;
  const batches = await Promise.allSettled(chunks.map(chunk => {
    const ids = chunk.map(doi => `doi:${encodeURIComponent(doi)}`).join('__');
    return fetchJsonWithTimeout(`https://api.opencitations.net/meta/v1/metadata/${ids}`, { headers }, 9000);
  }));
  return batches
    .flatMap(batch => batch.status === 'fulfilled' ? batch.value : [])
    .map(mapOpenCitationsMetaWork)
    .filter(Boolean);
}

async function resolveCitationConnections(connections, env, limit, relation) {
  const candidates = connections.slice(0, Math.min(40, limit * 5));
  const openAlexIds = candidates.map(item => item.openAlexId).filter(Boolean);
  const doisWithoutOpenAlexId = candidates.filter(item => !item.openAlexId).map(item => item.doi).filter(Boolean);
  const [byId, byDoi] = await Promise.all([
    fetchOpenAlexWorksByFilter('openalex_id', openAlexIds, env),
    fetchOpenAlexWorksByFilter('doi', doisWithoutOpenAlexId, env),
  ]);
  let failed = byId.failed || byDoi.failed;
  let mapped = deduplicateCitationGraphPapers(
    [...byId.works, ...byDoi.works].map(mapCitationGraphWork).filter(Boolean),
    40,
  );
  if (mapped.length < limit) {
    const metaFallback = await fetchOpenCitationsMetadata(candidates, env).catch(() => {
      failed = true;
      return [];
    });
    mapped = deduplicateCitationGraphPapers([...mapped, ...metaFallback], 40);
  }
  mapped.sort((paperA, paperB) => {
    if (relation === 'citation') {
      return (paperB.year || 0) - (paperA.year || 0)
        || (paperB.citationCount || 0) - (paperA.citationCount || 0);
    }
    return (paperB.citationCount || 0) - (paperA.citationCount || 0)
      || (paperB.year || 0) - (paperA.year || 0);
  });
  return { papers: mapped.slice(0, limit), failed };
}

async function fetchOpenAlexCitingWorks(openAlexId, env, limit) {
  if (!openAlexId) return [];
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  url.searchParams.set('filter', `cites:${openAlexId}`);
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per-page', String(Math.min(40, limit * 4)));
  url.searchParams.set('select', CITATION_GRAPH_OPENALEX_SELECT);
  const payload = await fetchOpenAlexJsonWithFallback(url, env, 7500);
  return deduplicateCitationGraphPapers(
    (payload?.results || []).map(mapCitationGraphWork).filter(Boolean),
    limit,
  );
}

// `partial` and `degraded` are not the same thing, and conflating them is what
// made this fault hard to see. `partial` says the answer was assembled from more
// than one provider -- which is also what a healthy, heavily cited paper looks
// like, because past three hundred citations the route asks OpenAlex on purpose.
// `degraded` says something upstream failed. Only the second one is a reason to
// refuse the seven-day TTL.
function citationGraphCacheSeconds(payload) {
  return payload?.degraded ? DEGRADED_CACHE_SECONDS : CITATION_GRAPH_CACHE_SECONDS;
}

async function fetchOpenCitationsRows(doi, relation, env) {
  const url = new URL(`https://api.opencitations.net/index/v2/${relation}/doi:${encodeURIComponent(doi)}`);
  url.searchParams.set('format', 'json');
  if (relation === 'citations') url.searchParams.set('sort', 'desc(creation)');
  const headers = { accept: 'application/json' };
  if (env.OPENCITATIONS_ACCESS_TOKEN) headers.authorization = env.OPENCITATIONS_ACCESS_TOKEN;
  return fetchJsonWithTimeout(url, { headers }, 7500);
}

async function handleCitationGraph(request, env, identity) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const doi = normalizeCitationDoi(requestUrl.searchParams.get('doi'));
  if (!/^10\.\d{4,9}\/.+/.test(doi) || doi.length > 300) {
    return json({ error: 'Invalid DOI' }, 400, corsHeaders(origin, env));
  }
  const limit = getSafeLimit(requestUrl.searchParams.get('limit'), 8, 10);

  return cacheResponse(request, origin, env, citationGraphCacheSeconds, async () => {
    const { work: currentWork, failed: currentWorkFailed } = await fetchOpenAlexCurrentWork(doi, env);
    const currentOpenAlexId = String(currentWork?.id || '').split('/').pop();
    const shouldUseOpenAlexForCitations = (currentWork?.cited_by_count || 0) > 300;
    const [referenceResult, citationResult] = await Promise.allSettled([
      fetchOpenCitationsRows(doi, 'references', env),
      shouldUseOpenAlexForCitations
        ? Promise.resolve([])
        : fetchOpenCitationsRows(doi, 'citations', env),
    ]);

    let partial = referenceResult.status === 'rejected' || citationResult.status === 'rejected';
    // The worst case this exists for did not even set `partial`: a transient
    // failure of the `works/doi:` lookup left `currentWork` null, and if
    // OpenCitations was empty too the route answered `{references: [],
    // citations: [], partial: false}` -- and cached that for a week.
    let degraded = currentWorkFailed || partial;
    let referenceConnections = normalizeCitationRows(
      referenceResult.status === 'fulfilled' ? referenceResult.value : [],
      'reference',
      doi,
    );
    let citationConnections = normalizeCitationRows(
      citationResult.status === 'fulfilled' ? citationResult.value : [],
      'citation',
      doi,
    );

    if (!referenceConnections.length && currentWork?.referenced_works?.length) {
      referenceConnections = currentWork.referenced_works.map(id => ({
        openAlexId: String(id).split('/').pop(),
        doi: '',
        relation: 'reference',
      }));
      partial = true;
    }

    const resolvedReferences = await resolveCitationConnections(referenceConnections, env, limit, 'reference');
    const references = resolvedReferences.papers;
    degraded = degraded || resolvedReferences.failed;
    let citations;
    if (shouldUseOpenAlexForCitations || !citationConnections.length) {
      citations = await fetchOpenAlexCitingWorks(currentOpenAlexId, env, limit).catch(() => {
        degraded = true;
        return [];
      });
      if (shouldUseOpenAlexForCitations || citations.length) partial = true;
    } else {
      const resolvedCitations = await resolveCitationConnections(citationConnections, env, limit, 'citation');
      citations = resolvedCitations.papers;
      degraded = degraded || resolvedCitations.failed;
    }

    return {
      references,
      citations,
      counts: {
        references: referenceConnections.length,
        citations: Math.max(citationConnections.length, Number(currentWork?.cited_by_count) || 0),
      },
      source: partial ? 'opencitations+openalex' : 'opencitations',
      partial,
      degraded,
    };
  }, {
    identity,
    openAlexCalls: OPENALEX_CALLS.citationGraph,
    // The DOI reaching upstream is the normalized one -- lowercased, stripped of
    // its `doi.org` prefix and of trailing punctuation -- so keying on the raw one
    // made every capitalisation of the same DOI a separate miss worth up to nine
    // billed OpenAlex calls. Same for a `limit` that `getSafeLimit` clamps to ten.
    canonicalParams: { doi, limit: String(limit) },
  });
}

async function handleOpenAccess(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const doi = (requestUrl.searchParams.get('doi') || '').trim().toLowerCase();
  if (!/^10\.\d{4,9}\/.+/.test(doi) || doi.length > 300) {
    return json({ error: 'Invalid DOI' }, 400, corsHeaders(origin, env));
  }
  return cacheResponse(request, origin, env, OA_CACHE_SECONDS, async () => {
    const email = env.UNPAYWALL_EMAIL || 'app@papertok.io';
    const response = await fetchWithDeadline(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, {
      headers: { accept: 'application/json' },
    }, SOURCE_UPSTREAM_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Unpaywall error: ${response.status}`);
    return response.json();
  }, { canonicalParams: { doi } });
}

function safeArxivParam(name, rawValue) {
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

async function handleArxiv(request, env) {
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
  const cacheKey = canonicalCacheKey(request, origin, Object.fromEntries(upstreamUrl.searchParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const response = await fetchWithDeadline(upstreamUrl.toString(), {
    headers: {
      accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  }, ARXIV_UPSTREAM_TIMEOUT_MS);
  if (!response.ok) throw new Error(`arXiv error: ${response.status}`);
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

function safeSourceQuery(value) {
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
function sourceRequestContext(request, env, { limitFallback = 8, limitMax = 10 } = {}) {
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
function sourceCacheParams(context, extra) {
  return { page: String(context.page), limit: String(context.limit), ...extra };
}

function utcDateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Every `/sources/*` upstream reaches the network through here, and none of
// them used to carry a deadline: a hung provider held the subrequest open with
// nothing to cut it, while the browser had already given up. Six seconds is
// deliberately above the client's 4 s per-source budget — the slowest real
// upstream measured is OpenReview at 5.2 s cold, and letting it finish still
// pays off because the answer lands in the edge cache for the next reader,
// even though the reader who triggered it has moved on.
function fetchJsonUpstream(url, headers = {}) {
  return fetchJsonWithTimeout(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      ...headers,
    },
  }, SOURCE_UPSTREAM_TIMEOUT_MS);
}

async function handleBioRxiv(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const category = String(context.requestUrl.searchParams.get('category') || '').trim().toLowerCase();
  if (!/^[a-z][a-z &-]{1,80}$/.test(category)) {
    return json({ error: 'Invalid bioRxiv category' }, 400, corsHeaders(context.origin, env));
  }

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.biorxiv, async () => {
    // bioRxiv pages in fixed groups of 30, so request the matching cursor and trim client-side.
    const cursor = (context.page - 1) * 30;
    const encodedCategory = encodeURIComponent(category.replace(/\s+/g, '_'));
    const url = `https://api.biorxiv.org/details/biorxiv/${utcDateOffset(-180)}/${utcDateOffset(0)}/${cursor}/json?category=${encodedCategory}`;
    const data = await fetchJsonUpstream(url);
    return { ...data, collection: (data?.collection || []).slice(0, context.limit) };
  }, { canonicalParams: sourceCacheParams(context, { category }) });
}

async function handleEuropePmc(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing Europe PMC query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.europepmc, async () => {
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    url.searchParams.set('query', context.sort === 'recent' ? `(${query}) sort_date:y` : query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('pageSize', String(context.limit));
    url.searchParams.set('page', String(context.page));
    return fetchJsonUpstream(url);
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

const PUBMED_EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const PUBMED_MAX_LIMIT = 50;
const PUBMED_DEFAULT_LIMIT = 25;

// NCBI asks every automated caller to identify itself with `tool` and `email`,
// and rate-limits by API key when one is present and by source IP when it is not.
// The key is optional here for the same reason `CORE_API_KEY` is: without it the
// route still answers, just against the anonymous 3 req/s allowance.
function pubmedUrl(endpoint, env, params) {
  const url = new URL(`${PUBMED_EUTILS_BASE}/${endpoint}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('tool', 'papertok');
  url.searchParams.set('email', 'app@papertok.io');
  // Built from an explicit parameter list, so an `api_key` a caller tried to send
  // is never among them; only the Worker's own can reach NCBI.
  if (env.NCBI_API_KEY) url.searchParams.set('api_key', env.NCBI_API_KEY);
  return url;
}

// NCBI counts per second, and a burst of route misses spends the calls in
// parallel: eight misses are eight esearch calls at once and then sixteen
// esummary+efetch calls at once, past the 10 req/s the key buys. Measured
// 2026-09-01 and reproduced 2026-09-02: 8 concurrent misses, 3 refused with a
// 429. The window is a second, so one retry after a short, jittered wait lands
// in the next one. One, not more: a second refusal means the key is exhausted,
// and that is the ledger's problem, not this route's. And when NCBI names a
// wait longer than the two seconds `PUBMED_RETRY_MAX_MS` allows, the refusal
// is relayed as it is: each fetch is already budgeted six seconds
// (`SOURCE_UPSTREAM_TIMEOUT_MS`), and stacking a longer wait on top of that is
// more than the caller of that fetch is waiting for -- the client already
// knows what a 429 with `retry-after` means.
const PUBMED_RETRY_BASE_MS = 300;
const PUBMED_RETRY_JITTER_MS = 500;
const PUBMED_RETRY_MAX_MS = 2_000;

function pubmedRetryDelayMs(error) {
  if (error?.status !== 429) return null;
  // Trimmed so a whitespace-only value takes the empty branch instead of
  // coercing to the number 0 and reading as an advertised instant retry.
  const advertised = String(error.retryAfter ?? '').trim();
  if (advertised !== '') {
    const advertisedMs = Number(advertised) * 1000;
    // A negative number is nonsense from upstream, not a request to retry
    // instantly -- it must not be more aggressive than a legitimate `0`.
    if (!Number.isFinite(advertisedMs) || advertisedMs < 0) return null;
    return advertisedMs <= PUBMED_RETRY_MAX_MS ? advertisedMs : null;
  }
  return PUBMED_RETRY_BASE_MS + Math.random() * PUBMED_RETRY_JITTER_MS;
}

async function withPubmedRetry(attempt) {
  try {
    return await attempt();
  } catch (error) {
    const delayMs = pubmedRetryDelayMs(error);
    if (delayMs === null) throw error;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return attempt();
  }
}

// E-utilities cannot answer a search in one call: esearch returns identifiers,
// esummary returns the records, and efetch is the only one that carries the
// abstract. Run from the browser that was three serial round trips per feed load
// with nothing cacheable in between -- the measured floor under every guest load.
// Here the chain is two hops, because esummary and efetch only depend on esearch
// and not on each other, and the whole thing lands in one edge-cache entry.
async function handlePubmed(request, env) {
  const context = sourceRequestContext(request, env, {
    limitFallback: PUBMED_DEFAULT_LIMIT,
    limitMax: PUBMED_MAX_LIMIT,
  });
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing PubMed query' }, 400, corsHeaders(context.origin, env));

  // A batch that lost its abstracts is exactly the case the payload-dependent TTL
  // was added for: it is a real answer, but not one worth serving for ten minutes.
  const ttl = payload => (payload?._papertok?.efetch === 'unavailable'
    ? DEGRADED_CACHE_SECONDS
    : SOURCE_CACHE_SECONDS.pubmed);

  return cacheResponse(request, context.origin, env, ttl, async () => {
    const search = await withPubmedRetry(() => fetchJsonUpstream(pubmedUrl('esearch.fcgi', env, {
      db: 'pubmed',
      term: query,
      retmode: 'json',
      retmax: String(context.limit),
      retstart: String((context.page - 1) * context.limit),
    })));
    const esearchresult = search?.esearchresult || {};
    // Identifiers go straight back into two upstream URLs, so anything that is
    // not a PubMed identifier is dropped rather than forwarded.
    const pmids = (esearchresult.idlist || [])
      .map(value => String(value || '').trim())
      .filter(value => /^\d{1,12}$/.test(value));
    if (pmids.length === 0) {
      return { esearchresult: { ...esearchresult, idlist: [] }, result: {}, efetch: '', _papertok: { efetch: 'empty' } };
    }

    const [summary, efetch] = await Promise.all([
      withPubmedRetry(() => fetchJsonUpstream(pubmedUrl('esummary.fcgi', env, {
        db: 'pubmed',
        id: pmids.join(','),
        retmode: 'json',
      }))),
      // The abstract half is enrichment: the client already falls back to OpenAlex
      // and Europe PMC when it is missing, so losing efetch must not lose the
      // records esummary did return. The marker is what tells a reader -- and the
      // TTL policy -- that this answer is the degraded one.
      withPubmedRetry(() => fetchPubmedArticleXml(pmids, env)).catch(() => ''),
    ]);

    return {
      esearchresult: { ...esearchresult, idlist: pmids },
      result: summary?.result || {},
      efetch,
      _papertok: { efetch: efetch ? 'ok' : 'unavailable' },
    };
  }, { canonicalParams: sourceCacheParams(context, { q: query }) });
}

async function fetchPubmedArticleXml(pmids, env) {
  const url = pubmedUrl('efetch.fcgi', env, { db: 'pubmed', id: pmids.join(','), retmode: 'xml' });
  const response = await fetchWithDeadline(url, {
    headers: {
      accept: 'application/xml, text/xml;q=0.9',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  }, SOURCE_UPSTREAM_TIMEOUT_MS);
  if (!response.ok) {
    // Same shape as `fetchJsonWithTimeout`'s error, so the retry can tell a 429
    // from a 503 and honour the wait NCBI advertised, if it advertised one.
    const error = new Error(`PubMed efetch error: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  // Read under the same deadline that covered the headers: efetch answers the
  // largest body of the three and a document that stops halfway is a stall, not a
  // short answer.
  return response.text();
}

// `externalIds` carries the DOI and the arXiv id; without them a paper from
// this source is known only by its S2 hash, which no paper page can load.
const S2_SEARCH_FIELDS = 'paperId,title,abstract,authors,year,isOpenAccess,venue,publicationTypes,citationCount,referenceCount,openAccessPdf,externalIds';
const S2_MAX_LIMIT = 25;
const S2_MAX_OFFSET = 1_000;

// Semantic Scholar was rate-limited in the browser by a module variable, which
// counts per tab rather than per provider: N tabs were N times the allowance, and
// the two browser callers did not even share the one counter. The limit belongs
// where there is a single copy of it, next to the API key, which is here.
async function handleSemanticScholar(request, env) {
  const context = sourceRequestContext(request, env, {
    limitFallback: S2_MAX_LIMIT,
    limitMax: S2_MAX_LIMIT,
  });
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing Semantic Scholar query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.s2, async () => {
    const url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
    url.searchParams.set('query', query);
    // Semantic Scholar refuses `offset + limit` past a thousand with a 400. Paging
    // beyond the end of a result set has to run out of records, not turn into an
    // upstream error the feed reports as a dead source.
    url.searchParams.set('offset', String(Math.min((context.page - 1) * context.limit, S2_MAX_OFFSET - context.limit)));
    url.searchParams.set('limit', String(context.limit));
    url.searchParams.set('fields', S2_SEARCH_FIELDS);
    const headers = env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {};
    return fetchJsonUpstream(url, headers);
  }, { canonicalParams: sourceCacheParams(context, { q: query }) });
}

function compactOpenReviewNote(note) {
  const allowedContent = [
    'title',
    'abstract',
    'authors',
    'authorids',
    'venue',
    'venueid',
    'pdf',
    'html',
    'keywords',
    'doi',
    'arxiv',
    'arxiv_id',
    'external_id',
  ];
  return {
    id: note?.id,
    forum: note?.forum,
    domain: note?.domain,
    cdate: note?.cdate,
    tcdate: note?.tcdate,
    pdate: note?.pdate,
    content: Object.fromEntries(allowedContent
      .filter(key => note?.content?.[key] !== undefined)
      .map(key => [key, note.content[key]])),
  };
}

function isOpenReviewSubmission(note) {
  const domain = String(note?.domain || '').toLowerCase();
  return ![
    'dblp.org',
    'openreview.net/public_article',
    'openreview.net/arxiv',
    'openreview.net/orcid',
  ].some(prefix => domain.startsWith(prefix));
}

// The date the card shows. `mapOpenReviewNote` builds `published` from `pdate`,
// then `cdate`, then `tcdate`; an order that disagrees with the date printed on
// the card reads as no order at all, so the Worker sorts by the same precedence.
function openReviewNoteDate(note) {
  return Number(note?.pdate || note?.cdate || note?.tcdate) || 0;
}

async function handleOpenReview(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing OpenReview query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.openreview, async () => {
    const url = new URL('https://api2.openreview.net/notes/search');
    url.searchParams.set('query', query);
    url.searchParams.set('source', 'forum');
    url.searchParams.set('limit', String(Math.min(50, context.limit * 3)));
    url.searchParams.set('offset', String((context.page - 1) * context.limit));
    // No `sort` on the URL. api2's search accepts `cdate:desc` (and refuses
    // `tcdate`, `mdate` and `pdate` with a 400) but does not act on it: measured
    // 2026-09-02, `cdate:asc`, `cdate:desc`, `tmdate:*` and no sort at all
    // returned the same sequence for three different queries. Recency is
    // therefore ours to produce, over the relevance pool `limit * 3` fetches.
    const payload = await fetchJsonUpstream(url);
    const notes = (payload?.notes || []).filter(isOpenReviewSubmission);
    if (context.sort === 'recent') {
      notes.sort((a, b) => openReviewNoteDate(b) - openReviewNoteDate(a));
    }
    return {
      notes: notes.slice(0, context.limit).map(compactOpenReviewNote),
      count: Number(payload?.count) || 0,
    };
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

async function handleHuggingFacePapers(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing Hugging Face query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.huggingface, async () => {
    const url = new URL('https://huggingface.co/api/papers/search');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(context.limit));
    url.searchParams.set('p', String(context.page - 1));
    const payload = await fetchJsonUpstream(url);
    const papers = Array.isArray(payload) ? payload : payload?.papers || [];
    if (context.sort === 'recent') {
      papers.sort((a, b) => Date.parse(b?.paper?.publishedAt || b?.publishedAt || 0)
        - Date.parse(a?.paper?.publishedAt || a?.publishedAt || 0));
    }
    return { papers: papers.slice(0, context.limit) };
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

async function handleICite(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const pmids = [...new Set(String(requestUrl.searchParams.get('pmids') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean))];
  if (pmids.length === 0 || pmids.length > 200 || pmids.some(pmid => !/^\d{1,12}$/.test(pmid))) {
    return json({ error: 'Invalid PubMed identifiers' }, 400, corsHeaders(origin, env));
  }

  return cacheResponse(request, origin, env, SOURCE_CACHE_SECONDS.icite, async () => {
    const url = new URL('https://icite.od.nih.gov/api/pubs');
    url.searchParams.set('pmids', pmids.join(','));
    url.searchParams.set('fl', [
      'pmid',
      'doi',
      'title',
      'apt',
      'citation_count',
      'relative_citation_ratio',
      'nih_percentile',
      'is_clinical',
      'provisional',
    ].join(','));
    const payload = await fetchJsonUpstream(url);
    return { data: Array.isArray(payload?.data) ? payload.data : [] };
  }, { canonicalParams: { pmids: pmids.join(',') } });
}

async function handleHuggingFaceResources(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const arxivId = String(requestUrl.searchParams.get('arxiv_id') || '').trim().replace(/v\d+$/i, '');
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) {
    return json({ error: 'Invalid arXiv identifier' }, 400, corsHeaders(origin, env));
  }

  return cacheResponse(request, origin, env, SOURCE_CACHE_SECONDS.huggingFaceResources, async () => {
    const payload = await fetchJsonUpstream(`https://huggingface.co/api/papers/${encodeURIComponent(arxivId)}`);
    return {
      id: payload?.id || arxivId,
      githubRepo: payload?.githubRepo || null,
      projectPage: payload?.projectPage || null,
      linkedModels: (payload?.linkedModels || []).slice(0, 6).map(model => ({
        id: model?.id,
        downloads: Number(model?.downloads) || 0,
        likes: Number(model?.likes) || 0,
        pipeline_tag: model?.pipeline_tag || null,
      })),
      linkedDatasets: (payload?.linkedDatasets || []).slice(0, 6).map(dataset => ({
        id: dataset?.id,
        downloads: Number(dataset?.downloads) || 0,
        likes: Number(dataset?.likes) || 0,
      })),
    };
  }, { canonicalParams: { arxiv_id: arxivId } });
}

async function handlePaperFigures(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const arxivId = String(requestUrl.searchParams.get('arxiv_id') || '').trim().replace(/v\d+$/i, '');
  if (!isArxivFigureId(arxivId)) {
    return json({ error: 'Invalid arXiv identifier' }, 400, corsHeaders(origin, env));
  }

  // A paper that yielded nothing is retried in an hour rather than in a month:
  // the renderers publish HTML for new papers on their own schedule.
  return cacheResponse(
    request,
    origin,
    env,
    (payload) => (payload?.figures?.length ? FIGURE_CACHE_SECONDS : FIGURE_EMPTY_CACHE_SECONDS),
    () => fetchPaperFigures(arxivId),
    { canonicalParams: { arxiv_id: arxivId } },
  );
}

async function handleCore(request, env, identity) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing CORE query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.core, async () => {
    const url = new URL('https://api.core.ac.uk/v3/search/works/');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(context.limit));
    url.searchParams.set('offset', String((context.page - 1) * context.limit));
    const headers = env.CORE_API_KEY ? { authorization: `Bearer ${env.CORE_API_KEY}` } : {};
    return fetchJsonUpstream(url, headers);
    // No `sort`: this handler never sends it upstream, so two entries would hold
    // one identical answer.
  }, { identity, canonicalParams: sourceCacheParams(context, { q: query }) });
}

async function handleOsti(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing OSTI query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.osti, async () => {
    const url = new URL('https://www.osti.gov/api/v1/records');
    url.searchParams.set('q', query);
    url.searchParams.set('rows', String(context.limit));
    url.searchParams.set('page', String(context.page));
    if (context.sort === 'recent') {
      url.searchParams.set('sort', 'publication_date');
      url.searchParams.set('order', 'desc');
    }
    return fetchJsonUpstream(url);
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

async function handleNasa(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing NASA query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.nasa, async () => {
    const url = new URL('https://ntrs.nasa.gov/api/citations/search');
    url.searchParams.set('q', query);
    url.searchParams.set('page.size', String(context.limit));
    url.searchParams.set('page.from', String((context.page - 1) * context.limit));
    if (context.sort === 'recent') {
      url.searchParams.set('published.gte', `${new Date().getUTCFullYear() - 3}-01-01`);
      url.searchParams.set('sort.field', 'id');
      url.searchParams.set('sort.order', 'desc');
    }
    return fetchJsonUpstream(url);
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

function adsQueryFromTerms(query) {
  return `abs:(${query}) AND database:(astronomy OR physics)`;
}

async function fetchAdsLiterature(context, query, env) {
  const url = new URL('https://api.adsabs.harvard.edu/v1/search/query');
  url.searchParams.set('q', adsQueryFromTerms(query));
  url.searchParams.set('rows', String(context.limit));
  url.searchParams.set('start', String((context.page - 1) * context.limit));
  url.searchParams.set('sort', context.sort === 'recent' ? 'date desc' : 'score desc');
  url.searchParams.set('fl', [
    'bibcode',
    'title',
    'author',
    'abstract',
    'year',
    'pubdate',
    'doi',
    'identifier',
    'arxiv_class',
    'keyword',
    'citation_count',
    'reference',
    'property',
    'data',
    'esources',
    'pub',
    'doctype',
  ].join(','));

  const response = await fetchWithDeadline(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${env.NASA_ADS_API_TOKEN}`,
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  }, SOURCE_UPSTREAM_TIMEOUT_MS);
  if (!response.ok) {
    const error = new Error(`NASA ADS error: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  const compactDocs = (data?.response?.docs || []).map(document => ({
    bibcode: document.bibcode,
    title: document.title,
    author: (document.author || []).slice(0, 20),
    abstract: document.abstract,
    year: document.year,
    pubdate: document.pubdate,
    doi: document.doi,
    identifier: document.identifier,
    arxiv_class: document.arxiv_class,
    keyword: (document.keyword || []).slice(0, 20),
    citation_count: document.citation_count,
    reference_count: Array.isArray(document.reference) ? document.reference.length : 0,
    property: document.property,
    has_data: Array.isArray(document.data) && document.data.length > 0,
    esources: document.esources,
    pub: document.pub,
    doctype: document.doctype,
  }));
  return {
    ...data,
    response: { ...data.response, docs: compactDocs },
    _papertok: {
      source: 'nasa-ads',
      fallback: false,
      quota: {
        limit: Number(response.headers.get('X-RateLimit-Limit')) || null,
        remaining: Number(response.headers.get('X-RateLimit-Remaining')) || null,
        resetAt: response.headers.get('X-RateLimit-Reset') || null,
      },
    },
  };
}

function compactInspireHit(hit) {
  const metadata = hit?.metadata || {};
  return {
    id: hit?.id,
    metadata: {
      control_number: metadata.control_number,
      titles: (metadata.titles || []).slice(0, 2).map(item => ({ title: item?.title })),
      abstracts: (metadata.abstracts || []).slice(0, 1).map(item => ({ value: item?.value })),
      authors: (metadata.authors || []).slice(0, 20).map(author => ({
        full_name: author?.full_name,
        raw_name: author?.raw_name,
      })),
      arxiv_eprints: (metadata.arxiv_eprints || []).slice(0, 2).map(item => ({ value: item?.value })),
      dois: (metadata.dois || []).slice(0, 2).map(item => ({ value: item?.value })),
      document_type: metadata.document_type,
      publication_info: (metadata.publication_info || []).slice(0, 2).map(item => ({
        journal_title: item?.journal_title,
        year: item?.year,
      })),
      documents: (metadata.documents || []).slice(0, 4).map(document => ({
        key: document?.key,
        url: document?.url,
      })),
      keywords: (metadata.keywords || []).slice(0, 20).map(keyword => ({ value: keyword?.value })),
      inspire_categories: (metadata.inspire_categories || []).slice(0, 12).map(category => ({ term: category?.term })),
      primary_arxiv_category: metadata.primary_arxiv_category,
      citation_count: metadata.citation_count,
      reference_count: Array.isArray(metadata.references) ? metadata.references.length : 0,
      earliest_date: metadata.earliest_date,
      imprints: (metadata.imprints || []).slice(0, 1).map(item => ({ date: item?.date })),
    },
  };
}

async function fetchInspireLiterature(context, query, fallbackReason) {
  const url = new URL('https://inspirehep.net/api/literature');
  url.searchParams.set('q', query);
  url.searchParams.set('size', String(context.limit));
  url.searchParams.set('page', String(context.page));
  if (context.sort === 'recent') url.searchParams.set('sort', 'mostrecent');
  const data = await fetchJsonUpstream(url);
  const compactHits = (data?.hits?.hits || []).map(compactInspireHit);
  return {
    hits: {
      hits: compactHits,
      total: data?.hits?.total || 0,
    },
    _papertok: {
      source: 'inspire',
      fallback: true,
      fallbackReason,
    },
  };
}

function emptyPhysicsLiterature(fallbackReason) {
  return {
    hits: { hits: [], total: 0 },
    _papertok: {
      source: 'inspire',
      fallback: true,
      fallbackReason,
    },
  };
}

// A provider that refused and a provider that never answered are different
// failures, and the fallback reason is the only place the difference survives.
function adsFallbackReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'ads_timeout';
  return `ads_${error?.status || 'unavailable'}`;
}

// A fallback that exists because ADS is not configured is a steady state, and
// INSPIRE is then the real answer: it earns the full six hours. A fallback that
// exists because ADS timed out or answered 500 is a one-second hiccup that used
// to blank that query for everybody until the afternoon.
function physicsCacheSeconds(payload) {
  const info = payload?._papertok || {};
  return info.fallback === true && info.fallbackReason !== 'ads_not_configured'
    ? DEGRADED_CACHE_SECONDS
    : SOURCE_CACHE_SECONDS.physics;
}

async function handlePhysicsLiterature(request, env, identity) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  const fallbackQuery = safeSourceQuery(context.requestUrl.searchParams.get('fallback_q'));
  if (!query) return json({ error: 'Missing physics query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, physicsCacheSeconds, async () => {
    if (env.NASA_ADS_API_TOKEN) {
      try {
        return await fetchAdsLiterature(context, query, env);
      } catch (error) {
        console.warn('NASA ADS unavailable, using INSPIRE fallback', error);
        const reason = adsFallbackReason(error);
        return fallbackQuery
          ? fetchInspireLiterature(context, fallbackQuery, reason)
          : emptyPhysicsLiterature(reason);
      }
    }
    return fallbackQuery
      ? fetchInspireLiterature(context, fallbackQuery, 'ads_not_configured')
      : emptyPhysicsLiterature('ads_not_configured');
  }, {
    identity,
    canonicalParams: sourceCacheParams(context, {
      q: query,
      fallback_q: fallbackQuery,
      sort: context.sort,
    }),
  });
}

// Scopus only serves `dc:description` -- the abstract -- through the COMPLETE
// view, and COMPLETE depends on the subscription behind the key. Both the search
// route and the health probe go through this helper so the probe measures the
// path production actually takes, view fallback included.
// Richest view first. The empty rung omits the parameter entirely: some Scopus
// accounts reject an explicit view but answer the endpoint default.
const SCOPUS_VIEWS = ['COMPLETE', 'STANDARD', ''];
// 401 belongs here. An account without COMPLETE entitlement is refused with
// `401 AUTHORIZATION_ERROR -- the requestor is not authorized to access the
// requested view`, which is a statement about the view, not about the key.
// Reading it as a dead end stops the ladder on its first rung and fails every
// search on an account that STANDARD would have served.
const SCOPUS_VIEW_FALLBACK_STATUSES = [400, 401, 403, 406, 500];

// Trying a view the account cannot have costs a doomed upstream call on every
// cache miss, so once `/health/scopus` names the view that answers, pinning it
// here halves what a search spends against the weekly Scopus allowance.
function scopusViewLadder(env) {
  const pinned = String(env.SCOPUS_VIEW || '').trim().toUpperCase();
  if (pinned === 'DEFAULT') return [''];
  return SCOPUS_VIEWS.includes(pinned) && pinned ? [pinned] : SCOPUS_VIEWS;
}

async function scopusFailure(response, view) {
  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = null;
  }
  const detail = scopusErrorDetail(payload);
  return {
    view,
    status: response.status,
    code: detail.code || `SCOPUS_HTTP_${response.status}`,
    message: detail.message,
    requestId: boundedText(response.headers.get('X-ELS-ReqId'), 64),
  };
}

// `api.elsevier.com` is served by Cloudflare, and so is this Worker. A subrequest
// to a hostname Cloudflare already fronts never leaves its network, and Elsevier
// answers it with `500 GENERAL_SYSTEM_ERROR` -- measured, and reproduced with no
// API key at all, while the same request from any other network answers
// normally. So Scopus is reached through `proxy/scopus-proxy.js` on Deno Deploy,
// which is where the Elsevier key lives; this Worker never holds it.
export function isScopusEgressConfigured(env) {
  return Boolean(env.SCOPUS_PROXY_URL) && Boolean(env.SCOPUS_PROXY_SECRET);
}

async function fetchScopusSearch(env, { query, start = 0, count = 1 }) {
  const url = new URL(`${String(env.SCOPUS_PROXY_URL).replace(/\/$/, '')}/scopus`);
  url.searchParams.set('query', query);
  url.searchParams.set('start', String(start));
  url.searchParams.set('count', String(count));

  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${env.SCOPUS_PROXY_SECRET}`,
  };

  // Every attempt is recorded so a failure names which view Elsevier refused and
  // why. The body of a failed attempt is consumed here; only a successful
  // response is handed back unread.
  const attempts = [];
  let response = null;
  let view = '';
  for (const candidate of scopusViewLadder(env)) {
    if (candidate) url.searchParams.set('view', candidate);
    else url.searchParams.delete('view');
    response = await fetchWithDeadline(url, { headers }, SOURCE_UPSTREAM_TIMEOUT_MS);
    view = candidate || 'DEFAULT';
    if (response.ok) {
      attempts.push({ view, status: response.status, code: '', message: '', requestId: '' });
      break;
    }
    attempts.push(await scopusFailure(response, view));
    if (!SCOPUS_VIEW_FALLBACK_STATUSES.includes(response.status)) break;
  }
  return { response, view, attempts };
}

function scopusQuota(response) {
  return {
    limit: Number(response.headers.get('X-RateLimit-Limit')) || null,
    remaining: Number(response.headers.get('X-RateLimit-Remaining')) || null,
    resetAt: response.headers.get('X-RateLimit-Reset') || null,
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return value !== null && value !== '' && Number.isFinite(parsed) ? parsed : null;
}

function boundedText(value, maxLength) {
  return [...String(value || '')]
    .map(character => (character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function scopusErrorDetail(payload) {
  const code = payload?.['service-error']?.status?.statusCode
    || payload?.['error-response']?.['error-code']
    || payload?.['service-error']?.statusCode
    || '';
  const message = payload?.['service-error']?.status?.statusText
    || payload?.['error-response']?.['error-message']
    || '';
  return {
    code: boundedText(code, 80),
    message: boundedText(message, 160),
  };
}

// Reports whether the configured key authenticates from Cloudflare's network and
// which view it grants, without ever echoing the key or the institutional token.
export async function checkScopusHealth(env) {
  const base = {
    provider: 'scopus',
    configured: isScopusEgressConfigured(env),
    // Only the egress can see the Elsevier environment, so it reports this back.
    insttoken: false,
    status: null,
    view: null,
    hasAbstract: false,
    results: 0,
    quota: null,
  };
  if (!base.configured) {
    return { ...base, available: false, code: 'SCOPUS_NOT_CONFIGURED', message: '', attempts: [] };
  }

  try {
    const { response, view, attempts } = await fetchScopusSearch(env, {
      query: 'TITLE-ABS-KEY("photosynthesis")',
      count: 1,
    });
    if (!response.ok) {
      const last = attempts[attempts.length - 1] || {};
      return {
        ...base,
        available: false,
        status: last.status ?? response.status,
        code: last.code || `SCOPUS_HTTP_${response.status}`,
        message: last.message || '',
        attempts,
        quota: scopusQuota(response),
      };
    }

    const payload = await response.json().catch(() => null);
    const results = payload?.['search-results'] || {};
    const entry = Array.isArray(results.entry) ? results.entry[0] : null;
    return {
      ...base,
      insttoken: response.headers.get('X-PaperTok-Insttoken') === 'true',
      available: Boolean(entry?.['dc:title']),
      status: response.status,
      code: entry?.['dc:title'] ? '' : 'SCOPUS_EMPTY_RESULT',
      message: '',
      view,
      hasAbstract: Boolean(boundedText(entry?.['dc:description'], 1)),
      results: Number(results['opensearch:totalResults']) || 0,
      attempts,
      quota: scopusQuota(response),
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      code: 'SCOPUS_UNREACHABLE',
      message: boundedText(error?.message, 160),
      attempts: [],
    };
  }
}

// Rebuilds the upstream URL from an entity allowlist and a parameter allowlist.
// Nothing the caller sends reaches OpenAlex verbatim -- in particular an
// `api_key` in the query is dropped, so a caller cannot spend someone else's
// budget or pin a key of their own.
function openAlexTargetUrl(pathname, searchParams) {
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

// Every OpenAlex call this Worker pays for goes through here, and it is the only
// thing standing between a scripted caller and the day's budget: the Origin gate
// is advisory by construction -- a request with no `Origin` header at all has
// nothing to check, and one is trivially forged -- so a ceiling is the frontier,
// not the header. The guest feed reads OpenAlex without a session, so the ceiling
// is global rather than per user, and it is reserved only after a cache miss so
// repeated queries cost nothing.
//
// Minute first, day second. Both orders can leave one bucket spent when the other
// refuses; this way the leak lives in the minute bucket, which is thrown away
// sixty seconds later, instead of in the day's.
async function reserveOpenAlexBudget(env, origin, amount) {
  const now = new Date().toISOString();
  const periods = [
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
  for (const [periodKey, limit, retryAfter] of periods) {
    const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
      periodKey,
      subject: 'openalex:shared',
      subjectLimit: limit,
      globalLimit: limit,
      amount,
    });
    if (!reservation.accepted && reservation.code) {
      return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
    if (!reservation.accepted) {
      return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        'retry-after': retryAfter,
      });
    }
  }
  return null;
}

function openAlexResponseHeaders(upstream, origin, env) {
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

async function handleOpenAlex(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);

  const target = openAlexTargetUrl(requestUrl.pathname, requestUrl.searchParams);
  if (!target) return json({ code: 'INVALID_OPENALEX_REQUEST' }, 400, corsHeaders(origin, env));

  const cacheKey = canonicalCacheKey(request, origin, Object.fromEntries(target.searchParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const quotaError = await reserveOpenAlexBudget(env, origin, OPENALEX_CALLS.relay);
  if (quotaError) return quotaError;

  const upstream = await fetchWithDeadline(addOpenAlexCredentials(target, env), {
    headers: { accept: 'application/json' },
  });
  const body = await upstream.text();
  const headers = openAlexResponseHeaders(upstream, origin, env);

  // A refusal is relayed with its own status and its own `retry-after`, because
  // flattening it into a 502 would leave the client guessing how long to wait --
  // and since February 2026 that wait can be most of a day.
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
export async function checkOpenAlexHealth(env) {
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
    const payload = await response.json().catch(() => null);
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
      message: boundedText(error?.message, 160),
      budget: null,
    };
  }
}

async function handleScopus(request, env, identity) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  if (!isScopusEgressConfigured(env)) {
    return json({ error: 'Scopus is not configured', code: 'SCOPUS_NOT_CONFIGURED' }, 503, corsHeaders(context.origin, env));
  }

  const author = safeSourceQuery(context.requestUrl.searchParams.get('author'));
  const terms = String(context.requestUrl.searchParams.get('terms') || '')
    .split('|')
    .map(safeSourceQuery)
    .filter(Boolean)
    .slice(0, 4);
  const query = buildScopusSearchQuery({ terms, author });
  if (!query) return json({ error: 'Missing Scopus query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.scopus, async () => {
    const { response, view } = await fetchScopusSearch(env, {
      query,
      start: (context.page - 1) * context.limit,
      count: context.limit,
    });
    if (!response.ok) {
      const error = new Error(`Scopus error: ${response.status}`);
      error.status = response.status;
      error.resetAt = response.headers.get('X-RateLimit-Reset') || null;
      throw error;
    }

    const data = await response.json();
    return {
      ...data,
      _papertok: {
        source: 'scopus',
        view,
        quota: scopusQuota(response),
      },
    };
    // The built query rather than `terms` and `author`: it is what reaches
    // Elsevier, and it is already sanitized and deduplicated. No `sort` -- this
    // route never sends one.
  }, { identity, canonicalParams: sourceCacheParams(context, { query }) });
}

const DOMAIN_SOURCE_HANDLERS = {
  '/sources/biorxiv': handleBioRxiv,
  '/sources/europepmc': handleEuropePmc,
  '/sources/pubmed': handlePubmed,
  '/sources/s2': handleSemanticScholar,
  '/sources/core': handleCore,
  '/sources/osti': handleOsti,
  '/sources/nasa': handleNasa,
  '/sources/physics': handlePhysicsLiterature,
  '/sources/scopus': handleScopus,
  '/sources/openreview': handleOpenReview,
  '/sources/huggingface': handleHuggingFacePapers,
  '/enrich/icite': handleICite,
  '/resources/huggingface': handleHuggingFaceResources,
  '/resources/figures': handlePaperFigures,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin, env),
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    // Cloudflare sirve su propio robots.txt gestionado para cualquier host de
    // una zona, y por defecto dice `Allow: /`. Para una API eso esta al reves:
    // nada enlaza a estas rutas, pero un rastreador que las encuentre gasta los
    // presupuestos de OpenAlex, PubMed y Semantic Scholar, que son globales y no
    // por llamante -- la misma bolsa de la que lee el feed de invitados. Se
    // contesta antes que nada porque un rastreador no manda `origin`.
    //
    // Medido el 2026-09-01: en `api.papertok.app` Cloudflare intercepta
    // /robots.txt ANTES que el Worker, asi que esta ruta solo se ve hoy en
    // `papertok-report-api.*.workers.dev`. No esta rota: entra en vigor en el
    // dominio propio en cuanto se apague el robots.txt gestionado de la zona
    // (panel de Cloudflare, AI Crawl Control). Antes de tocarla, comprueba cual
    // de los dos esta contestando.
    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /\n', {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        },
      });
    }
    if (url.pathname === '/thread-anchor' || url.pathname === '/thread-anchor/invalidate') {
      // Public comments: a guest can open a thread, so this is origin-gated
      // rather than session-gated — and `Origin` is required, not optional:
      // every fetch from the app is cross-origin and carries it, and a request
      // without one is not a browser of ours. Invalidation still requires a
      // Firebase identity because it is a write against the shared cache.
      if (!origin || !allowedOrigins(env).has(origin)) {
        return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
      }
      try {
        return await handleThreadAnchorRequest(request, env, url, {
          cors: corsHeaders(origin, env),
        });
      } catch (error) {
        console.error('Thread anchor failed', error);
        return threadAnchorErrorResponse(error, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/notifications/unsubscribe' && ['GET', 'POST'].includes(request.method)) {
      return handleEmailUnsubscribe(request, env);
    }
    if (url.pathname.startsWith('/notifications/')) {
      if (origin && !allowedOrigins(env).has(origin)) return json({ code: 'EMAIL_ORIGIN_NOT_ALLOWED' }, 403);
      try {
        const payload = await handleEmailNotificationRequest(request, env, url.pathname);
        return json(payload, 200, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const knownError = error instanceof EmailNotificationError;
        return json({ code: knownError ? error.code : 'EMAIL_UNAVAILABLE' }, knownError ? error.status : 502, {
          ...corsHeaders(origin, env),
          'cache-control': 'no-store',
        });
      }
    }
    if (url.pathname === ACCOUNT_DELETE_PATH) {
      if (!origin || !allowedOrigins(env).has(origin)) {
        return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
      }
      try {
        const payload = await handleAccountDeletionRequest(request, env);
        return json(payload, payload.complete ? 200 : 202, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const known = error instanceof AccountDeletionError || error instanceof WorkerAuthError;
        return json({ code: known ? error.code : 'ACCOUNT_DELETION_FAILED' }, known ? error.status : 502, {
          ...corsHeaders(origin, env),
          'cache-control': 'no-store',
        });
      }
    }
    if (PUBLIC_LIST_PATHS.has(url.pathname)) {
      // Writes to a world-readable collection: an unknown Origin is refused
      // outright rather than merely left without CORS headers.
      if (!origin || !allowedOrigins(env).has(origin)) {
        return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
      }
      try {
        const payload = await handlePublicListRequest(request, env, url.pathname);
        return json(payload, 200, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const known = error instanceof PublicListApiError || error instanceof WorkerAuthError;
        return json({ code: known ? error.code : 'PUBLISH_FAILED' }, known ? error.status : 502, {
          ...corsHeaders(origin, env),
          'cache-control': 'no-store',
        });
      }
    }
    if (url.pathname === '/ai/explain') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      try {
        const payload = await handleAIExplanation(request, env);
        return json(payload, 200, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const knownError = error instanceof AIExplanationError;
        return json(
          {
            code: knownError ? error.code : 'AI_UNAVAILABLE',
            ...(knownError && error.quota ? { quota: error.quota } : {}),
          },
          knownError ? error.status : 502,
          { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
        );
      }
    }
    // One passage, explained in place. Same daily allowance as the other two —
    // it is the same model doing the same kind of work, just less of it — so it
    // is deliberately NOT free: a route that spends nothing is a route with no
    // ceiling.
    if (url.pathname === '/ai/annotate') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      try {
        const payload = await handlePassageAnnotation(request, env);
        return json(payload, 200, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const knownError = error instanceof AIExplanationError;
        return json(
          {
            code: knownError ? error.code : 'AI_UNAVAILABLE',
            ...(knownError && error.quota ? { quota: error.quota } : {}),
          },
          knownError ? error.status : 502,
          { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
        );
      }
    }
    if (url.pathname === '/ai/rewrite') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      try {
        // The handler answers with the response itself rather than a payload to
        // wrap: a rewrite is streamed as NDJSON and its first line has to leave
        // before the last one exists, so there is nothing here to serialize. That
        // is also why CORS goes in as `extraHeaders` — those headers have to be
        // on the streaming response when it is created, not added to a body this
        // function never sees.
        return await handlePaperRewrite(request, env, corsHeaders(origin, env));
      } catch (error) {
        const knownError = error instanceof AIExplanationError;
        return json(
          {
            code: knownError ? error.code : 'AI_UNAVAILABLE',
            ...(knownError && error.quota ? { quota: error.quota } : {}),
          },
          knownError ? error.status : 502,
          { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
        );
      }
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
    if (url.pathname === '/locale') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      const country = String(request.cf?.country || '').trim().toUpperCase();
      return json({ country: /^[A-Z]{2}$/.test(country) ? country : null }, 200, {
        ...corsHeaders(origin, env),
        'cache-control': 'private, no-store',
      });
    }
    if (url.pathname === '/health') {
      return json({
        ok: true,
        aiConfigured: Boolean(env.GEMINI_API_KEY || isDeepseekConfigured(env) || isKimiConfigured(env)),
        openAlexConfigured: Boolean(env.OPENALEX_API_KEY),
        adsConfigured: Boolean(env.NASA_ADS_API_TOKEN),
        scopusConfigured: isScopusEgressConfigured(env),
        // Absent means PubMed runs on NCBI's anonymous 3 req/s rather than 10, so
        // it belongs in the report even though the route works without it.
        pubmedKeyConfigured: Boolean(env.NCBI_API_KEY),
        emailConfigured: Boolean(
          env.NOTIFICATION_STORE
          && ((env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) || env.RESEND_API_KEY),
        ),
        publishingConfigured: isServiceAccountConfigured(env),
      }, 200, corsHeaders(origin, env));
    }
    if (url.pathname === '/health/email') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      // Brevo shares one rate limit between this probe and real delivery, so the
      // answer is served from the edge cache like its Scopus and OpenAlex
      // siblings: hammering the route cannot make the digests fail.
      const cacheKey = canonicalCacheKey(request, origin);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const [health, schedule] = await Promise.all([
        checkEmailProviderHealth(env),
        getEmailScheduleHealth(env),
      ]);
      const ledger = getEmailDeliveryLedgerHealth(env);
      const operational = health.available && schedule.fresh && ledger.ok;
      const response = json({ ...health, schedule, ledger }, operational ? 200 : 503, {
        ...corsHeaders(origin, env),
        'cache-control': `public, max-age=60, s-maxage=${EMAIL_HEALTH_CACHE_SECONDS}`,
      });
      try {
        await caches.default.put(cacheKey, response.clone());
      } catch {
        // An uncacheable health response is still a valid answer.
      }
      return response;
    }
    if (url.pathname.startsWith('/openalex/')) {
      try {
        return await handleOpenAlex(request, env);
      } catch (error) {
        // This was the one route that returned its handler bare. A connection
        // reset or a transient DNS failure rose uncaught, and an uncaught throw
        // carries no `access-control-allow-origin`: the browser sees an opaque
        // CORS error and the 429 relay this route works to preserve is lost.
        console.error('OpenAlex relay failed', error);
        return json({ code: 'OPENALEX_UNREACHABLE' }, 502, {
          ...corsHeaders(origin, env),
          'cache-control': 'no-store',
        });
      }
    }
    if (url.pathname === '/health/openalex') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      const cacheKey = canonicalCacheKey(request, origin);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const health = await checkOpenAlexHealth(env);
      const response = json(health, health.available ? 200 : 503, {
        ...corsHeaders(origin, env),
        'cache-control': `public, max-age=60, s-maxage=${OPENALEX_HEALTH_CACHE_SECONDS}`,
      });
      try {
        await caches.default.put(cacheKey, response.clone());
      } catch {
        // An uncacheable health response is still a valid answer.
      }
      return response;
    }
    if (url.pathname === '/health/scopus') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      // The probe costs one upstream Scopus call, so it is served from the edge
      // cache: hammering the route cannot drain the weekly provider allowance.
      const cacheKey = canonicalCacheKey(request, origin);
      const cached = await caches.default.match(cacheKey);
      if (cached) return cached;
      const health = await checkScopusHealth(env);
      const response = json(health, health.available ? 200 : 503, {
        ...corsHeaders(origin, env),
        'cache-control': `public, max-age=60, s-maxage=${SCOPUS_HEALTH_CACHE_SECONDS}`,
      });
      try {
        await caches.default.put(cacheKey, response.clone());
      } catch {
        // An uncacheable health response is still a valid answer.
      }
      return response;
    }
    // Read-only, and deliberately its own route rather than a field on
    // `/health/ai`: this one is per user and needs a session, and health is
    // public. The reader asks for it when it opens so it can show the remaining
    // daily uses without spending one to find out.
    if (url.pathname === '/ai/quota') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      try {
        const account = await verifyFirebaseAccount(request, env);
        return json(await peekAIQuota(env, account.uid, { unlimited: account.unlimitedAI }), 200, {
          ...corsHeaders(origin, env),
          'cache-control': 'private, no-store',
        });
      } catch (error) {
        const knownError = error instanceof AIExplanationError;
        return json(
          { code: knownError ? error.code : 'AI_UNAVAILABLE' },
          knownError ? error.status : 502,
          { ...corsHeaders(origin, env), 'cache-control': 'no-store' },
        );
      }
    }
    if (url.pathname === '/health/ai') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      const health = await checkAIProviderHealth(env);
      return json(health, health.available ? 200 : 503, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
    let protectedIdentity;
    try {
      protectedIdentity = await authenticateProtectedProviderRequest(request, env, url.pathname);
    } catch (error) {
      const knownError = error instanceof WorkerAuthError;
      const status = knownError ? error.status : 503;
      return json({ code: knownError ? error.code : 'PROVIDER_AUTH_UNAVAILABLE' }, status, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        ...(status === 429 ? { 'retry-after': '60' } : {}),
      });
    }
    if (url.pathname === '/report/trends') {
      try {
        return await handleTrends(request, env, protectedIdentity);
      } catch {
        return json({ error: 'Trend data unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/related') {
      try {
        return await handleRelated(request, env, protectedIdentity);
      } catch {
        return json({ error: 'Related papers unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/citation-graph') {
      try {
        return await handleCitationGraph(request, env, protectedIdentity);
      } catch (error) {
        console.error('Citation graph failed', error);
        return json({ error: 'Citation graph unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/oa') {
      try {
        return await handleOpenAccess(request, env);
      } catch {
        return json({ error: 'Open-access lookup unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/arxiv') {
      try {
        return await handleArxiv(request, env);
      } catch {
        return json({ error: 'arXiv unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (DOMAIN_SOURCE_HANDLERS[url.pathname]) {
      try {
        return await DOMAIN_SOURCE_HANDLERS[url.pathname](request, env, protectedIdentity);
      } catch (error) {
        console.error(`Specialist source failed: ${url.pathname}`, error);
        const isScopus = url.pathname === '/sources/scopus';
        // A refusal relayed as a 502 reads as "this source is broken", and a
        // client that believes that retries at once -- which is the one thing
        // that makes a rate limit worse. Scopus already relayed its own 429;
        // every source route does now, because every one of them can be refused.
        const rateLimited = error.status === 429;
        // `AbortSignal.timeout` rejects with a `TimeoutError`, and a stall has no
        // status to relay -- so it gets a name instead of the generic 502 body.
        const timedOut = error?.name === 'TimeoutError';
        const status = rateLimited ? 429 : 502;
        return json({
          error: isScopus ? 'Scopus unavailable' : 'Specialist source unavailable',
          ...(rateLimited ? { code: 'UPSTREAM_RATE_LIMITED' } : {}),
          ...(timedOut ? { code: 'UPSTREAM_TIMEOUT' } : {}),
          // For every source, not only Scopus: a 400 we caused and an outage they
          // had both left here as the same 502, and the number that told them
          // apart stayed in `wrangler tail` (`Upstream error: 400`) -- which is
          // how the OpenReview `tcdate` bug went unseen for weeks.
          ...(error.status ? { upstreamStatus: error.status } : {}),
          ...(isScopus && error.resetAt ? { resetAt: error.resetAt } : {}),
        }, status, {
          ...corsHeaders(origin, env),
          ...(rateLimited ? { 'retry-after': error.retryAfter || '60' } : {}),
        });
      }
    }
    return json({ error: 'Not found' }, 404, corsHeaders(origin, env));
  },
  async scheduled(controller, env, context) {
    context.waitUntil(runEmailNotificationSchedule(env, controller.scheduledTime));
  },
};
