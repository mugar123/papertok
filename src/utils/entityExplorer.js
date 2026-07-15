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
      const citationsA = a.citationCount ?? a.citationsCount ?? a.openAlex?.cited_by_count ?? 0;
      const citationsB = b.citationCount ?? b.citationsCount ?? b.openAlex?.cited_by_count ?? 0;
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
