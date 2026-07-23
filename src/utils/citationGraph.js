const DOI_PREFIX_PATTERN = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const DOI_TOKEN_PATTERN = /(?:^|\s)doi:(10\.\d{4,9}\/\S+)/ig;
const OPENALEX_TOKEN_PATTERN = /(?:^|\s)openalex:(W\d+)/i;

export function normalizeCitationDoi(value) {
  return String(value || '')
    .trim()
    .replace(DOI_PREFIX_PATTERN, '')
    .replace(/[\s.,;]+$/, '')
    .toLowerCase();
}

export function extractCitationDoi(value) {
  const text = String(value || '');
  const matches = [...text.matchAll(DOI_TOKEN_PATTERN)];
  return normalizeCitationDoi(matches[0]?.[1] || '');
}

export function extractCitationOpenAlexId(value) {
  return String(value || '').match(OPENALEX_TOKEN_PATTERN)?.[1] || '';
}

export function normalizeCitationRows(rows, relation, currentDoi = '') {
  const relationField = relation === 'reference' ? 'cited' : 'citing';
  const normalizedCurrentDoi = normalizeCitationDoi(currentDoi);
  const seen = new Set();

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

export function deduplicateCitationGraphPapers(papers, limit = 8) {
  const seen = new Set();
  return (Array.isArray(papers) ? papers : []).filter(paper => {
    const key = normalizeCitationDoi(paper?.doi)
      || String(paper?.openAlexId || paper?.id || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
