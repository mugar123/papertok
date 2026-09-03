import { PaperBuilder } from './PaperBuilder.js';
import { authenticatedWorkerFetch, workerSourceUrl } from './workerApiClient.js';

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
// One promise per paper while it is being asked: the cache only fills once the
// answer is in, and two callers in the same tick used to be two Worker calls
// and two provider calls in the same second.
const IN_FLIGHT = new Map();
// The Worker always answers twenty (`RELATED_UPSTREAM_LIMIT` there); every
// caller trims from that one list rather than asking for its own size.
const RELATED_UPSTREAM_LIMIT = 20;

export function getSemanticScholarPaperId(paper) {
  if (paper?.doi) return `DOI:${paper.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')}`;
  if (paper?.arxivId) return `ARXIV:${paper.arxivId.replace(/v\d+$/, '')}`;
  if (paper?.semanticScholarId) return paper.semanticScholarId;
  return null;
}

function mapRelatedPaper(item) {
  const externalIds = item.externalIds || {};
  return PaperBuilder.create({
    id: externalIds.ArXiv ? `arxiv:${externalIds.ArXiv}` : item.paperId,
    sources: { primary: 'semantic-scholar', enrichedBy: [] },
    title: item.title,
    abstract: item.abstract || 'Resumen no disponible.',
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
    citationCount: item.citationCount || 0,
  });
}

async function fetchRelatedFromWorker(paperId, paper, { fetchWorker, apiBase }) {
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
    const response = await fetchWorker(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Semantic Scholar API error: ${response.status}`);
    const payload = await response.json();
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
export async function getRelatedPapers(paper, limit = 8, { fetchWorker = authenticatedWorkerFetch, apiBase } = {}) {
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

// Same escape hatch `semanticScholarService` exposes: a module-level cache that
// survives between tests makes the second one lie about what the first proved.
export function clearRelatedPapersCache() {
  CACHE.clear();
  IN_FLIGHT.clear();
}
