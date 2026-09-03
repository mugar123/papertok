import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitUpstreamSlot, DEFAULT_MAX_WAIT_MS, PACE_RETRY_AFTER_SECONDS } from './upstream-pace.js';

// A ledger that answers each `reserve` from a script, and remembers what it was
// asked: the period key as-is, and the hashed subjectKey plus subjectLimit read
// from each reservation body. Hashing hides which second a call was for, but
// not whether two calls asked for the same one -- distinctness is what a
// per-second subject actually depends on, so that survives the hash and is
// what the fake records.
function scriptedLedger(answers, seen) {
  let call = 0;
  return {
    idFromName: name => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: () => ({
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        seen.reservations ??= [];
        seen.reservations.push({ subjectKey: body.subjectKey, subjectLimit: body.subjectLimit });
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        seen.calls = call;
        return new Response(JSON.stringify(answer));
      },
    }),
  };
}

// The clock is pinned at the start of second 10, so the first slot asked for is
// second 10 itself, the next is 11, and the wait for 11 is exactly a second.
const AT_SECOND_TEN = () => 10_000;

test('sends at once when the current second is free', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(scriptedLedger([{ accepted: true }], seen), {
    namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, second: 10, waitedMs: 0 });
  assert.deepEqual(slept, []);
  assert.deepEqual(seen.periodKeys, ['s2:pace']);
});

test('takes the next second and waits for it when the current one is taken', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }, { accepted: true }], seen),
    { namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, second: 11, waitedMs: 1000 });
  assert.deepEqual(slept, [1000]);
  assert.equal(seen.calls, 2);
  // The hash itself proves nothing, but the two calls must not collide on one
  // subject -- a constant subject would let the first request ever asked lock
  // out every later one until the ledger's own retention alarm clears it days
  // later. And the limit has to be one: a subject that admits sixty is the
  // defect this module exists to remove, reinstated one call away.
  const [first, second] = seen.reservations;
  assert.notEqual(first.subjectKey, second.subjectKey, 'each second must reserve a different subject');
  assert.equal(first.subjectLimit, 1);
  assert.equal(second.subjectLimit, 1);
});

test('gives up within the wait budget instead of queueing forever', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }], seen),
    { namespace: 's2', maxWaitMs: 2_500, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: false });
  // Seconds 10, 11 and 12 are within 2.5 s of the start; 13 is not.
  assert.equal(seen.calls, 3);
  assert.deepEqual(slept, [], 'a refusal must not cost the caller any waiting');
});

test('relays a ledger that is not there instead of treating it as a full second', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' }], seen),
    { namespace: 's2', now: AT_SECOND_TEN, sleep: async () => {} },
  );

  assert.deepEqual(slot, { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' });
  assert.equal(seen.calls, 1);
});

// Every test above pins `now` to the constant `AT_SECOND_TEN`, so none of them
// would notice a regression in the wait arithmetic itself -- the only part of
// this module that reads the clock more than once per call. This ledger
// instead advances a shared clock by a scripted amount on each round trip, the
// way a real Durable Object fetch costs real time, so the test below can
// reproduce what a slow round trip actually does to that arithmetic.
function advancingLedger(answers, roundTripsMs, clock, seen) {
  let call = 0;
  return {
    idFromName: name => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: () => ({
      fetch: async (_url, options) => {
        clock.value += roundTripsMs[Math.min(call, roundTripsMs.length - 1)];
        const body = JSON.parse(options.body);
        seen.reservations ??= [];
        seen.reservations.push({ subjectKey: body.subjectKey, subjectLimit: body.subjectLimit });
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        seen.calls = call;
        return new Response(JSON.stringify(answer));
      },
    }),
  };
}

test('a reservation confirmed after its second has closed is not spent -- the caller retries for the second that is actually current', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const clock = { value: 10_000 }; // same baseline as AT_SECOND_TEN, but this one moves
  // Second 10 is refused fast (200 ms round trip). Second 11 is accepted, but
  // that round trip alone takes 2 s, landing the clock at 12 200 -- already
  // inside second 12, not second 11. Probed against the pre-fix module with
  // exactly this shape: the old arithmetic returned `{ second: 11, waitedMs: 0
  // }` right there, and the caller would have sent inside a second it never
  // held. A third, fast (100 ms) round trip for second 12 then confirms it
  // while the clock is still inside second 12 -- the correct, non-stale slot.
  const roundTripsMs = [200, 2000, 100];
  const answers = [{ accepted: false, scope: 'user' }, { accepted: true }, { accepted: true }];
  const slept = [];

  const slot = await awaitUpstreamSlot(advancingLedger(answers, roundTripsMs, clock, seen), {
    namespace: 's2', now: () => clock.value, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, second: 12, waitedMs: 0 });
  assert.equal(seen.calls, 3, 'the stale accept of second 11 must cost a retry, not be spent as a send');
  assert.deepEqual(slept, [], 'the clock had already passed both seconds it tried by the time each was confirmed');
});

// The header a refused caller receives has to cover the whole window the beat
// just searched: telling it to come back sooner than that is telling it to
// come back before the search that just failed would even have finished.
test('tells a refused caller to come back no sooner than the wait budget it just exhausted', () => {
  assert.match(PACE_RETRY_AFTER_SECONDS, /^\d+$/, 'retry-after is whole seconds');
  assert.ok(Number(PACE_RETRY_AFTER_SECONDS) * 1000 >= DEFAULT_MAX_WAIT_MS,
    `${PACE_RETRY_AFTER_SECONDS}s does not cover a ${DEFAULT_MAX_WAIT_MS}ms window`);
});
