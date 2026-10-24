import test from 'node:test';
import assert from 'node:assert/strict';
import { RERANK_MAX_WAIT_MS, RERANK_SCROLL_QUIET_MS, reRankHoldMs } from './feedReRankTiming.ts';

test('a feed that has not moved for the quiet window is re-ranked at once', () => {
  assert.equal(reRankHoldMs({ now: 10_000, scrolledAt: 10_000 - RERANK_SCROLL_QUIET_MS, requestedAt: 9_900 }), 0);
  assert.equal(reRankHoldMs({ now: 10_000, scrolledAt: 0, requestedAt: 10_000 }), 0, 'a feed that never scrolled');
  assert.equal(reRankHoldMs({ now: 10_000 }), 0, 'no scroll report at all');
});

test('a re-rank asked for mid-snap is held until the scroll has been quiet', () => {
  // The card left at t=0 and armed the re-rank; the snap keeps reporting
  // scroll events until ~t=450. Asked at t=400 with the last report at
  // t=390, it waits out the rest of the quiet window, not a fixed delay.
  assert.equal(reRankHoldMs({ now: 400, scrolledAt: 390, requestedAt: 0 }), RERANK_SCROLL_QUIET_MS - 10);
  assert.equal(reRankHoldMs({ now: 400, scrolledAt: 400, requestedAt: 0 }), RERANK_SCROLL_QUIET_MS);
});

test('a reader who never pauses still gets the re-rank, at the deadline', () => {
  const requestedAt = 1_000;
  const now = requestedAt + RERANK_MAX_WAIT_MS;
  assert.equal(reRankHoldMs({ now, scrolledAt: now, requestedAt }), 0, 'scrolling this very instant, and still released');
  assert.ok(reRankHoldMs({ now: now - 1, scrolledAt: now - 1, requestedAt }) > 0, 'one millisecond earlier it is still held');
});

test('the quiet window outlasts a snap and the deadline stays a few cards long', () => {
  assert.ok(RERANK_SCROLL_QUIET_MS >= 400 && RERANK_SCROLL_QUIET_MS <= 800, `${RERANK_SCROLL_QUIET_MS}ms covers a ~300-500ms snap with a beat to spare`);
  assert.ok(RERANK_MAX_WAIT_MS >= 3_000 && RERANK_MAX_WAIT_MS <= 8_000, `${RERANK_MAX_WAIT_MS}ms bounds the wait for a reader who keeps flicking`);
});
