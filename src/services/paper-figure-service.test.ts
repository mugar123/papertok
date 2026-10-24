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
import { normalizeArxivFigureId, peekPaperFigures } from './paper-figure-service.ts';
import { isArxivFigureId } from '../../worker/paper-figures.ts';

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
 * front door in a test. What is checked here: it must never invent figures
 * for a paper nobody has fetched, and it must answer without a turn of the
 * event loop.
 */
test('peekPaperFigures answers null for anything the cache has not seen', () => {
  assert.equal(peekPaperFigures({ arxivId: '2401.12345' }), null);
  assert.equal(peekPaperFigures({ title: 'a paper with no arXiv id' }), null);
  assert.equal(peekPaperFigures(null), null);
  assert.equal(peekPaperFigures(undefined), null);
});

test('peekPaperFigures answers in the same tick, not in a promise', () => {
  const answer = peekPaperFigures({ arxivId: '2401.12345' });
  assert.notEqual(typeof (answer as { then?: unknown } | null)?.then, 'function', 'a thenable would put the answer a frame away');
});
