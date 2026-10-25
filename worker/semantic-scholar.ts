import type { WorkerEnv } from './env.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';

import type { UpstreamError } from './provider-runtime.ts';

import { allowedOrigins, corsHeaders, json } from './http.ts';
import {
  cacheResponse,
  fetchJsonUpstream,
  safeSourceQuery,
  sourceCacheParams,
  sourceRequestContext,
  SOURCE_CACHE_SECONDS,
} from './provider-runtime.ts';

const RELATED_CACHE_SECONDS = 24 * 60 * 60;
const RELATED_UPSTREAM_LIMIT = 20;
const PAPER_NOT_INDEXED = 'PAPER_NOT_INDEXED';
// A paper Semantic Scholar has not indexed yet (a 404 from the recommendations
// endpoint) has no recommendations, which is an answer, not an outage. It is
// kept for an hour rather than a day: the paper may be indexed tomorrow.
const NOT_INDEXED_CACHE_SECONDS = 60 * 60;

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
  const ttl = (payload: unknown) => ((payload as { code?: string } | null)?.code === PAPER_NOT_INDEXED ? NOT_INDEXED_CACHE_SECONDS : RELATED_CACHE_SECONDS);
  return cacheResponse(request, origin, env, ttl, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${RELATED_UPSTREAM_LIMIT}`;
    // Through the source helper, not a bare `fetchWithDeadline`: this used to
    // throw a plain Error with the status in its message and nothing on the
    // error itself, which is why the router could only ever answer 502. Six
    // seconds for this fetch -- but `awaitSharedPace` runs ahead of it in
    // `cacheResponse` and can itself add up to 2.5 s of sleep plus a couple of
    // ledger round trips, so the two no longer share a separate margin against
    // the browser. The client's abort budget for this route
    // (`related-papers-service.ts`) was raised from 8 s to 11 s to hold both,
    // rather than shrinking this deadline to carve room out of it: that would
    // hand a contended request -- one that hit the beat's wait precisely
    // because Semantic Scholar is already under pressure -- less time to talk
    // to a provider that is by hypothesis already slow.
    try {
      return await fetchJsonUpstream(url, env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {});
    } catch (error) {
      if ((error as UpstreamError)?.status === 404) return { recommendedPapers: [], code: PAPER_NOT_INDEXED };
      throw error;
    }
  }, { identity, canonicalParams: { paper_id: paperId } });
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
