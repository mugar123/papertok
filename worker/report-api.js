import { buildOpenAlexTrendFilter, normalizeReportFilters } from '../src/services/openAlexReportQuery.js';
import { buildScopusSearchQuery } from '../src/services/scopusQuery.js';
import { AIExplanationError, checkAIProviderHealth, handleAIExplanation } from './ai-explanation.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://mugar123.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CACHE_SECONDS = 6 * 60 * 60;
const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const OA_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ARXIV_CACHE_SECONDS = 10 * 60;
const SOURCE_CACHE_SECONDS = {
  biorxiv: 10 * 60,
  europepmc: 30 * 60,
  core: 6 * 60 * 60,
  osti: 60 * 60,
  nasa: 60 * 60,
  scopus: 6 * 60 * 60,
};
const ARXIV_PARAMS = ['search_query', 'id_list', 'start', 'max_results', 'sortBy', 'sortOrder'];

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

function safeArxivParam(name, value) {
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

  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('_origin', origin || 'no-origin');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetch(upstreamUrl.toString(), {
      signal: controller.signal,
      headers: {
        accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
        'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(`arXiv error: ${response.status}`);
  const xml = await response.text();
  if (!xml.includes('<feed')) throw new Error('Invalid arXiv response');

  const workerResponse = new Response(xml, {
    status: 200,
    headers: {
      ...corsHeaders(origin, env),
      'content-type': 'application/atom+xml; charset=utf-8',
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

function sourceRequestContext(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) {
    return { error: json({ error: 'Origin not allowed' }, 403) };
  }
  return {
    requestUrl,
    origin,
    page: getSafeLimit(requestUrl.searchParams.get('page'), 1, 100),
    limit: getSafeLimit(requestUrl.searchParams.get('limit'), 8, 10),
    sort: requestUrl.searchParams.get('sort') === 'recent' ? 'recent' : 'relevance',
  };
}

function utcDateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function fetchJsonUpstream(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      ...headers,
    },
  });
  if (!response.ok) throw new Error(`Upstream error: ${response.status}`);
  return response.json();
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
  });
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
  });
}

async function handleCore(request, env) {
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
  });
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
  });
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
  });
}

async function handleScopus(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  if (!env.ELSEVIER_API_KEY) {
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
    const url = new URL('https://api.elsevier.com/content/search/scopus');
    url.searchParams.set('query', query);
    url.searchParams.set('start', String((context.page - 1) * context.limit));
    url.searchParams.set('count', String(context.limit));
    url.searchParams.set('view', 'COMPLETE');

    const headers = {
      accept: 'application/json',
      'X-ELS-APIKey': env.ELSEVIER_API_KEY,
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    };
    if (env.ELSEVIER_INST_TOKEN) headers['X-ELS-Insttoken'] = env.ELSEVIER_INST_TOKEN;

    let response = await fetch(url, { headers });
    let selectedView = 'COMPLETE';
    if (!response.ok && [400, 403, 406, 500].includes(response.status)) {
      url.searchParams.set('view', 'STANDARD');
      response = await fetch(url, { headers });
      selectedView = 'STANDARD';
    }
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
        view: selectedView,
        quota: {
          limit: Number(response.headers.get('X-RateLimit-Limit')) || null,
          remaining: Number(response.headers.get('X-RateLimit-Remaining')) || null,
          resetAt: response.headers.get('X-RateLimit-Reset') || null,
        },
      },
    };
  });
}

const DOMAIN_SOURCE_HANDLERS = {
  '/sources/biorxiv': handleBioRxiv,
  '/sources/europepmc': handleEuropePmc,
  '/sources/core': handleCore,
  '/sources/osti': handleOsti,
  '/sources/nasa': handleNasa,
  '/sources/scopus': handleScopus,
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
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '86400',
        },
      });
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
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, corsHeaders(origin, env));
    if (url.pathname === '/health') {
      return json({
        ok: true,
        aiConfigured: Boolean(env.GEMINI_API_KEY),
        openAlexConfigured: Boolean(env.OPENALEX_API_KEY),
        scopusConfigured: Boolean(env.ELSEVIER_API_KEY),
      }, 200, corsHeaders(origin, env));
    }
    if (url.pathname === '/health/ai') {
      if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
      const health = await checkAIProviderHealth(env);
      return json(health, health.available ? 200 : 503, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
      });
    }
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
    if (url.pathname === '/arxiv') {
      try {
        return await handleArxiv(request, env);
      } catch {
        return json({ error: 'arXiv unavailable' }, 502, corsHeaders(origin, env));
      }
    }
    if (DOMAIN_SOURCE_HANDLERS[url.pathname]) {
      try {
        return await DOMAIN_SOURCE_HANDLERS[url.pathname](request, env);
      } catch (error) {
        console.error(`Specialist source failed: ${url.pathname}`, error);
        const isScopus = url.pathname === '/sources/scopus';
        const status = isScopus && error.status === 429 ? 429 : 502;
        return json({
          error: isScopus ? 'Scopus unavailable' : 'Specialist source unavailable',
          ...(isScopus && error.status ? { upstreamStatus: error.status } : {}),
          ...(isScopus && error.resetAt ? { resetAt: error.resetAt } : {}),
        }, status, corsHeaders(origin, env));
      }
    }
    return json({ error: 'Not found' }, 404, corsHeaders(origin, env));
  },
};
