import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAbortFeedLoad } from './feedLoadGuard.ts';

test('does not abort when any pool still has papers, even with failed sources', () => {
  const sourceResults = [{ status: 'timed_out' }, { status: 'rejected' }];
  assert.equal(shouldAbortFeedLoad(sourceResults, [], [{ id: 'graph-1' }]), false);
});

test('does not abort when the main sources produced papers', () => {
  const sourceResults = [{ status: 'fulfilled' }, { status: 'timed_out' }];
  assert.equal(shouldAbortFeedLoad(sourceResults, [{ id: 'a' }], []), false);
});

test('aborts when everything is empty and at least one source failed', () => {
  const sourceResults = [{ status: 'fulfilled' }, { status: 'timed_out' }];
  assert.equal(shouldAbortFeedLoad(sourceResults, [], []), true);
});

test('does not abort when everything is empty but all sources genuinely fulfilled', () => {
  // Every source answered with zero papers: an empty result, not a failure.
  const sourceResults = [{ status: 'fulfilled' }, { status: 'fulfilled' }];
  assert.equal(shouldAbortFeedLoad(sourceResults, [], []), false);
});

test('handles missing pools and malformed results defensively', () => {
  assert.equal(shouldAbortFeedLoad([{ status: 'rejected' }], undefined, null), true);
  assert.equal(shouldAbortFeedLoad([], [], []), false);
});
