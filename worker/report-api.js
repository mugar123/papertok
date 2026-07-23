import { buildOpenAlexTrendFilter, normalizeReportFilters } from '../src/services/openAlexReportQuery.js';
import { buildScopusSearchQuery } from '../src/services/scopusQuery.js';
import { AIExplanationError, checkAIProviderHealth, handleAIExplanation } from './ai-explanation.js';
import {
  deduplicateCitationGraphPapers,
  extractCitationDoi,
  extractCitationOpenAlexId,
  normalizeCitationDoi,
  normalizeCitationRows,
} from '../src/utils/citationGraph.js';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://mugar123.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const CACHE_SECONDS = 6 * 60 * 60;
const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const CITATION_GRAPH_CACHE_SECONDS = 7 * 24 * 60 * 60;
const OA_CACHE_SECONDS = 7 * 24 * 60 * 60;
const ARXIV_CACHE_SECONDS = 10 * 60;
const SOURCE_CACHE_SECONDS = {
  biorxiv: 10 * 60,
  europepmc: 30 * 60,
  core: 6 * 60 * 60,
  osti: 60 * 60,
  nasa: 60 * 60,
  physics: 6 * 60 * 60,
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

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Upstream error: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
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
    return await fetchOpenAlexJsonWithFallback(url, env, 6500);
  } catch {
    return null;
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
  return batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []);
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
  let mapped = deduplicateCitationGraphPapers([...byId, ...byDoi].map(mapCitationGraphWork).filter(Boolean), 40);
  if (mapped.length < limit) {
    const metaFallback = await fetchOpenCitationsMetadata(candidates, env).catch(() => []);
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
  return mapped.slice(0, limit);
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

async function fetchOpenCitationsRows(doi, relation, env) {
  const url = new URL(`https://api.opencitations.net/index/v2/${relation}/doi:${encodeURIComponent(doi)}`);
  url.searchParams.set('format', 'json');
  if (relation === 'citations') url.searchParams.set('sort', 'desc(creation)');
  const headers = { accept: 'application/json' };
  if (env.OPENCITATIONS_ACCESS_TOKEN) headers.authorization = env.OPENCITATIONS_ACCESS_TOKEN;
  return fetchJsonWithTimeout(url, { headers }, 7500);
}

async function handleCitationGraph(request, env) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const doi = normalizeCitationDoi(requestUrl.searchParams.get('doi'));
  if (!/^10\.\d{4,9}\/.+/.test(doi) || doi.length > 300) {
    return json({ error: 'Invalid DOI' }, 400, corsHeaders(origin, env));
  }
  const limit = getSafeLimit(requestUrl.searchParams.get('limit'), 8, 10);

  return cacheResponse(request, origin, env, CITATION_GRAPH_CACHE_SECONDS, async () => {
    const currentWork = await fetchOpenAlexCurrentWork(doi, env);
    const currentOpenAlexId = String(currentWork?.id || '').split('/').pop();
    const shouldUseOpenAlexForCitations = (currentWork?.cited_by_count || 0) > 300;
    const [referenceResult, citationResult] = await Promise.allSettled([
      fetchOpenCitationsRows(doi, 'references', env),
      shouldUseOpenAlexForCitations
        ? Promise.resolve([])
        : fetchOpenCitationsRows(doi, 'citations', env),
    ]);

    let partial = referenceResult.status === 'rejected' || citationResult.status === 'rejected';
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

    const references = await resolveCitationConnections(referenceConnections, env, limit, 'reference');
    let citations;
    if (shouldUseOpenAlexForCitations || !citationConnections.length) {
      citations = await fetchOpenAlexCitingWorks(currentOpenAlexId, env, limit).catch(() => []);
      if (shouldUseOpenAlexForCitations || citations.length) partial = true;
    } else {
      citations = await resolveCitationConnections(citationConnections, env, limit, 'citation');
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
    };
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

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${env.NASA_ADS_API_TOKEN}`,
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  });
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

async function handlePhysicsLiterature(request, env) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  const fallbackQuery = safeSourceQuery(context.requestUrl.searchParams.get('fallback_q'));
  if (!query) return json({ error: 'Missing physics query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.physics, async () => {
    if (env.NASA_ADS_API_TOKEN) {
      try {
        return await fetchAdsLiterature(context, query, env);
      } catch (error) {
        console.warn('NASA ADS unavailable, using INSPIRE fallback', error);
        return fallbackQuery
          ? fetchInspireLiterature(context, fallbackQuery, `ads_${error.status || 'unavailable'}`)
          : emptyPhysicsLiterature(`ads_${error.status || 'unavailable'}`);
      }
    }
    return fallbackQuery
      ? fetchInspireLiterature(context, fallbackQuery, 'ads_not_configured')
      : emptyPhysicsLiterature('ads_not_configured');
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
  '/sources/physics': handlePhysicsLiterature,
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
        adsConfigured: Boolean(env.NASA_ADS_API_TOKEN),
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
    if (url.pathname === '/citation-graph') {
      try {
        return await handleCitationGraph(request, env);
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
