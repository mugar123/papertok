import { CATEGORIES } from '../data/categories.js';

function getPaperTimestamp(paper) {
  const timestamp = new Date(paper.published || paper.publicationDate || '').getTime();
  if (Number.isFinite(timestamp)) return timestamp;
  const year = Number(paper.year);
  return Number.isFinite(year) ? new Date(`${year}-01-01T00:00:00Z`).getTime() : 0;
}

function matchesCategory(paper, areaId) {
  if (!areaId) return true;
  const categories = [
    paper.primaryCategory,
    ...(paper.categories || []),
    ...(paper.allCategories || []),
  ].filter(Boolean);
  const areaCategories = Object.keys(CATEGORIES[areaId]?.subcategories || {});
  return categories.includes(areaId) || categories.some(category => areaCategories.includes(category));
}

export function getPaperCitationCount(paper) {
  const candidates = [
    paper?.citationCount,
    paper?.citationsCount,
    paper?.openAlex?.citationCount,
    paper?.openAlex?.cited_by_count,
  ];
  const citationCount = candidates.find(value => Number.isFinite(Number(value)));
  return Math.max(0, Number(citationCount) || 0);
}

export function hasKnownPaperCitationCount(paper) {
  return paper?.citationCountKnown === true
    || paper?.openAlex?.citationCountKnown === true
    || getPaperCitationCount(paper) > 0;
}

export function filterAndSortEntityPapers(papers, { searchQuery = '', filters = {}, sortBy = '' } = {}) {
  const query = searchQuery.trim().toLowerCase();
  const now = new Date();
  const minYear = filters.dateRange === 'last_year'
    ? now.getFullYear() - 1
    : filters.dateRange === 'last_5_years'
      ? now.getFullYear() - 5
      : null;

  const filtered = (papers || []).filter(paper => {
    if (query) {
      const authors = (paper.authors || []).map(author => author?.name || author).join(' ');
      const searchable = [paper.title, paper.abstract, paper.summary, authors]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(query)) return false;
    }

    if (!matchesCategory(paper, filters.category)) return false;
    if (filters.peerReviewed && !paper.isPeerReviewed) return false;
    if (minYear !== null && getPaperTimestamp(paper) < new Date(`${minYear}-01-01T00:00:00Z`).getTime()) return false;
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sortBy === 'publication_date:desc') return getPaperTimestamp(b) - getPaperTimestamp(a);
    if (sortBy === 'cited_by_count:desc') {
      const citationsA = getPaperCitationCount(a);
      const citationsB = getPaperCitationCount(b);
      return citationsB - citationsA;
    }
    return 0;
  });
}

function normalizePaperId(paperId) {
  if (!paperId) return '';
  const id = paperId.startsWith('arxiv:') ? paperId.split(':')[1] : paperId;
  return id.replace(/v\d+$/, '');
}

export function pinSourcePaper(papers, sourcePaperId) {
  const sourceId = normalizePaperId(sourcePaperId);
  if (!sourceId) return papers;
  const sourceIndex = papers.findIndex(paper => normalizePaperId(paper.id) === sourceId);
  if (sourceIndex <= 0) return papers;
  return [papers[sourceIndex], ...papers.slice(0, sourceIndex), ...papers.slice(sourceIndex + 1)];
}

/**
 * What a request for an entity's papers depends on, as one string.
 *
 * The Explorer issues that request from an effect, and an effect cannot tell a
 * re-render from a new request on its own: it re-ran — and its cleanup
 * cancelled whatever was in flight — whenever any dependency changed identity,
 * including the active tab and, for a project, the entity object itself,
 * which is set twice (optimistically from the link, then from its details).
 * Keying the request by the inputs it actually reads lets the effect leave a
 * matching request alone, in flight or already answered.
 *
 * Only the name the request actually reads is part of the key. A project's
 * papers come from OpenAIRE by grant code alone, so no name — the one field
 * that changes between the optimistic entity and the detailed one. A topic's
 * providers are asked with the localized name; every other type passes the
 * entity's own, as the author search phrase or `getWorksByEntity`'s fallback.
 */
export function entityPapersRequestKey({
  type,
  id,
  entity,
  entityDisplayName,
  sortBy,
  page,
  searchQuery,
  filters,
  searchParams,
  reloadKey,
  entityReloadKey,
}) {
  return JSON.stringify([
    type,
    id,
    entity?.id || id,
    type === 'project'
      ? ''
      : ['concept', 'topic'].includes(type)
        ? entityDisplayName || ''
        : entity?.display_name || '',
    Boolean(entity?._localTopic),
    Boolean(entity?._queryTopic),
    sortBy,
    page,
    searchQuery,
    filters,
    searchParams,
    reloadKey,
    entityReloadKey,
  ]);
}

/**
 * How many rows the Explorer's list mounts at a time.
 *
 * A works page is thirty papers, each row a title and an abstract through the
 * LaTeX splitter and KaTeX, and the page they make is thirteen thousand
 * pixels tall. Mounted in one commit on a phone with the CPU at a quarter
 * speed, that was tasks of 140–220 ms the moment the page answered, with
 * two screens of rows visible and the rest below the fold. Eight rows is two
 * screens; the rest follow in idle chunks, and the "load more" sentinel
 * waits until every row the page already has is in.
 */
export const EXPLORER_ROW_CHUNK = 8;

/** The next row budget: `chunk` more rows, never past what the list has. */
export function nextExplorerRowBudget(budget, total, chunk = EXPLORER_ROW_CHUNK) {
  return Math.min(Math.max(0, total), Math.max(0, budget) + chunk);
}

