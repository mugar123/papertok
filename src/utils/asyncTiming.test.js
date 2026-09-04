import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWithin, settleWithin, settleSourcesForFirstPaint, fulfilledPaperLists } from './asyncTiming.js';

test('returns a fast result without waiting for the full budget', async () => {
  assert.deepEqual(await settleWithin(Promise.resolve(['paper']), 50), {
    status: 'fulfilled',
    value: ['paper'],
  });
});

test('falls back when a source exceeds its rendering budget', async () => {
  const result = await settleWithin(new Promise(() => {}), 5);
  assert.equal(result.status, 'timed_out');
  assert.deepEqual(await resolveWithin(new Promise(() => {}), 5, []), []);
});

test('contains a rejected optional source', async () => {
  const error = new Error('unavailable');
  const result = await settleWithin(Promise.reject(error), 50);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, error);
});

test('paints when the first source already has enough papers', async () => {
  let slowStarted = false;
  const slow = new Promise((resolve) => {
    slowStarted = true;
    setTimeout(() => resolve([{ id: 'late' }]), 80);
  });
  const { first, all } = settleSourcesForFirstPaint(
    [Promise.resolve([{ id: 'fast-1' }, { id: 'fast-2' }]), slow],
    200,
    (papers) => papers.length >= 2,
  );
  const early = await first;
  assert.equal(slowStarted, true);
  assert.deepEqual(fulfilledPaperLists(early).map((paper) => paper.id), ['fast-1', 'fast-2']);
  const late = await all;
  assert.deepEqual(fulfilledPaperLists(late).map((paper) => paper.id), ['fast-1', 'fast-2', 'late']);
});
