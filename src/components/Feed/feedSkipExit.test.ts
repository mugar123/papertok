import test from 'node:test';
import assert from 'node:assert/strict';
import { skipExitSlot, SKIP_EXIT_MS } from '../../utils/feedSkipExit.ts';

/**
 * Every snap item is exactly one container tall (`height: 100%` plus
 * `contain-intrinsic-size: 0 100%`), so the slot a card occupies is its index
 * times that height — no DOM read, and no id escaping for the paper ids that
 * carry slashes and colons.
 */
test('the slot a leaving card occupies is its index times the card height', () => {
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(skipExitSlot({ papers, paperId: 'a', cardHeight: 700 }), { id: 'a', top: 0, height: 700 });
  assert.deepEqual(skipExitSlot({ papers, paperId: 'c', cardHeight: 700 }), { id: 'c', top: 1400, height: 700 });
});

/**
 * Null means "there is nothing to animate": the caller removes the card
 * straight away, exactly as it did before this existed. A skip must never be
 * swallowed because the geometry could not be worked out.
 */
test('a slot that cannot be worked out is null, not a guess', () => {
  const papers = [{ id: 'a' }, { id: 'b' }];
  assert.equal(skipExitSlot({ papers, paperId: 'zzz', cardHeight: 700 }), null, 'an id that is not in the list');
  assert.equal(skipExitSlot({ papers, paperId: '', cardHeight: 700 }), null);
  assert.equal(skipExitSlot({ papers, paperId: null, cardHeight: 700 }), null);
  assert.equal(skipExitSlot({ papers, paperId: 'a', cardHeight: 0 }), null, 'a container that has not been measured');
  assert.equal(skipExitSlot({ papers, paperId: 'a', cardHeight: NaN }), null);
  assert.equal(skipExitSlot({ papers: null!, paperId: 'a', cardHeight: 700 }), null);
});

test('the exit is short enough to stay out of the way', () => {
  assert.ok(SKIP_EXIT_MS > 0 && SKIP_EXIT_MS <= 300,
    'a UI exit over 300ms reads as sluggish; this one has no reason to be long');
});
