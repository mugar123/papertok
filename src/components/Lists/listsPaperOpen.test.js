import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE test. A paper saved under the feed's provider id (`openalex:W…`, a
 * Semantic Scholar hash) with no DOI beside it has no public paper address,
 * and the lists page still has to open it.
 */
test('SOURCE: the lists page opens a paper with no address as a card from the stored copy', async () => {
  const code = stripComments(await read('./ListsPage.tsx'));
  const start = code.indexOf('const openPaperCard = (paper) => {');
  const body = code.slice(start, code.indexOf('};', start));
  assert.match(body, /const path = getPublicPaperPath\(paper\) \|\| getPublicPaperPath\(paper\.id\)/);
  assert.match(body, /if \(!path\) \{\s*setOverlayPaper\(paper\);\s*return;\s*\}/,
    'no address: the card opens in the overlay, painted from what was saved');
  assert.match(body, /navigate\(path, \{ state: \{ paper, stored: true \} \}\)/, 'an address: the paper page, the stored copy riding along as the fallback');
  assert.doesNotMatch(body, /arxivId: paper\.arxivId \|\| paper\.id/,
    'the raw id is never dressed up as an arXiv id for the PDF viewer again');
  assert.match(code, /<PaperOverlay[\s\S]*?<PaperCard[\s\S]*?paper=\{shownPaper\}/,
    'the overlay hosts the same PaperCard the search page uses -- `shownPaper`, the one\n     that outlives `overlayPaper` so the card does not vanish mid-exit');
});
