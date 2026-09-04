import test from 'node:test';
import assert from 'node:assert/strict';
import { RERANK_LOOKAHEAD, splitFeedForReRank } from './feedReRankSplit.js';

const papers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const ids = (list) => list.map(paper => paper.id);

test('without an anchor the split is at the top, three cards deep, as before', () => {
  const { anchorIndex, locked, queue } = splitFeedForReRank(papers(10));
  assert.equal(RERANK_LOOKAHEAD, 3);
  assert.equal(anchorIndex, 0);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2']);
  assert.deepEqual(ids(queue), ['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
});

test('the resumed card stays locked: a reader at index 5 keeps 0..7 in place', () => {
  const list = papers(10);
  const { anchorIndex, locked, queue } = splitFeedForReRank(list, { anchorPaperIds: ['p5'] });
  assert.equal(anchorIndex, 5);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  assert.deepEqual(ids(queue), ['p8', 'p9']);
  assert.ok(locked.includes(list[5]), 'the card under the viewport is never in the shuffled queue');
});

test('with several anchors the deepest one wins', () => {
  const { anchorIndex } = splitFeedForReRank(papers(10), { anchorPaperIds: ['p2', 'p6', 'p4'] });
  assert.equal(anchorIndex, 6);
  const reversed = splitFeedForReRank(papers(10), { anchorPaperIds: ['p6', 'p2'] });
  assert.equal(reversed.anchorIndex, 6, 'order of the anchors does not matter');
});

test('anchors that are not in the list, null or undefined are ignored', () => {
  const { anchorIndex, locked } = splitFeedForReRank(papers(10), { anchorPaperIds: [null, undefined, 'nope', 'p1'] });
  assert.equal(anchorIndex, 1);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2', 'p3']);
});

test('anchorPaperIds itself can be an explicit null, not just contain one', () => {
  // The destructuring default (`= []`) only covers undefined; a caller that
  // passes null explicitly must not throw either.
  const { anchorIndex } = splitFeedForReRank(papers(10), { anchorPaperIds: null });
  assert.equal(anchorIndex, 0);
});

test('an anchor near the end locks everything and leaves an empty queue', () => {
  const { locked, queue } = splitFeedForReRank(papers(5), { anchorPaperIds: ['p4'] });
  assert.equal(locked.length, 5);
  assert.deepEqual(queue, []);
});

test('a short or empty list never throws', () => {
  assert.deepEqual(splitFeedForReRank([], { anchorPaperIds: ['p0'] }), { anchorIndex: 0, locked: [], queue: [] });
  assert.deepEqual(splitFeedForReRank(undefined), { anchorIndex: 0, locked: [], queue: [] });
  const one = splitFeedForReRank(papers(1));
  assert.deepEqual(ids(one.locked), ['p0']);
  assert.deepEqual(one.queue, []);
});

test('the lookahead is configurable', () => {
  const { locked } = splitFeedForReRank(papers(10), { anchorPaperIds: ['p2'], lookahead: 1 });
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2']);
});
