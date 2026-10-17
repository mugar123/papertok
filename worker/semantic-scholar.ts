import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';

import type { UpstreamError } from './provider-runtime.ts';

import { readBoundedJson } from './bounded-body.ts';
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

const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const RELATED_UPSTREAM_LIMIT = 20;

export async function handleRelated(request: Request, env: WorkerEnv, identity?: Pick<VerifiedIdentity, 'uid'> | null) {
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
  // Twenty, always. The feed seeds from twenty and the sheet shows eight; when
  // `limit` was part of the cache key those were two misses and two provider
  // calls for one list of which the second is a prefix of the first. The client
  // trims what it shows. `limit` is still accepted so an older bundle keeps
  // working; it just no longer changes the question.
  return cacheResponse(request, origin, env, RELATED_CACHE_SECONDS, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${RELATED_UPSTREAM_LIMIT}`;
    // Through the source helper, not a bare `fetchWithDeadline`: this used to
    // throw a plain Error with the status in its message and nothing on the
    // error itself, which is why the router could only ever answer 502. Six
    // seconds for this fetch -- but `awaitSharedPace` runs ahead of it in
    // `cacheResponse` and can itself add up to 2.5 s of sleep plus a couple of
    // ledger round trips, so the two no longer share a separate margin against
    // the browser. The client's abort budget for this route
    // (`relatedPapersService.js`) was raised from 8 s to 11 s to hold both,
    // rather than shrinking this deadline to carve room out of it: that would
    // hand a contended request -- one that hit the beat's wait precisely
    // because Semantic Scholar is already under pressure -- less time to talk
    // to a provider that is by hypothesis already slow.
    return fetchJsonUpstream(url, env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {});
  }, { identity, canonicalParams: { paper_id: paperId } });
}

const PERSONAL_CACHE_SECONDS = 6 * 60 * 60;
// Semantic Scholar answers up to 500. Fifty per request is a session's worth,
// and many come back with neither an arXiv id nor a DOI the feed can fetch by.
const PERSONAL_UPSTREAM_LIMIT = 50;
const MAX_PERSONAL_POSITIVE_EXAMPLES = 10;
const MAX_PERSONAL_NEGATIVE_EXAMPLES = 10;
const PERSONAL_BODY_LIMIT_BYTES = 8 * 1024;
const EXAMPLE_ID_PATTERN = /^(?:DOI:10\.\S{1,250}|ARXIV:[\w./-]{4,40}|PMID:\d{1,12}|[a-f0-9]{40})$/i;
const RECOMMENDED_ARXIV_ID = /^[\w./-]{4,40}$/;
const RECOMMENDED_DOI = /^10\.\S{1,250}$/;

class RecommendationRequestError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'RecommendationRequestError';
    this.code = code;
    this.status = status;
  }
}

// Sorted and deduplicated, so the key and the upstream body are the same
// question however the client ordered it. One malformed id refuses the list.
function exampleIds(value: unknown, maximum: number) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) return null;
  const ids = value.map(id => (typeof id === 'string' ? id.trim() : ''));
  if (ids.some(id => !EXAMPLE_ID_PATTERN.test(id))) return null;
  return [...new Set(ids)].sort();
}

function recommendedPaper(item: unknown) {
  const externalIds = (item as { externalIds?: Record<string, unknown> } | null)?.externalIds || {};
  const arxivId = typeof externalIds.ArXiv === 'string' && RECOMMENDED_ARXIV_ID.test(externalIds.ArXiv) ? externalIds.ArXiv : null;
  const doi = typeof externalIds.DOI === 'string' && RECOMMENDED_DOI.test(externalIds.DOI) ? externalIds.DOI : null;
  return arxivId || doi ? { arxivId, doi } : null;
}

/**
 * Papers like the reader's examples: `POST { positive, negative }` with
 * Semantic Scholar ids (`ARXIV:`, `DOI:`, `PMID:` or a corpus hash), answered
 * as `{ papers: [{ arxivId, doi }] }` in Semantic Scholar's order. Only the
 * identifiers travel; the client fetches the papers through the sources that
 * already normalize them. The answer is the reader's own, so it is cached under
 * their uid and never shared.
 */
export async function handlePersonalRecommendations(request: Request, env: WorkerEnv, identity: Pick<VerifiedIdentity, 'uid'>) {
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  if (request.method !== 'POST') return json({ code: 'METHOD_NOT_ALLOWED' }, 405, corsHeaders(origin, env));

  let body: { positive?: unknown; negative?: unknown } | null;
  try {
    body = await readBoundedJson<{ positive?: unknown; negative?: unknown }>(request, PERSONAL_BODY_LIMIT_BYTES, {
      tooLarge: () => new RecommendationRequestError('BODY_TOO_LARGE', 413),
      invalid: () => new RecommendationRequestError('INVALID_BODY', 400),
    });
  } catch (error) {
    if (!(error instanceof RecommendationRequestError)) throw error;
    return json({ code: error.code }, error.status, corsHeaders(origin, env));
  }
  const positive = exampleIds(body?.positive, MAX_PERSONAL_POSITIVE_EXAMPLES);
  const negative = exampleIds(body?.negative, MAX_PERSONAL_NEGATIVE_EXAMPLES);
  if (!positive?.length || !negative) return json({ code: 'INVALID_EXAMPLES' }, 400, corsHeaders(origin, env));

  return cacheResponse(
    request,
    origin,
    env,
    (payload: { papers: unknown[] }) => (payload.papers.length > 0 ? PERSONAL_CACHE_SECONDS : DEGRADED_CACHE_SECONDS),
    async () => {
      const url = `https://api.semanticscholar.org/recommendations/v1/papers?fields=externalIds&limit=${PERSONAL_UPSTREAM_LIMIT}`;
      const response = await fetchWithDeadline(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
          ...(env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {}),
        },
        body: JSON.stringify({ positivePaperIds: positive, negativePaperIds: negative }),
      }, SOURCE_UPSTREAM_TIMEOUT_MS);
      if (response.status === 400) {
        const detail = await response.json<{ error?: unknown }>().catch(() => null);
        // What Semantic Scholar answers when none of the positive examples is
        // in its corpus (measured 2026-10-17): there is nothing to recommend
        // from, which is an empty answer rather than a failure.
        if (/no positive paper examples/i.test(String(detail?.error || ''))) return { papers: [] };
      }
      if (!response.ok) {
        const error: UpstreamError = new Error(`Upstream error: ${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after') || '';
        throw error;
      }
      const payload = await response.json<{ recommendedPapers?: unknown }>();
      const items = Array.isArray(payload?.recommendedPapers) ? payload.recommendedPapers : [];
      return { papers: items.map(recommendedPaper).filter(Boolean) };
    },
    { identity, personal: true, canonicalParams: { positive: positive.join(','), negative: negative.join(',') } },
  );
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
export async function handleSemanticScholar(request: Request, env: WorkerEnv) {
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
    const headers: Record<string, string> = env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {};
    return fetchJsonUpstream(url, headers);
  }, { canonicalParams: sourceCacheParams(context, { q: query }) });
}
