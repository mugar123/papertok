/**
 * Titles that are actually paper identities must not be shown as titles.
 *
 * Several write paths used to stand the document id in for a missing
 * `paperTitle`. The Liked tab then rendered `openalex:W…` and arXiv numbers as
 * if they were names. An empty string is the honest value: the row still does
 * not know the title.
 */
const SCHEME_PREFIX = /^(openalex|doi|arxiv|ads|pmid|pmcid|s2|mag):/i;
const ARXIV_NEW = /^\d{4}\.\d{4,5}(v\d+)?$/i;
const ARXIV_OLD = /^[a-z][a-z-]+\/\d{7}(v\d+)?$/i;
const INVENTED = new Set([
  'paper sin titulo',
  'paper sin título',
  'untitled paper',
  'untitled',
]);

export function isPlaceholderPaperTitle(title, paperId) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return true;
  if (paperId && text === paperId) return true;
  if (INVENTED.has(text.toLowerCase())) return true;
  if (SCHEME_PREFIX.test(text)) return true;
  if (ARXIV_NEW.test(text) || ARXIV_OLD.test(text)) return true;
  return false;
}

export function resolvedPaperTitle(title, paperId) {
  return isPlaceholderPaperTitle(title, paperId) ? '' : String(title).trim();
}
