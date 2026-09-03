import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitUpstreamSlot } from './upstream-pace.js';

// A ledger that answers each `reserve` from a script, and remembers what it was
// asked. Subjects reach the real ledger hashed, so the fake records the order
// of calls rather than their names; the period key is visible as-is.
function scriptedLedger(answers, seen) {
  let call = 0;
  return {
    idFromName: name => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: () => ({
      fetch: async () => {
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
