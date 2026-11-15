// How a keyword lane (`query:<text>`) asks OpenAlex for its papers: in titles
// and abstracts, not in the full text, where any paper that mentions the words
// in passing matched (5 of the first 88 papers of five keywords were about
// their keyword, 2026-11-14).

/** A keyword lane holds the papers of one keyword: a followed search's, or a custom feed's ingredient. */
export const KEYWORD_LANE_PREFIX = 'query:';
export const isKeywordLane = (lane: string) => lane.startsWith(KEYWORD_LANE_PREFIX);

/** How a keyword is asked: its words next to each other, or each of them anywhere. */
export type KeywordReading = 'phrase' | 'words';

/**
 * The text of a keyword a filter can carry, or '' when nothing is left of it.
 * Inside a filter `|` is an "or", `:` names a field and a comma starts the
 * next filter, so only letters (with their marks), digits, spaces and the
 * hyphens inside a word stay. A hyphen at a word's edge would negate it. An
 * apostrophe inside a word goes without splitting it: "alzheimer's" split in
 * two would also ask for a word "s".
 */
export function keywordSearchText(value: string) {
  return value.normalize('NFKC').toLowerCase()
    .replace(/(?<=\p{L})['’](?=\p{L})/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, ' ')
    .replace(/(?<![\p{L}\p{M}\p{N}])-|-(?![\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The OpenAlex filter of a keyword lane, without its dates: the keyword in
 * titles and abstracts, as research papers, none retracted.
 */
export function keywordFilter(text: string, reading: KeywordReading) {
  return [
    `title_and_abstract.search:${reading === 'phrase' ? `"${text}"` : text}`,
    'is_retracted:false',
    'type:article|review|conference-paper|preprint',
  ].join(',');
}
