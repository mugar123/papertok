import type { Paper } from '../models/paper.ts';

const SEMANTIC_SCHOLAR_HOME = 'https://www.semanticscholar.org/?utm_source=api';

type SourceAttribution = {
  label: 'From' | 'With data from' | 'Abstract:';
  name: 'Semantic Scholar' | 'Crossref';
  href?: string;
};

// A Semantic Scholar record keeps its corpus hash as its `id` when it has no
// arXiv id (the search adapter).
const SEMANTIC_SCHOLAR_HASH = /^[a-f0-9]{40}$/i;

/**
 * The one line under a paper's abstract that credits where its data came
 * from, or null. Semantic Scholar's API licence asks for a visible credit,
 * linked back with `utm_source=api`, wherever its data is shown. The card and
 * the abstract sheet carry it; the similar-papers layer, whose list is
 * Semantic Scholar's recommendations, carries none for now (Nicolás,
 * 2026-10-25; ENG-129). The label leads into the name: "From" for Semantic
 * Scholar's own record (`sources.primary`); "Abstract:" for an abstract
 * Semantic Scholar or Crossref supplied (`abstractSource`, ENG-109); "With
 * data from" when something else of Semantic Scholar's was merged in
 * (`sources.enrichedBy`, written `semanticscholar`), which does not name a
 * field. The card has one line, so Semantic Scholar's credit, which its
 * licence asks for, comes before Crossref's. Crossref's names it without a
 * link, which its terms do not ask for.
 */
export function sourceAttribution(paper: Partial<Paper> | null | undefined): SourceAttribution | null {
  // `semantic-scholar` is defensive: related-papers-service.ts writes it, but
  // classifySimilarPapers replaces those records with arXiv or OpenAlex ones
  // before any card shows them.
  const primary = paper?.sources?.primary;
  const isRecord = primary === 'semanticscholar' || primary === 'semantic-scholar';
  const label = isRecord
    ? 'From'
    : paper?.abstractSource === 'semanticscholar'
      ? 'Abstract:'
      : paper?.sources?.enrichedBy?.includes('semanticscholar')
        ? 'With data from'
        : null;
  if (!label) return paper?.abstractSource === 'crossref' ? { label: 'Abstract:', name: 'Crossref' } : null;
  const id = typeof paper?.semanticScholarId === 'string' && paper.semanticScholarId
    ? paper.semanticScholarId
    : isRecord && SEMANTIC_SCHOLAR_HASH.test(paper?.id || '') ? paper?.id : null;
  const href = id ? `https://www.semanticscholar.org/paper/${id}?utm_source=api` : SEMANTIC_SCHOLAR_HOME;
  return { label, name: 'Semantic Scholar', href };
}
