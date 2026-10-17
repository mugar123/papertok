import type { Paper } from '../models/Paper.ts';

import { getRelatedPapers, getSemanticScholarPaperId } from './relatedPapersService.ts';

const RECOMMENDATION_LIMIT = 20;

// getRelatedPapers owns the cache and in-flight requests shared with the sheet.
// Caching the projected IDs here would bypass that cache's expiry.
export async function getPaperRecommendations(paper: Partial<Paper>, { fetchRelated = getRelatedPapers }: { fetchRelated?: (paper: Partial<Paper>, limit: number) => Promise<{ arxivId?: string | null }[]> } = {}): Promise<string[]> {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];

  try {
    const related = await fetchRelated(paper, RECOMMENDATION_LIMIT);
    return related.map(item => item.arxivId).filter(Boolean) as string[];
  } catch (error) {
    console.warn('Semantic Scholar recommendations unavailable', error);
    return [];
  }
}
