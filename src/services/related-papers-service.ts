import type { Paper } from '../models/paper.ts';
import type { SemanticScholarRecord } from './adapters/semantic-scholar-adapter.ts';
interface RelatedOptions { fetchWorker?: (input: string | URL, options: RequestInit) => Promise<Response>; apiBase?: string; }

import { PaperBuilder } from './paper-builder.ts';
import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';

const CACHE = new Map<string, { data: Paper[]; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;
// One promise per paper while it is being asked: the cache only fills once the
// answer is in, and two callers in the same tick used to be two Worker calls
// and two provider calls in the same second.
const IN_FLIGHT = new Map<string, Promise<Paper[]>>();
// The Worker always answers twenty (`RELATED_UPSTREAM_LIMIT` there); every
// caller trims from that one list rather than asking for its own size.
export const RELATED_UPSTREAM_LIMIT = 20;

// Semantic Scholar does not resolve arXiv's own DataCite DOIs
// (`10.48550/arxiv.2005.14165` is a 404 there); it knows those papers by
// their arXiv id.
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

export function getSemanticScholarPaperId(paper: Partial<Paper>) {
  const doi = paper?.doi?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  const arxivId = paper?.arxivId || doi?.match(ARXIV_DOI)?.[1];
  if (doi && !ARXIV_DOI.test(doi)) return `DOI:${doi}`;
  if (arxivId) return `ARXIV:${arxivId.replace(/v\d+$/, '')}`;
  if (paper?.semanticScholarId) return paper.semanticScholarId;
  const source = paper?.sources?.primary;
  if ((source === 'semanticscholar' || source === 'semantic-scholar') && /^[a-f0-9]{40}$/i.test(paper.id || '')) {
    return paper.id;
  }
  return null;
}

function mapRelatedPaper(item: SemanticScholarRecord): Paper {
  const externalIds = item.externalIds || {};
  return PaperBuilder.create({
    id: externalIds.ArXiv ? `arxiv:${externalIds.ArXiv}` : item.paperId,
    sources: { primary: 'semantic-scholar', enrichedBy: [] },
    title: item.title,
    abstract: item.abstract ?? undefined,
    authors: (item.authors || []).map(author => ({ name: author.name, id: author.authorId })),
    arxivId: externalIds.ArXiv,
    doi: externalIds.DOI,
    year: item.year,
    published: item.publicationDate || (item.year ? `${item.year}-01-01` : ''),
    journal: item.venue,
    publicationType: item.publicationTypes?.[0] || 'article',
    publicationStatus: 'published',
    openAccess: Boolean(item.isOpenAccess || item.openAccessPdf?.url),
    pdfUrl: item.openAccessPdf?.url,
    landingPageUrl: item.url,
    citationCount: item.citationCount ?? undefined,
  });
}

// Semantic Scholar admits one request a second for the whole app, so a first
// Similar press often lands in a second something else already spent and the
// Worker answers `429` with `retry-after: 2` (PAP-49: it failed, and pressing
// again a moment later worked). That answer is waited out here, twice at most
// and inside the same eleven seconds. A longer wait (the minute ledger says 60)
// or a stall is a real failure, and retrying it would only add load.
const RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 3000;

function shortRetryAfterMs(response: Response) {
  if (response.status !== 429) return null;
  const seconds = Number(response.headers.get('retry-after'));
  return seconds > 0 && seconds * 1000 <= MAX_RETRY_WAIT_MS ? seconds * 1000 : null;
}

async function fetchRelatedFromWorker(paperId: string, paper: Partial<Paper>, { fetchWorker, apiBase }: RelatedOptions & { fetchWorker: NonNullable<RelatedOptions['fetchWorker']> }) {
  // There used to be a direct `api.semanticscholar.org` branch here for when no
  // Worker origin was configured. It could not ship — `vite build` refuses a
  // bundle without `VITE_PAPER_API_BASE_URL` — and it was a keyless browser call
  // to an API that rate-limits per provider, which is the whole reason this route
  // exists. A failure is a failure: there is no second route to try.
  const url = workerSourceUrl('/related', { paper_id: paperId }, apiBase);

  const controller = new AbortController();
  // 11 s, not 8: the Worker's own fetch to Semantic Scholar can take up to 6 s
  // (`SOURCE_UPSTREAM_TIMEOUT_MS`), and the one-a-second beat in front of it
  // (`awaitSharedPace`) can add up to 2.5 s of sleep plus a couple of ledger
  // round trips before that fetch even starts. 8 s was a comfortable margin
  // over the 6 s upstream deadline alone; once the beat could add up to 2.5 s
  // more on top of it, 8 s would abort mid-beat on exactly the contended
  // requests the beat exists to pace, throwing away the second (and the
  // provider call, once it lands) for nobody.
  const timeout = setTimeout(() => controller.abort(), 11000);
  try {
    let response = await fetchWorker(url, { signal: controller.signal });
    for (let retry = 0; !response.ok && retry < RATE_LIMIT_RETRIES; retry += 1) {
      const waitMs = shortRetryAfterMs(response);
      if (waitMs === null) break;
      await new Promise(resolve => setTimeout(resolve, waitMs));
      response = await fetchWorker(url, { signal: controller.signal });
    }
    if (!response.ok) throw new Error(`Semantic Scholar API error: ${response.status}`);
    const payload = await response.json() as { recommendedPapers?: SemanticScholarRecord[]; papers?: SemanticScholarRecord[] };
    const items = payload.recommendedPapers || payload.papers || [];
    const currentIds = new Set([paper.id, paper.arxivId, paper.doi].filter(Boolean).map(value => String(value).toLowerCase()));
    return PaperBuilder.deduplicate(items.map(mapRelatedPaper).filter(item => {
      return ![item.id, item.arxivId, item.doi].filter(Boolean).some(value => currentIds.has(String(value).toLowerCase()));
    })).slice(0, RELATED_UPSTREAM_LIMIT);
  } finally {
    clearTimeout(timeout);
  }
}

// `fetchWorker` and `apiBase` are the same seam the adapters have: the real
// path needs a Firebase session and a configured Worker origin, neither of
// which exists under `node --test`. `apiBase` left undefined lets
// `workerSourceUrl` fall back to the configured origin.
export async function getRelatedPapers(paper: Partial<Paper>, limit = 8, { fetchWorker = authenticatedWorkerFetch, apiBase }: RelatedOptions = {}) {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];
  const cached = CACHE.get(paperId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data.slice(0, limit);

  let request = IN_FLIGHT.get(paperId);
  if (!request) {
    request = fetchRelatedFromWorker(paperId, paper, { fetchWorker, apiBase })
      .then(related => {
        CACHE.set(paperId, { data: related, timestamp: Date.now() });
        return related;
      })
      .finally(() => {
        if (IN_FLIGHT.get(paperId) === request) IN_FLIGHT.delete(paperId);
      });
    IN_FLIGHT.set(paperId, request);
  }
  const related = await request;
  return related.slice(0, limit);
}

export function clearRelatedPapersCache() {
  CACHE.clear();
  IN_FLIGHT.clear();
}
