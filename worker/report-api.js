import { buildOpenAlexTrendFilter, normalizeReportFilters } from '../src/services/openAlexReportQuery.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://mugar123.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CACHE_SECONDS = 6 * 60 * 60;
const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const OA_CACHE_SECONDS = 7 * 24 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
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

async function fetchOpenAlexPeriod(period, filters, env) {
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('filter', buildOpenAlexTrendFilter(period, filters));
  url.searchParams.set('group_by', 'topics.id');
  url.searchParams.set('per_page', '100');
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenAlex error: ${response.status}`);
  const data = await response.json();
  return {
    total: Math.max(0, Number(data?.meta?.count) || 0),
    groups: Array.isArray(data?.group_by) ? data.group_by : [],
  };
}

async function handleTrends(request, env) {
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
  const cache = caches.default;
  const cacheUrl = new URL(requestUrl);
  // CORS varies by origin, so keep each allowed origin in a separate cache entry.
  cacheUrl.searchParams.set('_origin', origin || 'no-origin');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const [current, previous] = await Promise.all([
    fetchOpenAlexPeriod({ fromStr: dates.from, toStr: dates.to }, filters, env),
    fetchOpenAlexPeriod({ fromStr: dates.previousFrom, toStr: dates.previousTo }, filters, env),
  ]);
  const response = json(
    { current, previous },
    200,
    {
      ...corsHeaders(origin, env),
      'cache-control': `public, max-age=300, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
    },
  );
  await cache.put(cacheKey, response.clone());
  return response;
}

function getSafeLimit(value, fallback = 8, max = 10) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

async function cacheResponse(request, origin, env, ttl, fetcher) {
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('_origin', origin || 'no-origin');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const payload = await fetcher();
  const response = json(payload, 200, {
    ...corsHeaders(origin, env),
    'cache-control': `public, max-age=300, s-maxage=${ttl}, stale-while-revalidate=86400`,
  });
  await caches.default.put(cacheKey, response.clone());
  return response;
}

async function handleRelated(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const paperId = requestUrl.searchParams.get('paper_id') || '';
  if (!/^(?:DOI:10\.|ARXIV:|[a-f0-9]{40}$)/i.test(paperId) || paperId.length > 300) {
    return json({ error: 'Invalid paper id' }, 400, corsHeaders(origin, env));
  }
  const limit = getSafeLimit(requestUrl.searchParams.get('limit'));
  return cacheResponse(request, origin, env, RELATED_CACHE_SECONDS, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${limit}`;
    const headers = { accept: 'application/json' };
    if (env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = env.SEMANTIC_SCHOLAR_API_KEY;
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Semantic Scholar error: ${response.status}`);
    return response.json();
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
    const response = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Unpaywall error: ${response.status}`);
    return response.json();
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin, env),
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    if (url.pathname === '/health') return json({ ok: true }, 200, corsHeaders(origin, env));
    if (url.pathname === '/report/trends') {
      try {
        return await handleTrends(request, env);
      } catch (error) {
        return json({ error: 'Trend data unavailable', detail: error.message }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/related') {
      try {
        return await handleRelated(request, env);
      } catch {
        return json({ error: 'Related papers unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (url.pathname === '/oa') {
      try {
        return await handleOpenAccess(request, env);
      } catch {
        return json({ error: 'Open-access lookup unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    return json({ error: 'Not found' }, 404, corsHeaders(origin, env));
  },
};
