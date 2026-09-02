import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE tests. Most rows on the Liked tab could not be clicked: a like was
 * remembered under the feed's provider id (`openalex:W…`, a Semantic Scholar
 * hash) with no DOI beside it, the public paper key knew only DOI and arXiv,
 * so `getPublicPaperPath` answered null and the row rendered as a static div.
 * Every titled row must now be a link — to the paper page when the paper has
 * an address there, to a title search otherwise.
 */
test('SOURCE: a row with a title but no paper-page address links to a title search', async () => {
  const code = stripComments(await read('./PublicProfilePage.jsx'));
  const start = code.indexOf('function rowDestination(');
  const body = code.slice(start, code.indexOf('function seedPaperFor(', start));
  assert.ok(body.length > 0, 'expected to have found rowDestination');
  assert.match(body, /getPublicPaperPath\(paper\) \|\| getPublicPaperPath\(id\)/,
    'the paper page first, from the copy in memory or from the id');
  assert.match(body, /searchPaperDestination\(\{ title \}, title\)/,
    'then the search page carrying the title — the palette\'s own fallback');
  assert.match(body, /if \(!title\) return \{ path: null/,
    'only a row with no title at all stays unlinked, and that row is a skeleton anyway');
});

test('SOURCE: both the Liked and the Saved rows go through rowDestination', async () => {
  const code = stripComments(await read('./PublicProfilePage.jsx'));
  const uses = code.match(/\.\.\.rowDestination\(/g) || [];
  assert.equal(uses.length, 2, `expected the two row builders to use it, found ${uses.length}`);
  assert.doesNotMatch(code, /path: paper \? getPublicPaperPath\(paper\)/,
    'no row builder computes its own path anymore');
});

test('SOURCE: the lists page opens a paper with no address through the same search fallback', async () => {
  const code = stripComments(await read('../Lists/ListsPage.jsx'));
  const start = code.indexOf('const openPaperCard = (paper) => {');
  const body = code.slice(start, code.indexOf('};', start));
  assert.match(body, /searchPaperDestination\(paper\)/);
  assert.doesNotMatch(body, /arxivId: paper\.arxivId \|\| paper\.id/,
    'the raw id is never dressed up as an arXiv id for the PDF viewer again');
});
