/**
 * The client-side figure gate, pinned where it can silently withhold work the
 * Worker is already doing.
 *
 * `normalizeArxivFigureId` decides whether the browser asks for figures at all.
 * If it is stricter than the Worker's `isArxivFigureId`, the extra strictness is
 * invisible: no error, no log, just papers that never show a figure. That is
 * exactly what happened to the pre-2007 catalogue — the very corpus the second
 * renderer (ar5iv) was added to cover.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeArxivFigureId, canHaveFigures } from './paperFigureService.js';
import { isArxivFigureId } from '../../worker/paper-figures.js';

const IDS = [
  // Modern, since April 2007.
  '2401.12345',
  '0704.0001',
  '2401.1234',
  // The back catalogue, with and without a subclass.
  'math/0309136',
  'cond-mat/0102536',
  'cond-mat.stat-mech/0102536',
  'physics.flu-dyn/0512001',
  // Shapes that must never reach a renderer URL.
  'math/../../etc/passwd',
  'math//0309136',
  'a/b/0309136',
  'math/0309136?x=1',
  'math@evil/0309136',
  'math/030913',
  'math/03091366',
  '24011.2345',
  '',
  'not-an-id',
];

test('the client gate agrees with the Worker on every identifier shape', () => {
  for (const id of IDS) {
    assert.equal(
      Boolean(normalizeArxivFigureId({ arxivId: id })),
      isArxivFigureId(id),
      `client and Worker disagree on ${JSON.stringify(id)}`,
    );
  }
});

test('the version suffix and the arxiv: prefix are stripped before matching', () => {
  assert.equal(normalizeArxivFigureId({ arxivId: 'arXiv:2401.12345v3' }), '2401.12345');
  assert.equal(normalizeArxivFigureId({ arxivId: 'math/0309136v2' }), 'math/0309136');
  assert.equal(normalizeArxivFigureId({ arxivId: '  2401.12345  ' }), '2401.12345');
});

test('a paper without an arXiv identifier asks for nothing', () => {
  assert.equal(canHaveFigures({}), false);
  assert.equal(canHaveFigures({ arxivId: null }), false);
  assert.equal(canHaveFigures(undefined), false);
  assert.equal(canHaveFigures({ arxivId: 'math/0309136' }), true);
});

/**
 * The agreement test above compares behaviour, which is what matters. This one
 * compares the source text, so that a future edit to either file that keeps the
 * sampled identifiers passing but changes the accepted language still shows up.
 */
test('both files spell the same two patterns', async () => {
  const [client, worker] = await Promise.all([
    readFile(new URL('./paperFigureService.js', import.meta.url), 'utf8'),
    readFile(new URL('../../worker/paper-figures.js', import.meta.url), 'utf8'),
  ]);
  const patterns = (source) => (source.match(/\/\^[^\n]*?\$\//g) || [])
    .map(value => value.trim())
    .sort();

  const clientPatterns = patterns(client);
  assert.equal(clientPatterns.length, 2, 'the client declares exactly the two shapes');
  for (const pattern of clientPatterns) {
    assert.ok(
      worker.includes(pattern),
      `the Worker no longer spells ${pattern}; the two gates have diverged`,
    );
  }
});
