import type { WorkerEnv } from './env.ts';
import type { Paper } from '../src/models/Paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { VerifiedIdentity } from './firebase-auth.ts';
import type { UpstreamError } from './provider-runtime.ts';

type CitationConnection = { doi?: string; openAlexId?: string; relation?: string };


import {
  deduplicateCitationGraphPapers,
  extractCitationDoi,
  extractCitationOpenAlexId,
  normalizeCitationDoi,
  normalizeCitationRows,
} from '../src/utils/citationGraph.js';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { addOpenAlexCredentials, fetchOpenAlexJsonWithFallback } from './openalex-api.ts';
import { cacheResponse, DEGRADED_CACHE_SECONDS, fetchJsonWithTimeout, getSafeLimit, OPENALEX_CALLS } from './provider-runtime.ts';

const CITATION_GRAPH_CACHE_SECONDS = 7 * 24 * 60 * 60;

function reconstructOpenAlexAbstract(invertedIndex: OpenAlexWork['abstract_inverted_index']) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  return Object.entries(invertedIndex)
    .flatMap(([word, positions]) => (Array.isArray(positions) ? positions : []).map((position): [number, string] => [position, word]))
    .sort(([positionA], [positionB]) => positionA - positionB)
    .map(([, word]) => word)
    .join(' ');
}

function mapCitationGraphWork(work: OpenAlexWork | null): Paper | null {
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
    citationCount: Number.isFinite(work.cited_by_count) ? work.cited_by_count! : 0,
    citationCountKnown: Number.isFinite(work.cited_by_count),
    concepts: (work.concepts || []).filter(concept => (concept.score ?? 1) > 0).slice(0, 8),
    topics: (work.topics || []).slice(0, 3),
    primaryTopic: work.primary_topic || null,
  };
}

function mapOpenCitationsMetaWork(work: Record<string, string> | null): Paper | null {
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

async function fetchOpenAlexCurrentWork(doi: string, env: WorkerEnv) {
  const url = addOpenAlexCredentials(
    new URL(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`),
    env,
  );
  url.searchParams.set('select', 'id,referenced_works,cited_by_count');
  try {
    return { work: await fetchOpenAlexJsonWithFallback<OpenAlexWork>(url, env, 6500), failed: false };
  } catch (error) {
    // A DOI OpenAlex has never heard of is an answer, and the graph built without
    // it is the real one. Anything else is an outage, and the difference decides
    // whether the result may own its cache entry for a week.
    return { work: null, failed: (error as UpstreamError)?.status !== 404 };
  }
}

async function fetchOpenAlexWorksByFilter(filterName: string, values: Array<string | undefined>, env: WorkerEnv) {
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
    const payload = await fetchOpenAlexJsonWithFallback<{ results?: OpenAlexWork[] }>(url, env, 7500);
    return payload?.results || [];
  }));
  // A rejected batch is a shorter answer, and until now it was a shorter answer
  // that looked exactly like a complete one -- and got cached for seven days.
  return {
    works: batches.flatMap(batch => batch.status === 'fulfilled' ? batch.value : []),
    failed: batches.some(batch => batch.status === 'rejected'),
  };
}

async function fetchOpenCitationsMetadata(connections: CitationConnection[], env: WorkerEnv) {
  const dois = [...new Set(connections.map(item => item.doi).filter(Boolean))].slice(0, 16);
  const chunks = [];
  for (let index = 0; index < dois.length; index += 5) chunks.push(dois.slice(index, index + 5));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.OPENCITATIONS_ACCESS_TOKEN) headers.authorization = env.OPENCITATIONS_ACCESS_TOKEN;
  const batches = await Promise.allSettled(chunks.map(chunk => {
    const ids = chunk.map(doi => `doi:${encodeURIComponent(doi!)}`).join('__');
    return fetchJsonWithTimeout<Array<Record<string, string>>>(`https://api.opencitations.net/meta/v1/metadata/${ids}`, { headers }, 9000);
  }));
  return batches
    .flatMap(batch => batch.status === 'fulfilled' ? batch.value : [])
    .map(mapOpenCitationsMetaWork)
    .filter(Boolean);
}

async function resolveCitationConnections(connections: CitationConnection[], env: WorkerEnv, limit: number, relation: string) {
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

async function fetchOpenAlexCitingWorks(openAlexId: string | undefined, env: WorkerEnv, limit: number) {
  if (!openAlexId) return [];
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  url.searchParams.set('filter', `cites:${openAlexId}`);
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per-page', String(Math.min(40, limit * 4)));
  url.searchParams.set('select', CITATION_GRAPH_OPENALEX_SELECT);
  const payload = await fetchOpenAlexJsonWithFallback<{ results?: OpenAlexWork[] }>(url, env, 7500);
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
function citationGraphCacheSeconds(payload: { degraded?: boolean }) {
  return payload?.degraded ? DEGRADED_CACHE_SECONDS : CITATION_GRAPH_CACHE_SECONDS;
}

async function fetchOpenCitationsRows(doi: string, relation: string, env: WorkerEnv) {
  const url = new URL(`https://api.opencitations.net/index/v2/${relation}/doi:${encodeURIComponent(doi)}`);
  url.searchParams.set('format', 'json');
  if (relation === 'citations') url.searchParams.set('sort', 'desc(creation)');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.OPENCITATIONS_ACCESS_TOKEN) headers.authorization = env.OPENCITATIONS_ACCESS_TOKEN;
  return fetchJsonWithTimeout(url, { headers }, 7500);
}

export async function handleCitationGraph(request: Request, env: WorkerEnv, identity?: Pick<VerifiedIdentity, 'uid'> | null) {
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
    let referenceConnections: CitationConnection[] = normalizeCitationRows(
      referenceResult.status === 'fulfilled' ? referenceResult.value : [],
      'reference',
      doi,
    );
    const citationConnections: CitationConnection[] = normalizeCitationRows(
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
