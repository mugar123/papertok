import { buildScopusSearchQuery } from '../src/services/scopusQuery.js';
import { corsHeaders, json } from './http.ts';
import { boundedText, cacheResponse, fetchWithDeadline, safeSourceQuery, sourceCacheParams, sourceRequestContext, SOURCE_CACHE_SECONDS, SOURCE_UPSTREAM_TIMEOUT_MS } from './provider-runtime.ts';

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

export async function handleScopus(request, env, identity) {
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
