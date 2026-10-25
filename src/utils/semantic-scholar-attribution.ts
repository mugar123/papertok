import type { Paper } from '../models/paper.ts';

/**
 * Semantic Scholar's API licence asks for a visible credit, linked back with
 * `utm_source=api`, wherever its data is shown. This decides whether a paper
 * carries any: its record (`sources.primary`) or an abstract recovered from it
 * at enrichment (`sources.enrichedBy`, which the Worker writes as
 * `semanticscholar`). Anything else is not its data and gets no credit.
 */
export const SEMANTIC_SCHOLAR_HOME = 'https://www.semanticscholar.org/?utm_source=api';

type SemanticScholarAttribution = {
  label: 'Record from Semantic Scholar' | 'Abstract from Semantic Scholar';
  href: string;
};

// A Semantic Scholar record keeps its corpus hash as its `id` when it has no
// arXiv id (search adapter, related-papers-service.ts).
const SEMANTIC_SCHOLAR_HASH = /^[a-f0-9]{40}$/i;

export function semanticScholarAttribution(paper: Partial<Paper> | null | undefined): SemanticScholarAttribution | null {
  // The related papers are still built under the older `semantic-scholar`.
  const primary = paper?.sources?.primary;
  const isRecord = primary === 'semanticscholar' || primary === 'semantic-scholar';
  const label = isRecord
    ? 'Record from Semantic Scholar'
    : paper?.sources?.enrichedBy?.includes('semanticscholar')
      ? 'Abstract from Semantic Scholar'
      : null;
  if (!label) return null;
  const id = typeof paper?.semanticScholarId === 'string' && paper.semanticScholarId
    ? paper.semanticScholarId
    : isRecord && SEMANTIC_SCHOLAR_HASH.test(paper?.id || '') ? paper?.id : null;
  const href = id ? `https://www.semanticscholar.org/paper/${id}?utm_source=api` : SEMANTIC_SCHOLAR_HOME;
  return { label, href };
}
