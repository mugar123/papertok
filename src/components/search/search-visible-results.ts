import type { SearchScope } from '../../services/entity-search-service.ts';

/**
 * What the search page shows for the scope on screen. A direct ORCID hit
 * (`cleanOrcid`) is a result under All and Authors, nowhere else.
 * `visibleResultCount` is the number the hidden live region announces, so it
 * counts exactly what `hasVisibleResults` decides to paint: a bare ORCID that
 * matches nothing else renders its card and must not be announced as "No
 * results found".
 */
export function visibleSearchResults({ scope, papers, authors, institutions, topics, projects, cleanOrcid }: {
  scope: SearchScope;
  papers: number; authors: number; institutions: number; topics: number; projects: number;
  cleanOrcid: string | null;
}) {
  const hasSearchSectionResults = papers > 0
    || authors > 0
    || institutions > 0
    || topics > 0
    || projects > 0;
  const hasResults = hasSearchSectionResults || !!cleanOrcid;
  const hasVisibleResults = scope === 'all'
    ? hasResults
    : scope === 'papers'
      ? papers > 0
      : scope === 'institutions'
        ? institutions > 0
        : scope === 'authors'
          ? authors > 0 || !!cleanOrcid
          : scope === 'projects'
            ? projects > 0
            : topics > 0;
  const visibleResultCount = scope === 'all'
    ? papers + authors + institutions
      + topics + projects
      + (cleanOrcid ? 1 : 0)
    : scope === 'papers'
      ? papers
      : scope === 'institutions'
        ? institutions
        : scope === 'authors'
          ? authors + (cleanOrcid ? 1 : 0)
          : scope === 'projects'
            ? projects
            : topics;
  return { hasResults, hasVisibleResults, visibleResultCount };
}
