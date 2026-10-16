import { corsHeaders, json } from './http.ts';
import { cacheResponse, DEGRADED_CACHE_SECONDS, fetchJsonUpstream, fetchWithDeadline, safeSourceQuery, sourceCacheParams, sourceRequestContext, SOURCE_CACHE_SECONDS, SOURCE_UPSTREAM_TIMEOUT_MS } from './provider-runtime.ts';

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

export async function handlePhysicsLiterature(request, env, identity) {
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
