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
import { normalizeArxivFigureId, canHaveFigures, peekPaperFigures } from './paperFigureService.js';
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

/**
 * `peekPaperFigures` is what lets a card be born with the clippings it already
 * has. The feed's own measurement (2026-09-11, production build, real session)
 * is the reason it exists: coming back from Research the four figures were in
 * `figureCache` with their bytes already in the browser, and the card still
 * showed an empty margin for 53ms after the page had stopped moving, because
 * the only door into the cache was an async one behind a 240ms settle timer.
 *
 * `getPaperFigures` cannot be called from here — it reads
 * `import.meta.env.VITE_PAPER_API_BASE_URL`, which Vite substitutes at build
 * time and Node leaves undefined — so the cache cannot be filled through the
 * front door in a test. What IS checked behaviourally is the half that matters
 * for correctness: it must never invent figures for a paper nobody has fetched,
 * and it must answer without a turn of the event loop. The source assertion
 * below covers the other half, and is mutation-checked: point it at
 * `pendingRequests` or give it an `await` and it fails.
 */
test('peekPaperFigures answers null for anything the cache has not seen', () => {
  assert.equal(peekPaperFigures({ arxivId: '2401.12345' }), null);
  assert.equal(peekPaperFigures({ title: 'a paper with no arXiv id' }), null);
  assert.equal(peekPaperFigures(null), null);
  assert.equal(peekPaperFigures(undefined), null);
});

test('peekPaperFigures answers in the same tick, not in a promise', () => {
  const answer = peekPaperFigures({ arxivId: '2401.12345' });
  assert.notEqual(typeof answer?.then, 'function', 'a thenable would put the answer a frame away');
});

test('peekPaperFigures reads the same cache getPaperFigures writes, with no waiting', async () => {
  const source = await readFile(new URL('./paperFigureService.js', import.meta.url), 'utf8');
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = stripped.indexOf('export function peekPaperFigures');
  assert.notEqual(start, -1, 'peekPaperFigures is exported as a plain function');
  const end = stripped.indexOf('\n}', start);
  const body = stripped.slice(start, end);

  assert.match(body, /figureCache\.has\(/, 'it asks the cache getPaperFigures writes');
  assert.match(body, /figureCache\.get\(/, 'it returns what that cache holds');
  assert.doesNotMatch(body, /pendingRequests/, 'an in-flight request is not an answer');
  assert.doesNotMatch(body, /\bawait\b|\.then\(/, 'waiting is the whole thing it exists to avoid');
});
