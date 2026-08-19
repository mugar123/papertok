import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingIdRequests, requestMissingRecords } from './pendingIdRequests.js';

/**
 * A stand-in for `fetchLibraryRecords` whose responses are held open, so a test
 * can decide what arrives before what — which is the whole subject here.
 */
function deferredFetch(records = {}) {
  const calls = [];
  const fetchRecords = ids => new Promise((resolve, reject) => {
    calls.push({
      ids,
      deliver: () => resolve(ids.filter(id => records[id]).map(id => ({ id, data: records[id] }))),
      fail: error => reject(error || new Error('read denied')),
    });
  });
  return { fetchRecords, calls };
}

/**
 * The liked tab, reduced to what this bug is about: a title map, a set of ids
 * that want titles, and the round that fills them in.
 */
function likedTab(fetchRecords, requests) {
  const titles = {};
  return {
    titles,
    titleOf: id => titles[id] || 'Untitled paper',
    async open(ids) {
      const outcome = await requestMissingRecords({ ids, requests, fetchRecords });
      outcome.records.forEach(({ id, data }) => { titles[id] = data.paperTitle; });
      return outcome;
    },
  };
}

const IDS = ['arxiv:2401.00001', 'arxiv:2401.00002'];
const RECORDS = {
  'arxiv:2401.00001': { paperTitle: 'Attention Is All You Need' },
  'arxiv:2401.00002': { paperTitle: 'Deep Residual Learning' },
};

test('an id is not asked for twice while its read is in flight', () => {
  const requests = createPendingIdRequests();
  assert.deepEqual(requests.claim(IDS), IDS);
  assert.deepEqual(requests.claim(IDS), [], 'a re-render must not re-issue the same read');
});

test('a claim is provisional: only an arrived response settles an id', () => {
  const requests = createPendingIdRequests();
  requests.claim(IDS);
  assert.equal(requests.isSettled(IDS[0]), false, 'claimed is not answered');
  requests.fulfill(IDS);
  assert.equal(requests.isSettled(IDS[0]), true);
  assert.deepEqual(requests.claim(IDS), [], 'an answered id is never asked again');
});

test('a released claim becomes askable again', () => {
  const requests = createPendingIdRequests();
  requests.claim(IDS);
  assert.equal(requests.release(IDS), 2, 'release reports the ids that became askable');
  assert.deepEqual(requests.claim(IDS), IDS);
});

test('an arrived response is authoritative for ids it has no record for', async () => {
  const { fetchRecords, calls } = deferredFetch({ [IDS[0]]: RECORDS[IDS[0]] });
  const requests = createPendingIdRequests();
  const tab = likedTab(fetchRecords, requests);

  const round = tab.open(IDS);
  calls[0].deliver();
  await round;

  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need');
  assert.equal(tab.titleOf(IDS[1]), 'Untitled paper', 'no record means no title to show');
  assert.deepEqual(requests.claim(IDS), [], 'a known blank is not re-read on every render');
});

// The reported bug, start to finish.
test('titles cancelled before they arrive come back on the next visit', async () => {
  const { fetchRecords, calls } = deferredFetch(RECORDS);
  const requests = createPendingIdRequests();
  const first = likedTab(fetchRecords, requests);

  // Enter the profile, open Liked: the titles are asked for...
  const abandoned = first.open(IDS);
  assert.deepEqual(calls[0].ids, IDS);

  // ...and the visit ends before a single one arrives. Nothing settled, so the
  // claim goes back to the pool the way an abandoned read has to.
  assert.equal(requests.release(IDS), 2);
  calls[0].fail();
  await abandoned;

  // Come back in without reloading. The ids are asked for again — under the old
  // bookkeeping this second round found them already marked and asked for
  // nothing, which is what left every row on "Untitled paper" for good.
  const second = likedTab(fetchRecords, requests);
  const round = second.open(IDS);
  assert.equal(calls.length, 2, 'the second visit must actually re-issue the read');
  assert.deepEqual(calls[1].ids, IDS);

  calls[1].deliver();
  await round;

  assert.equal(second.titleOf(IDS[0]), 'Attention Is All You Need');
  assert.equal(second.titleOf(IDS[1]), 'Deep Residual Learning');
});

test('a failed read reports itself as retryable, and the retry lands', async () => {
  const { fetchRecords, calls } = deferredFetch(RECORDS);
  const requests = createPendingIdRequests();
  const tab = likedTab(fetchRecords, requests);

  const failed = tab.open(IDS);
  calls[0].fail();
  const outcome = await failed;
  assert.equal(outcome.retryable, true, 'the caller needs this to schedule the re-render');
  assert.equal(tab.titleOf(IDS[0]), 'Untitled paper');

  const retried = tab.open(IDS);
  calls[1].deliver();
  await retried;
  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need');
});

test('a read that keeps failing settles instead of looping forever', async () => {
  const { fetchRecords, calls } = deferredFetch(RECORDS);
  const requests = createPendingIdRequests({ maxAttempts: 3 });
  const tab = likedTab(fetchRecords, requests);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const round = tab.open(IDS);
    calls[attempt].fail();
    assert.equal((await round).retryable, true, `attempt ${attempt + 1} is still worth retrying`);
  }

  const last = tab.open(IDS);
  calls[2].fail();
  assert.equal((await last).retryable, false, 'the third failure stops asking');
  assert.deepEqual(requests.claim(IDS), [], 'and the ids stay settled');
  assert.equal(calls.length, 3, 'exactly maxAttempts reads, not an unbounded loop');
});
