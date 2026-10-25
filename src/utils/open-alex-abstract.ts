import type { OpenAlexWork } from '../services/adapters/open-alex-types.ts';

/**
 * OpenAlex ships abstracts as an inverted index — `{ word: [positions] }` —
 * rather than as text, which is how abstract content stays inside the open
 * corpus at all. Rebuilding it was written out by hand in four places: the
 * OpenAlex adapter, the OpenAlex service, the scientific report, and the PubMed
 * adapter's own OpenAlex call. The copies had already drifted — one sorted pairs
 * and skipped the whitespace pass the others did — which is the same shape as
 * the `openalex:` filter that diverged and spent years answering 400.
 *
 * Returns the text, or an empty string when there is nothing to rebuild.
 */
export function reconstructOpenAlexAbstract(invertedIndex: unknown) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';

  const words = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0) words[position] = word;
    }
  }

  // A gap in the positions leaves a hole in the sparse array, which `join`
  // renders as a doubled space. Collapsing whitespace is what keeps a partial
  // index readable instead of ragged.
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// For these OpenAlex work types the inverted index holds the text itself, not
// a summary of it: W7211952859, an editorial, carried 9137 characters of its
// own body with the paragraph breaks lost ("response.A particularly"), and the
// card showed all of it as the abstract (audit 2026-09-23).
const TYPES_WITHOUT_ABSTRACT = new Set(['editorial', 'letter', 'erratum', 'paratext']);
// Structured abstracts run to about 3000 characters; above 6000 the index is
// a body leaking through. Under 40 it is a fragment ("Lettre", "in volume 57,
// e8.") that would read as an abstract and unlock what a real one unlocks.
const MAX_ABSTRACT_LENGTH = 6000;
const MIN_ABSTRACT_LENGTH = 40;

// Working papers often open with their funding note, thanks or disclaimer, and
// an index can hold that and nothing else: NBER's w35910 (W7222919853) had
// "Semyon Malamud gratefully acknowledges the financial" as its abstract
// (ENG-105). Text that opens this way is front matter, not an abstract.
// A footnote marker ahead of it (`*`, `1`) is not part of the opening. "Supported
// by" or "funded by" counts whoever the funder is (NIH, Wellcome Trust, a
// ministry), except before data or evidence, so a study "supported by data
// from" a survey stays an abstract.
const FOOTNOTE_MARKER = /^(?:[*†‡§]+|\d{1,2}(?=\s))\s*/;
const FRONT_MATTER_OPENINGS = [
  /^(?:acknowledge?ments?|funding(?: information| statement)?|disclaimer)\s*(?:[:.–—]|-(?=\s))/i,
  /^acknowledge?ments?\s+(?:we|i|the|this|thanks?|financial|funding|support)\b/i,
  /^(?:\S+\s+){0,12}gratefully acknowledg(?:es?|ed)\b/i,
  /^(?:we|i|the authors?)\s+(?:\w+ly\s+)?acknowledges?\s+(?:the\s+)?(?:financial|funding|support|generous|grant)/i,
  /^(?:we|i|the authors?)\s+(?:would like to\s+|wish to\s+)?(?:thanks?|(?:are|am|is)\s+(?:very\s+)?grateful)\b/i,
  /^(?:this|the)\s+(?:work|research|project|study|paper)\s+(?:was|is|has been)\s+(?:\w+ly\s+)?(?:supported|funded)\s+by\s+(?!(?:(?:the|a|an|new)\s+)?(?:data|evidence|findings|results|experiments?|simulations?|observations|records|surveys?)\b)/i,
  /^this\s+material\s+is\s+based\s+(?:up)?on\s+work\s+(?:\w+ly\s+)?supported\s+by\b/i,
  /^the views expressed (?:herein|here|in this)/i,
];

/** Whether `text` opens as front matter: a funding note, thanks or a disclaimer. */
export function opensAsFrontMatter(text: unknown) {
  if (typeof text !== 'string') return false;
  const opening = text.trim().replace(FOOTNOTE_MARKER, '');
  return FRONT_MATTER_OPENINGS.some(pattern => pattern.test(opening));
}

/** Whether a work of `type` has an abstract; a work of unknown type may. */
export function typeHasAbstract(type: unknown) {
  return !TYPES_WITHOUT_ABSTRACT.has(String(type || '').toLowerCase());
}

/**
 * Whether `text`, from any source, can be the abstract of a work of `type`:
 * its length is that of an abstract, it does not open as front matter (a
 * funding note, thanks or a disclaimer), and the type, when known, has one.
 */
export function isPlausibleAbstract(text: unknown, type?: unknown) {
  return typeof text === 'string'
    && text.length >= MIN_ABSTRACT_LENGTH && text.length <= MAX_ABSTRACT_LENGTH
    && !opensAsFrontMatter(text)
    && typeHasAbstract(type);
}

/**
 * The abstract a mapper may show for an OpenAlex work: the rebuilt text, or an
 * empty string when the work type has none or the text cannot be one. An
 * empty answer means "missing", which every caller already renders as such.
 */
export function usableOpenAlexAbstract(work: Pick<OpenAlexWork, 'type' | 'abstract_inverted_index'> | null | undefined) {
  if (!work || !typeHasAbstract(work.type)) return '';
  const text = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  return isPlausibleAbstract(text) ? text : '';
}
