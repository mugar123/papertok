import { PaperBuilder } from './PaperBuilder.js';

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

  const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  const url = apiBase
    ? `${apiBase}/related?paper_id=${encodeURIComponent(paperId)}&limit=${limit}`
    : `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${limit}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal });
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
