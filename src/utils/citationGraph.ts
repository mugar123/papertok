export interface CitationRow { cited?: string; citing?: string; creation?: string; author_sc?: string; journal_sc?: string }
const DOI_PREFIX_PATTERN = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const DOI_TOKEN_PATTERN = /(?:^|\s)doi:(10\.\d{4,9}\/\S+)/ig;
const OPENALEX_TOKEN_PATTERN = /(?:^|\s)openalex:(W\d+)/i;

export function normalizeCitationDoi(value: string|null|undefined) {
  return String(value || '')
    .trim()
    .replace(DOI_PREFIX_PATTERN, '')
    .replace(/[\s.,;]+$/, '')
    .toLowerCase();
}

export function extractCitationDoi(value: unknown) {
  const text = String(value || '');
  const matches = [...text.matchAll(DOI_TOKEN_PATTERN)];
  return normalizeCitationDoi(matches[0]?.[1] || '');
}

export function extractCitationOpenAlexId(value: unknown) {
  return String(value || '').match(OPENALEX_TOKEN_PATTERN)?.[1] || '';
}

export function normalizeCitationRows(rows: CitationRow[] | null | undefined, relation: string, currentDoi = '') {
  const relationField = relation === 'reference' ? 'cited' : 'citing';
  const normalizedCurrentDoi = normalizeCitationDoi(currentDoi);
  const seen = new Set<string>();

  return (Array.isArray(rows) ? rows : []).flatMap(row => {
    const identifiers = row?.[relationField] || '';
    const doi = extractCitationDoi(identifiers);
    const openAlexId = extractCitationOpenAlexId(identifiers);
    const key = doi || openAlexId.toLowerCase();
    if (!key || doi === normalizedCurrentDoi || seen.has(key)) return [];
    seen.add(key);
    return [{
      doi,
      openAlexId,
      relation,
      date: row?.creation || '',
      authorSelfCitation: row?.author_sc === 'yes',
      journalSelfCitation: row?.journal_sc === 'yes',
    }];
  });
}

/**
 * @param {Array<import('../models/Paper.ts').Paper | null>} papers
 * @returns {import('../models/Paper.ts').Paper[]}
 */
export function deduplicateCitationGraphPapers(papers: Array<import('../models/Paper.ts').Paper|null>, limit = 8): import('../models/Paper.ts').Paper[] {
  const seen = new Set<string>();
  return (Array.isArray(papers) ? papers : []).filter(paper => {
    const key = normalizeCitationDoi(paper?.doi)
      || String(paper?.openAlexId || paper?.id || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit) as import('../models/Paper.ts').Paper[];
}
