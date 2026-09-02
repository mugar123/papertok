import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingIdRequests, requestMissingRecords } from './pendingIdRequests.js';

/**
 * A stand-in for `fetchLibraryRecords` whose responses are held open, so a test
 * can decide what arrives before what — which is the whole subject here.
 * `deliver()` answers from the server; `deliverFromCache()` answers the way
 * Firestore answers when the backend is unreachable: successfully, from
 * whatever the local cache holds (here: nothing).
 */
function deferredFetch(records = {}) {
  const calls = [];
  const fetchRecords = ids => new Promise((resolve, reject) => {
    calls.push({
      ids,
      deliver: () => resolve({
        fromCache: false,
        records: ids.filter(id => records[id]).map(id => ({ id, data: records[id] })),
      }),
      deliverFromCache: () => resolve({ fromCache: true, records: [] }),
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

test('a claim is provisional: only a fulfilled response settles an id', () => {
  const requests = createPendingIdRequests();
  requests.claim(IDS);
  assert.equal(requests.isSettled(IDS[0]), false, 'claimed is not answered');
  requests.fulfill(IDS);
  assert.equal(requests.isSettled(IDS[0]), true);
  assert.deepEqual(requests.claim(IDS), [], 'an answered id is never asked again');
});

test('a released claim becomes askable again, and attempts accumulate', () => {
  const requests = createPendingIdRequests();
  requests.claim(IDS);
  assert.equal(requests.release(IDS), 2, 'release reports the ids that became askable');
  assert.equal(requests.attemptsFor(IDS), 1);
  assert.deepEqual(requests.claim(IDS), IDS);
  requests.release(IDS);
  assert.equal(requests.attemptsFor(IDS), 2, 'the caller sizes its backoff from this');
});

test('a server-confirmed absence settles: a known blank is not re-read forever', async () => {
  const { fetchRecords, calls } = deferredFetch({ [IDS[0]]: RECORDS[IDS[0]] });
  const requests = createPendingIdRequests();
  const tab = likedTab(fetchRecords, requests);

  const round = tab.open(IDS);
  calls[0].deliver();
  await round;

  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need');
  assert.equal(tab.titleOf(IDS[1]), 'Untitled paper', 'the server said there is no record');
  assert.deepEqual(requests.claim(IDS), [], 'neither id is asked again');
});

// The reported screenshot, mechanism confirmed live: the backend is briefly
// unreachable, getDocs resolves *successfully* against an empty in-memory
// cache, and every row reads "Untitled paper".
test('an empty answer served from cache settles nothing and heals when the server returns', async () => {
  const { fetchRecords, calls } = deferredFetch(RECORDS);
  const requests = createPendingIdRequests();
  const tab = likedTab(fetchRecords, requests);

  // The blip: a successful-looking response with nothing in it.
  const during = tab.open(IDS);
  calls[0].deliverFromCache();
  const outcome = await during;
  assert.equal(tab.titleOf(IDS[0]), 'Untitled paper');
  assert.equal(outcome.retryable, true, 'a cache-served miss must stay retryable');
  assert.equal(outcome.attempt, 1, 'and it counts toward the backoff');
  assert.equal(requests.isSettled(IDS[0]), false, 'nothing was latched as final');

  // The network comes back; the next round asks the server and the titles land
  // without the user reloading or leaving the page.
  const after = tab.open(IDS);
  assert.deepEqual(calls[1].ids, IDS, 'the ids are actually re-asked');
  calls[1].deliver();
  await after;
  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need');
  assert.equal(tab.titleOf(IDS[1]), 'Deep Residual Learning');
});

test('a partial cache answer keeps what it got and re-asks only the rest', async () => {
  const requests = createPendingIdRequests();
  const calls = [];
  const fetchRecords = ids => new Promise(resolve => {
    calls.push({
      ids,
      deliverPartialFromCache: () => resolve({
        fromCache: true,
        records: [{ id: IDS[0], data: RECORDS[IDS[0]] }],
      }),
    });
  });
  const tab = likedTab(fetchRecords, requests);

  const round = tab.open(IDS);
  calls[0].deliverPartialFromCache();
  await round;

  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need', 'cached data is still data');
  assert.equal(requests.isSettled(IDS[0]), true, 'a record in hand settles its id');
  assert.equal(requests.isSettled(IDS[1]), false, 'the miss stays open');
  assert.deepEqual(requests.claim(IDS), [IDS[1]], 'only the miss is re-asked');
});

// The originally reported bug, start to finish.
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

// A rules deploy can deny reads for minutes. A fixed retry budget burned its
// three attempts inside the first two seconds of that and stranded the page;
// failure now never settles — it only stretches the delay.
test('persistent failure keeps retrying with growing attempts and recovers at the end', async () => {
  const { fetchRecords, calls } = deferredFetch(RECORDS);
  const requests = createPendingIdRequests();
  const tab = likedTab(fetchRecords, requests);

  for (let round = 0; round < 5; round += 1) {
    const attempt = tab.open(IDS);
    calls[round].fail();
    const outcome = await attempt;
    assert.equal(outcome.retryable, true, `attempt ${round + 1} must stay retryable`);
    assert.equal(outcome.attempt, round + 1, 'attempts grow so the backoff can stretch');
  }

  // Five failures later the outage ends — and the titles still arrive.
  const healed = tab.open(IDS);
  calls[5].deliver();
  await healed;
  assert.equal(tab.titleOf(IDS[0]), 'Attention Is All You Need');
  assert.equal(tab.titleOf(IDS[1]), 'Deep Residual Learning');
});

// Two sources behind one read: Firestore answered from the server for most
// ids, arXiv failed for the rest. The server-confirmed absences must settle;
// only what the failed source owed stays askable — otherwise every retry of
// the arXiv leg re-issues the Firestore query too, for the life of the page.
test('an answer can settle most ids and leave a named few askable', async () => {
  const requests = createPendingIdRequests();
  const outcome = await requestMissingRecords({
    ids: ['a', 'b', 'legacy/1'],
    requests,
    fetchRecords: async () => ({
      records: [{ id: 'a', data: { paperTitle: 'A' } }],
      fromCache: false,
      authoritative: true,
      unsettled: ['legacy/1'],
    }),
  });
  assert.equal(outcome.retryable, true);
  assert.equal(outcome.attempt, 1);
  assert.equal(requests.isSettled('a'), true, 'a record in hand settles');
  assert.equal(requests.isSettled('b'), true, 'a server-confirmed absence settles');
  assert.equal(requests.isSettled('legacy/1'), false, 'what the failed source owed stays askable');
  assert.equal(requests.isInFlight('legacy/1'), false);
});
