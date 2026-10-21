import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWithin, settleWithin, settleSourcesForFirstPaint, fulfilledPaperLists } from './asyncTiming.ts';

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
  const slow = new Promise<{ id: string }[]>((resolve) => {
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

test('a source that answers after the first-paint budget still reaches `all`', async () => {
  const late = new Promise<{ id: string }[]>((resolve) => setTimeout(() => resolve([{ id: 'late' }]), 60));
  const { first, all } = settleSourcesForFirstPaint([late], 20, () => false, { allTimeoutMs: 500 });
  const early = await first;
  assert.equal(early[0].status, 'timed_out');
  const settled = await all;
  assert.equal(settled[0].status, 'fulfilled');
  assert.deepEqual(fulfilledPaperLists(settled).map((paper) => paper.id), ['late']);
});

test('`all` still has a ceiling of its own', async () => {
  const never = new Promise<{ id: string }[]>(() => {});
  const { all } = settleSourcesForFirstPaint([never], 5, () => false, { allTimeoutMs: 30 });
  const settled = await all;
  assert.equal(settled[0].status, 'timed_out');
});

// Plan G (PAP-73): a source answering a whole page first used to make the first
// paint on its own. With a ready limit it counts only that many papers toward
// `isReady`, so the paint waits for another source, and still gets every paper.
test('a source counts toward the first paint only up to its ready limit', async () => {
  const wholePage = Promise.resolve([{ id: 'topic-1' }, { id: 'topic-2' }, { id: 'topic-3' }]);
  const later = new Promise<{ id: string }[]>((resolve) => setTimeout(() => resolve([{ id: 'pubmed-1' }]), 30));
  const { first } = settleSourcesForFirstPaint(
    [wholePage, later],
    500,
    (papers) => papers.length >= 3,
    { readyLimits: new Map([[wholePage, 2]]) },
  );
  assert.deepEqual(fulfilledPaperLists(await first).map((paper) => paper.id), ['topic-1', 'topic-2', 'topic-3', 'pubmed-1']);
});
