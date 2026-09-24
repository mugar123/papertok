/**
 * OpenAlex ships abstracts as an inverted index — `{ word: [positions] }` —
 * rather than as text, which is how abstract content stays inside the open
 * corpus at all. Rebuilding it was written out by hand in four places: the
 * OpenAlex adapter, the OpenAlex service, the scientific report, and the PubMed
 * adapter's own OpenAlex call. The copies had already drifted — one sorted pairs
 * and skipped the whitespace pass the others did — which is the same shape as
 * the `openalex:` filter that diverged and spent years answering 400.
 *
 * Returns the text, or an empty string when there is nothing to rebuild. The
 * caller supplies its own placeholder, because they differ by locale.
 */
export function reconstructOpenAlexAbstract(invertedIndex) {
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

/**
 * The abstract a mapper may show for an OpenAlex work: the rebuilt text, or an
 * empty string when the work type has none or the text cannot be one. An
 * empty answer means "missing", which every caller already renders as such.
 */
export function usableOpenAlexAbstract(work) {
  if (!work || TYPES_WITHOUT_ABSTRACT.has(String(work.type || '').toLowerCase())) return '';
  const text = reconstructOpenAlexAbstract(work.abstract_inverted_index);
  if (text.length < MIN_ABSTRACT_LENGTH || text.length > MAX_ABSTRACT_LENGTH) return '';
  return text;
}
