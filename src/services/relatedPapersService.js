import { PaperBuilder } from './PaperBuilder.js';
import { authenticatedWorkerFetch, workerSourceUrl } from './workerApiClient.js';

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

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

export async function getRelatedPapers(paper, limit = 8) {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];
  const cacheKey = `${paperId}:${limit}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  // There used to be a direct `api.semanticscholar.org` branch here for when no
  // Worker origin was configured. It could not ship — `vite build` refuses a
  // bundle without `VITE_PAPER_API_BASE_URL` — and it was a keyless browser call
  // to an API that rate-limits per provider, which is the whole reason this route
  // exists. A failure is a failure: there is no second route to try.
  const url = workerSourceUrl('/related', { paper_id: paperId, limit });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await authenticatedWorkerFetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Semantic Scholar API error: ${response.status}`);
    const payload = await response.json();
    const items = payload.recommendedPapers || payload.papers || [];
    const currentIds = new Set([paper.id, paper.arxivId, paper.doi].filter(Boolean).map(value => String(value).toLowerCase()));
    const related = PaperBuilder.deduplicate(items.map(mapRelatedPaper).filter(item => {
      return ![item.id, item.arxivId, item.doi].filter(Boolean).some(value => currentIds.has(String(value).toLowerCase()));
    })).slice(0, limit);
    CACHE.set(cacheKey, { data: related, timestamp: Date.now() });
    return related;
  } finally {
    clearTimeout(timeout);
  }
}
