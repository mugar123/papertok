import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck } from './deck.js';

/**
 * createDeck's own contract, no DOM involved — the driver in motion.js
 * (armDeck) owns the transition, the keys and the focus; this only tests the
 * index arithmetic and what Skip/the counter should do with it.
 *
 * Decision (B) overrides the brief: next() and prev() BOTH return
 * `{ jumpTo, index }`, not a bare number for next() and an object only for
 * prev(). `jumpTo` is the slide to teleport to before travelling, or null.
 * Forward motion never needs a pre-travel teleport — the reel always has a
 * clone sitting right after the last real paper to travel onto — so
 * next()'s `jumpTo` is always null; only prev() from the first paper needs
 * one, onto the clone, so the travel back to the last paper is a real
 * (short) trip rather than a jump across the whole reel.
 */

test('next walks the three papers and then onto the clone, which is the first again', () => {
  const d = createDeck({ count: 3 });
  assert.deepEqual(
    [d.next(), d.next(), d.next()],
    [
      { jumpTo: null, index: 1 },
      { jumpTo: null, index: 2 },
      { jumpTo: null, index: 3 },
    ],
  );
  assert.equal(d.atClone(), true);
  assert.equal(d.settle(), 0, 'landing on the clone settles to 0 without travel');
  assert.equal(d.index(), 0);
});

test('next while the clone is still travelling does nothing', () => {
  const d = createDeck({ count: 3 });
  d.next(); d.next(); d.next();
  assert.deepEqual(d.next(), { jumpTo: null, index: 3 });
});

test('prev from the first paper goes through the clone to the last', () => {
  const d = createDeck({ count: 3 });
  assert.deepEqual(d.prev(), { jumpTo: 3, index: 2 });
  assert.equal(d.index(), 2);
});

// Not in the brief: the brief's own single prev() test only exercises the
// i===0 branch (the jump). Decision (B)'s claim is that BOTH functions
// share one return shape — that claim is only actually tested if the other
// branch (an ordinary backward step, no jump) is checked too.
test('prev from any other paper just travels back one, no jump', () => {
  const d = createDeck({ count: 3 });
  d.next(); // index 1
  assert.deepEqual(d.prev(), { jumpTo: null, index: 0 });
});

test('the counter never says 4 of 3', () => {
  const d = createDeck({ count: 3 });
  d.next(); d.next(); d.next();
  assert.equal(d.label(), '1 / 3');
});
