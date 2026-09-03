import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitUpstreamSlot } from './upstream-pace.js';

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
