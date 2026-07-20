import { auth } from './firebase.js';

const explanationCache = new Map();

export const AI_EXPLANATION_LEVELS = Object.freeze([
  { id: 'beginner', label: 'Principiante' },
  { id: 'university', label: 'Universitario' },
  { id: 'researcher', label: 'Investigador' },
]);

export class AIExplanationServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AIExplanationServiceError';
    this.code = code;
  }
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function paperCacheId(paper) {
  return cleanText(paper?.id || paper?.doi || paper?.arxivId || paper?.title, 500).toLowerCase();
}

function getOpenPdfUrl(paper) {
  if (paper?.openAccessPdfUrl) return paper.openAccessPdfUrl;
  if (paper?.arxivId) {
    const arxivId = String(paper.arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
    return `https://arxiv.org/pdf/${arxivId}.pdf`;
  }
  if (paper?.openAccess && paper?.pdfUrl) return paper.pdfUrl;
  if (paper?.pmcid) return `https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(paper.pmcid)}/pdf/`;
  return '';
}

export function serializePaperForExplanation(paper) {
  return {
    id: cleanText(paper?.id, 400),
    title: cleanText(paper?.title, 1_000),
    abstract: cleanText(paper?.abstract || paper?.summary, 30_000),
    authors: Array.isArray(paper?.authors)
      ? paper.authors.slice(0, 30).map(author => ({ name: cleanText(author?.name || author, 160) }))
      : [],
    year: paper?.year || (paper?.published ? new Date(paper.published).getFullYear() : null),
    doi: cleanText(paper?.doi, 300),
    arxivId: cleanText(paper?.arxivId, 100),
    journal: cleanText(paper?.journal || paper?.journalRef, 300),
    categories: Array.isArray(paper?.categories)
      ? paper.categories.slice(0, 20)
      : [paper?.primaryCategory].filter(Boolean),
    concepts: Array.isArray(paper?.concepts)
      ? paper.concepts.slice(0, 20).map(concept => ({
        name: cleanText(concept?.display_name || concept?.name || concept, 120),
      }))
      : [],
    pdfUrl: getOpenPdfUrl(paper),
  };
}

export async function explainPaper(paper, level = 'university', { force = false } = {}) {
  if (!AI_EXPLANATION_LEVELS.some(item => item.id === level)) {
    throw new AIExplanationServiceError('AI_INVALID_LEVEL');
  }
  const cacheKey = `${paperCacheId(paper)}:${level}`;
  if (!force && explanationCache.has(cacheKey)) return explanationCache.get(cacheKey);

  const apiBase = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!apiBase) throw new AIExplanationServiceError('AI_NOT_CONFIGURED');
  const currentUser = auth.currentUser;
  if (!currentUser) throw new AIExplanationServiceError('AI_AUTH_REQUIRED');
  const token = await currentUser.getIdToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70_000);
  try {
    const response = await fetch(`${apiBase}/ai/explain`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        paper: serializePaperForExplanation(paper),
        level,
        language: 'es',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new AIExplanationServiceError(payload.code || 'AI_UNAVAILABLE');
    }
    explanationCache.set(cacheKey, payload);
    return payload;
  } catch (error) {
    if (error instanceof AIExplanationServiceError) throw error;
    if (error?.name === 'AbortError') throw new AIExplanationServiceError('AI_TIMEOUT');
    throw new AIExplanationServiceError('AI_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}
