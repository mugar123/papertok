import type { Paper } from '../models/paper.ts';

export const SEMANTIC_SCHOLAR_HOME = 'https://www.semanticscholar.org/?utm_source=api';

type SemanticScholarAttribution = {
  label: 'From' | 'With data from';
  href: string;
};

// A Semantic Scholar record keeps its corpus hash as its `id` when it has no
// arXiv id (the search adapter).
const SEMANTIC_SCHOLAR_HASH = /^[a-f0-9]{40}$/i;

/**
 * Semantic Scholar's API licence asks for a visible credit, linked back with
 * `utm_source=api`, wherever its data is shown. This decides whether a paper
 * carries any, and the words that lead into the linked name: "From" for its
 * own record (`sources.primary`), "With data from" when something of it was
 * merged in (`sources.enrichedBy`, written `semanticscholar`). The second
 * does not name a field: a merge tags the source whether or not its abstract
 * won, so an abstract under that tag may be OpenAlex's.
 */
export function semanticScholarAttribution(paper: Partial<Paper> | null | undefined): SemanticScholarAttribution | null {
  // `semantic-scholar` is defensive: related-papers-service.ts writes it, but
  // classifySimilarPapers replaces those records with arXiv or OpenAlex ones
  // before any card shows them.
  const primary = paper?.sources?.primary;
  const isRecord = primary === 'semanticscholar' || primary === 'semantic-scholar';
  const label = isRecord
    ? 'From'
    : paper?.sources?.enrichedBy?.includes('semanticscholar')
      ? 'With data from'
      : null;
  if (!label) return null;
  const id = typeof paper?.semanticScholarId === 'string' && paper.semanticScholarId
    ? paper.semanticScholarId
    : isRecord && SEMANTIC_SCHOLAR_HASH.test(paper?.id || '') ? paper?.id : null;
  const href = id ? `https://www.semanticscholar.org/paper/${id}?utm_source=api` : SEMANTIC_SCHOLAR_HOME;
  return { label, href };
}
