import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';

interface OpenReviewNote extends Record<string, unknown> { content?: Record<string, unknown> }
interface HuggingFaceEntry { paper?: { publishedAt?: string }; publishedAt?: string }
interface HuggingFaceResources extends Record<string, unknown> {
  linkedModels?: Array<Record<string, unknown>>;
  linkedDatasets?: Array<Record<string, unknown>>;
}


import { allowedOrigins, corsHeaders, json } from './http.ts';
import {
  cacheResponse,
  DEGRADED_CACHE_SECONDS,
  fetchJsonUpstream,
  fetchWithDeadline,
  safeSourceQuery,
  sourceCacheParams,
  sourceRequestContext,
  SOURCE_CACHE_SECONDS,
  SOURCE_UPSTREAM_TIMEOUT_MS,
} from './provider-runtime.ts';
import { fetchPaperFigures, FIGURE_CACHE_SECONDS, FIGURE_EMPTY_CACHE_SECONDS, isArxivFigureId } from './paper-figures.ts';

function utcDateOffset(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function bioRxivDegradedCode(error: unknown) {
  if ((error as UpstreamError)?.name === 'TimeoutError' || (error as UpstreamError)?.name === 'AbortError') return 'UPSTREAM_TIMEOUT';
  if ((error as UpstreamError)?.status === 429) return 'UPSTREAM_RATE_LIMITED';
  if ((error as UpstreamError)?.status) return `UPSTREAM_${(error as UpstreamError).status}`;
  // An empty or non-JSON body fails `response.json()` with a SyntaxError.
  return 'UPSTREAM_INVALID';
}

export async function handleBioRxiv(request: Request, env: WorkerEnv) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const category = String(context.requestUrl.searchParams.get('category') || '').trim().toLowerCase();
  if (!/^[a-z][a-z &-]{1,80}$/.test(category)) {
    return json({ error: 'Invalid bioRxiv category' }, 400, corsHeaders(context.origin, env));
  }

  // A degraded answer holds its entry for two minutes, not ten.
  const ttl = (payload: { _papertok?: { degraded?: string } }) => (payload?._papertok?.degraded ? DEGRADED_CACHE_SECONDS : SOURCE_CACHE_SECONDS.biorxiv);

  return cacheResponse(request, context.origin, env, ttl, async () => {
    // bioRxiv pages in fixed groups of 30, so request the matching cursor and trim client-side.
    const cursor = (context.page - 1) * 30;
    const encodedCategory = encodeURIComponent(category.replace(/\s+/g, '_'));
    const url = `https://api.biorxiv.org/details/biorxiv/${utcDateOffset(-180)}/${utcDateOffset(0)}/${cursor}/json?category=${encodedCategory}`;
    try {
      const data = await fetchJsonUpstream<{ collection?: unknown[]; _papertok?: { degraded?: string } }>(url);
      return { ...data, collection: (data?.collection || []).slice(0, context.limit) };
    } catch (error) {
      // bioRxiv hangs on some calls (4 of 6 over 20 s on 2026-09-23) and on
      // 2026-09-24 answered every call with an empty 200. As an uncached 502
      // every cold visit paid the six-second deadline again; as a degraded
      // answer, cached briefly, one call per two minutes pays it. The code
      // tells the client this is a failure, not an empty category.
      return { collection: [], _papertok: { degraded: bioRxivDegradedCode(error) } };
    }
  }, { canonicalParams: sourceCacheParams(context, { category }) });
}

export async function handleEuropePmc(request: Request, env: WorkerEnv) {
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
function pubmedUrl(endpoint: string, env: WorkerEnv, params: Record<string, string>) {
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

function pubmedRetryDelayMs(error: unknown) {
  if ((error as UpstreamError)?.status !== 429) return null;
  // Trimmed so a whitespace-only value takes the empty branch instead of
  // coercing to the number 0 and reading as an advertised instant retry.
  const advertised = String((error as UpstreamError).retryAfter ?? '').trim();
  if (advertised !== '') {
    const advertisedMs = Number(advertised) * 1000;
    // A negative number is nonsense from upstream, not a request to retry
    // instantly -- it must not be more aggressive than a legitimate `0`.
    if (!Number.isFinite(advertisedMs) || advertisedMs < 0) return null;
    return advertisedMs <= PUBMED_RETRY_MAX_MS ? advertisedMs : null;
  }
  return PUBMED_RETRY_BASE_MS + Math.random() * PUBMED_RETRY_JITTER_MS;
}

async function withPubmedRetry<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    const delayMs = pubmedRetryDelayMs(error);
    if (delayMs === null) throw error;
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    return attempt();
  }
}

// E-utilities cannot answer a search in one call: esearch returns identifiers,
// esummary returns the records, and efetch is the only one that carries the
// abstract. Run from the browser that was three serial round trips per feed load
// with nothing cacheable in between -- the measured floor under every guest load.
// Here the chain is two hops, because esummary and efetch only depend on esearch
// and not on each other, and the whole thing lands in one edge-cache entry.
export async function handlePubmed(request: Request, env: WorkerEnv) {
  const context = sourceRequestContext(request, env, {
    limitFallback: PUBMED_DEFAULT_LIMIT,
    limitMax: PUBMED_MAX_LIMIT,
  });
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing PubMed query' }, 400, corsHeaders(context.origin, env));

  // A batch that lost its abstracts is exactly the case the payload-dependent TTL
  // was added for: it is a real answer, but not one worth serving for ten minutes.
  const ttl = (payload: { _papertok?: { efetch?: string } }) => (payload?._papertok?.efetch === 'unavailable'
    ? DEGRADED_CACHE_SECONDS
    : SOURCE_CACHE_SECONDS.pubmed);

  return cacheResponse(request, context.origin, env, ttl, async () => {
    const search = await withPubmedRetry(() => fetchJsonUpstream<{ esearchresult?: { idlist?: unknown[] } }>(pubmedUrl('esearch.fcgi', env, {
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
      withPubmedRetry(() => fetchJsonUpstream<{ result?: Record<string, unknown> }>(pubmedUrl('esummary.fcgi', env, {
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

async function fetchPubmedArticleXml(pmids: string[], env: WorkerEnv) {
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
    const error: UpstreamError = new Error(`PubMed efetch error: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  // Read under the same deadline that covered the headers: efetch answers the
  // largest body of the three and a document that stops halfway is a stall, not a
  // short answer.
  return response.text();
}

function compactOpenReviewNote(note: OpenReviewNote) {
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
      .map(key => [key, note.content![key]])),
  };
}

function isOpenReviewSubmission(note: OpenReviewNote) {
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
function openReviewNoteDate(note: OpenReviewNote) {
  return Number(note?.pdate || note?.cdate || note?.tcdate) || 0;
}

export async function handleOpenReview(request: Request, env: WorkerEnv) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing OpenReview query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.openreview, async () => {
    const url = new URL('https://api2.openreview.net/notes/search');
    url.searchParams.set('term', query);
    url.searchParams.set('source', 'forum');
    url.searchParams.set('limit', String(Math.min(50, context.limit * 3)));
    url.searchParams.set('offset', String((context.page - 1) * context.limit));
    // No `sort` on the URL. api2's search accepts `cdate:desc` (and refuses
    // `tcdate`, `mdate` and `pdate` with a 400) but does not act on it: measured
    // 2026-09-02, `cdate:asc`, `cdate:desc`, `tmdate:*` and no sort at all
    // returned the same sequence for three different queries. Recency is
    // therefore ours to produce, over the relevance pool `limit * 3` fetches.
    const payload = await fetchJsonUpstream<{ notes?: OpenReviewNote[]; count?: unknown }>(url);
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

export async function handleHuggingFacePapers(request: Request, env: WorkerEnv) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing Hugging Face query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.huggingface, async () => {
    const url = new URL('https://huggingface.co/api/papers/search');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(context.limit));
    url.searchParams.set('p', String(context.page - 1));
    const payload = await fetchJsonUpstream<HuggingFaceEntry[] | { papers?: HuggingFaceEntry[] }>(url);
    const papers = Array.isArray(payload) ? payload : payload?.papers || [];
    if (context.sort === 'recent') {
      papers.sort((a, b) => Date.parse((b?.paper?.publishedAt || b?.publishedAt || 0) as string)
        - Date.parse((a?.paper?.publishedAt || a?.publishedAt || 0) as string));
    }
    return { papers: papers.slice(0, context.limit) };
  }, { canonicalParams: sourceCacheParams(context, { q: query, sort: context.sort }) });
}

export async function handleICite(request: Request, env: WorkerEnv) {
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
    const payload = await fetchJsonUpstream<{ data?: unknown[] }>(url);
    return { data: Array.isArray(payload?.data) ? payload.data : [] };
  }, { canonicalParams: { pmids: pmids.join(',') } });
}

export async function handleHuggingFaceResources(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const arxivId = String(requestUrl.searchParams.get('arxiv_id') || '').trim().replace(/v\d+$/i, '');
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) {
    return json({ error: 'Invalid arXiv identifier' }, 400, corsHeaders(origin, env));
  }

  return cacheResponse(request, origin, env, SOURCE_CACHE_SECONDS.huggingFaceResources, async () => {
    const payload = await fetchJsonUpstream<HuggingFaceResources>(`https://huggingface.co/api/papers/${encodeURIComponent(arxivId)}`);
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

export async function handlePaperFigures(request: Request, env: WorkerEnv) {
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

// CORE's search took 7.4 s and 8.0 s to answer (measured 2026-10-20), past the
// shared six seconds, so a successful search was cut before it could reach the
// edge cache. The browser keeps the request open for 10 s (`REQUEST_TIMEOUT_MS`
// in domainSourceService.ts) after the feed stops waiting for it; nine seconds
// lets the answer finish and be cached for the next reader, with room left for
// the identity and quota checks that run first.
export const CORE_UPSTREAM_TIMEOUT_MS = 9_000;

export async function handleCore(request: Request, env: WorkerEnv, identity?: Pick<VerifiedIdentity, 'uid'> | null) {
  const context = sourceRequestContext(request, env);
  if (context.error) return context.error;
  const query = safeSourceQuery(context.requestUrl.searchParams.get('q'));
  if (!query) return json({ error: 'Missing CORE query' }, 400, corsHeaders(context.origin, env));

  return cacheResponse(request, context.origin, env, SOURCE_CACHE_SECONDS.core, async () => {
    const url = new URL('https://api.core.ac.uk/v3/search/works/');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(context.limit));
    url.searchParams.set('offset', String((context.page - 1) * context.limit));
    const headers: Record<string, string> = env.CORE_API_KEY ? { authorization: `Bearer ${env.CORE_API_KEY}` } : {};
    return fetchJsonUpstream(url, headers, CORE_UPSTREAM_TIMEOUT_MS);
    // No `sort`: this handler never sends it upstream, so two entries would hold
    // one identical answer.
  }, { identity, canonicalParams: sourceCacheParams(context, { q: query }) });
}

export async function handleOsti(request: Request, env: WorkerEnv) {
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

export async function handleNasa(request: Request, env: WorkerEnv) {
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
