import { auth } from './firebase.js';
import { hasUsableAIAbstract, isAIReadablePdfUrl } from '../utils/aiExplanationAccess.js';

const explanationCache = new Map();

export const AI_EXPLANATION_LEVELS = Object.freeze([
  { id: 'beginner', label: 'Principiante' },
  { id: 'university', label: 'Universitario' },
  { id: 'researcher', label: 'Investigador' },
]);

export class AIExplanationServiceError extends Error {
  constructor(code, message = code, quota = null) {
    super(message);
    this.name = 'AIExplanationServiceError';
    this.code = code;
    this.quota = quota;
  }
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function paperCacheId(paper) {
  return cleanText(paper?.id || paper?.doi || paper?.arxivId || paper?.title, 500).toLowerCase();
}

function getOpenPdfUrl(paper) {
  const candidates = [paper?.openAccessPdfUrl];
  if (paper?.arxivId) {
    const arxivId = String(paper.arxivId).replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
    candidates.push(`https://arxiv.org/pdf/${arxivId}.pdf`);
  }
  if (paper?.openAccess && paper?.pdfUrl) candidates.push(paper.pdfUrl);
  if (paper?.pmcid) candidates.push(`https://pmc.ncbi.nlm.nih.gov/articles/${encodeURIComponent(paper.pmcid)}/pdf/`);
  return candidates.find(isAIReadablePdfUrl) || '';
}

export function hasUsableAbstract(paper) {
  const abstract = cleanText(paper?.abstract || paper?.summary, 30_000);
  return hasUsableAIAbstract(abstract);
}

export function canExplainPaper(paper) {
  return hasUsableAbstract(paper) || Boolean(getOpenPdfUrl(paper));
}

export function formatAIModelLabel(model) {
  const value = cleanText(model, 100);
  if (!value) return 'Modelo de IA';

  if (!/^gemini[-\s]/i.test(value)) return value;

  const version = value
    .replace(/^gemini[-\s]*/i, '')
    .split(/[-\s]+/)
    .filter(Boolean)
    .map(part => /^[a-z]+$/i.test(part) ? `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}` : part)
    .join(' ');

  return version ? `Gemini ${version}` : 'Gemini';
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
      throw new AIExplanationServiceError(payload.code || 'AI_UNAVAILABLE', payload.code || 'AI_UNAVAILABLE', payload.quota || null);
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
