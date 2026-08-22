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
