import type { TestNamespace } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuotaReading } from './request-quota-ledger.ts';

interface SeenReservations { periodKeys: string[]; calls: number; reservations?: Array<{ subjectKey: string; subjectLimit: number; partKey?: string }> }
import { awaitUpstreamSlot, DEFAULT_MAX_WAIT_MS, PACE_RETRY_AFTER_SECONDS, paceRetryAfterSeconds } from './upstream-pace.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

// A ledger that answers each `reserve` from a script, and remembers what it was
// asked: the period key as-is, and the hashed subjectKey plus subjectLimit read
// from each reservation body. Hashing hides which second a call was for, but
// not whether two calls asked for the same one -- distinctness is what a
// per-second subject actually depends on, so that survives the hash and is
// what the fake records.
function scriptedLedger(answers: QuotaReading[], seen: SeenReservations) {
  let call = 0;
  return {
    idFromName: (name: string): unknown => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url, options) => {
        const body = JSON.parse(options!.body as string);
        seen.reservations ??= [];
        seen.reservations.push({ subjectKey: body.subjectKey, subjectLimit: body.subjectLimit });
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        seen.calls = call;
        return new Response(JSON.stringify(answer));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
}

// The clock is pinned at the start of second 10, so the first slot asked for is
// second 10 itself, the next is 11, and the wait for 11 is exactly a second.
const AT_SECOND_TEN = () => 10_000;

test('sends at once when the current second is free', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(scriptedLedger([{ accepted: true }], seen), {
    namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, slot: 10, waitedMs: 0 });
  assert.deepEqual(slept, []);
  assert.deepEqual(seen.periodKeys, ['s2:pace']);
});

test('takes the next second and waits for it when the current one is taken', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }, { accepted: true }], seen),
    { namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, slot: 11, waitedMs: 1000 });
  assert.deepEqual(slept, [1000]);
  assert.equal(seen.calls, 2);
  // The hash itself proves nothing, but the two calls must not collide on one
  // subject -- a constant subject would let the first request ever asked lock
  // out every later one until the ledger's own retention alarm clears it days
  // later. And the limit has to be one: a subject that admits sixty is the
  // defect this module exists to remove, reinstated one call away.
  const [first, second] = seen.reservations!;
  assert.notEqual(first.subjectKey, second.subjectKey, 'each second must reserve a different subject');
  assert.equal(first.subjectLimit, 1);
  assert.equal(second.subjectLimit, 1);
});

test('gives up within the wait budget instead of queueing forever', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }], seen),
    { namespace: 's2', maxWaitMs: 2_500, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: false });
  // Seconds 10, 11 and 12 are within 2.5 s of the start; 13 is not.
  assert.equal(seen.calls, 3);
  assert.deepEqual(slept, [], 'a refusal must not cost the caller any waiting');
});

test('a caller limited to some slots passes over the others without reserving them', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(scriptedLedger([{ accepted: true }], seen), {
    namespace: 'arxiv', accepts: candidate => candidate % 2 === 0, now: () => 11_000, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, slot: 12, waitedMs: 1000 });
  assert.equal(seen.calls, 1, 'second 11 is left for a caller that may take it');
  assert.deepEqual(slept, [1000]);
});

test('a limited caller with no slot of its own inside the wait budget is refused without asking the ledger', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slot = await awaitUpstreamSlot(scriptedLedger([{ accepted: true }], seen), {
    namespace: 'arxiv', maxWaitMs: 500, accepts: candidate => candidate % 2 === 0, now: () => 11_000, sleep: async () => {},
  });

  assert.deepEqual(slot, { accepted: false });
  assert.equal(seen.calls, 0);
});

test('relays a ledger that is not there instead of treating it as a full second', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
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
function advancingLedger(answers: QuotaReading[], roundTripsMs: number[], clock: { value: number }, seen: SeenReservations) {
  let call = 0;
  return {
    idFromName: (name: string): unknown => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: ((): Pick<DurableObjectStub, 'fetch'> => ({
      fetch: async (_url, options) => {
        clock.value += roundTripsMs[Math.min(call, roundTripsMs.length - 1)];
        const body = JSON.parse(options!.body as string);
        seen.reservations ??= [];
        seen.reservations.push({ subjectKey: body.subjectKey, subjectLimit: body.subjectLimit, partKey: body.partKey });
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        seen.calls = call;
        return new Response(JSON.stringify(answer));
      },
    })) as TestNamespace['get'],
  } as Env['REQUEST_QUOTA_LEDGER'];
}

test('a reservation confirmed after its second has closed is not spent -- the caller retries for the second that is actually current', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
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
  const slept: number[] = [];

  const slot = await awaitUpstreamSlot(advancingLedger(answers, roundTripsMs, clock, seen), {
    namespace: 's2', now: () => clock.value, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, slot: 12, waitedMs: 0 });
  assert.equal(seen.calls, 3, 'the stale accept of second 11 must cost a retry, not be spent as a send');
  assert.deepEqual(slept, [], 'the clock had already passed both seconds it tried by the time each was confirmed');
});

// A spaced beat keeps a whole period after every call. A slot whose period has
// begun is reserved with the next one, and a slot reserved ahead that the
// round trip carried past its start is given up: its call would go out late
// with the next slot free for someone else.
test('a spaced beat holds the next slot with a late one and gives up a slot the round trip made late', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const clock = { value: 10_950 };
  const slept: number[] = [];
  // Second 10 (begun) is refused; second 11 (50 ms ahead) is accepted 100 ms
  // later, at 11 050; second 12 is accepted at 11 150.
  const slot = await awaitUpstreamSlot(
    advancingLedger([{ accepted: false, scope: 'part' }, { accepted: true }, { accepted: true }], [0, 100, 100], clock, seen),
    { namespace: 'arxiv', spaced: true, now: () => clock.value, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, slot: 12, waitedMs: 850 });
  assert.deepEqual(slept, [850]);
  const [late, carried, ahead] = seen.reservations!;
  assert.ok(late.partKey && late.partKey !== late.subjectKey, 'the begun slot is reserved with the next one');
  assert.equal(late.partKey, carried.subjectKey, 'and the next one is second 11');
  assert.equal(carried.partKey, undefined);
  assert.equal(ahead.partKey, undefined);
});

// The cost of the empty slot, on the real ledger: a caller that would have
// taken it is refused when the slot after it is past its wait (outside review
// of PR #400). Three-second periods and a four-second wait, as arXiv's beat.
test('a spaced beat refuses a caller that comes in the first two seconds after a late call, and seats one that comes later', async () => {
  const period = 3_000;
  const evenStart = 1_000_000 * period;
  const callAt = async (ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], at: number, accepts?: (slot: number) => boolean) => {
    let clock = at;
    const seat = await awaitUpstreamSlot(ledger, {
      namespace: 'arxiv', periodMs: period, maxWaitMs: 4_000, spaced: true, accepts, now: () => clock, sleep: async ms => { clock += ms; },
    });
    return seat.accepted ? clock : null;
  };
  // Any caller after a late one, in its period: [first call, second call] offsets.
  for (const [first, second, sentAt] of [[100, 900, null], [1_500, 1_800, null], [1_500, 2_100, 2 * period], [2_500, 2_800, 2 * period]] as const) {
    const { binding } = inMemoryQuotaLedger();
    assert.equal(await callAt(binding, evenStart + first), evenStart + first, 'the late call goes out at once');
    assert.equal(await callAt(binding, evenStart + second), sentAt === null ? null : evenStart + sentAt, `${first} ms, then ${second} ms into the period`);
  }
  // A caller limited to even slots, after a late call in an odd period: the
  // even slot after it is empty, and the next even one is six seconds on.
  for (const [second, sentAt] of [[period + 900, null], [2 * period + 1_900, null], [2 * period + 2_000, 4 * period]] as const) {
    const { binding } = inMemoryQuotaLedger();
    await callAt(binding, evenStart + period + 500);
    assert.equal(await callAt(binding, evenStart + second, slot => slot % 2 === 0), sentAt === null ? null : evenStart + sentAt, `even slots only, ${second} ms on`);
  }
});

// The header a refused caller receives has to cover the whole window the beat
// just searched: telling it to come back sooner than that is telling it to
// come back before the search that just failed would even have finished.
test('tells a refused caller to come back no sooner than the wait budget it just exhausted', () => {
  assert.match(PACE_RETRY_AFTER_SECONDS, /^\d+$/, 'retry-after is whole seconds');
  assert.ok(Number(PACE_RETRY_AFTER_SECONDS) * 1000 >= DEFAULT_MAX_WAIT_MS,
    `${PACE_RETRY_AFTER_SECONDS}s does not cover a ${DEFAULT_MAX_WAIT_MS}ms window`);
  // Not just a floor: a constant that rounds the window up by whole minutes
  // would still clear the assertion above and leave a refused caller waiting
  // far longer than the beat itself ever does.
  assert.ok(Number(PACE_RETRY_AFTER_SECONDS) * 1000 < DEFAULT_MAX_WAIT_MS + 1000,
    `${PACE_RETRY_AFTER_SECONDS}s overshoots the ${DEFAULT_MAX_WAIT_MS}ms window by more than a second`);
});

// arXiv asks for one request every three seconds. The beat is the same beat,
// with a longer period: the clock at 10 000 ms is inside period 3 (9 000 to
// 11 999), the next period starts at 12 000.
test('a three-second beat reserves one slot per three seconds and waits for the next one', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }, { accepted: true }], seen),
    { namespace: 'arxiv', periodMs: 3_000, maxWaitMs: 4_000, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, slot: 4, waitedMs: 2_000 });
  assert.deepEqual(slept, [2_000]);
  assert.deepEqual(seen.periodKeys, ['arxiv:pace', 'arxiv:pace']);
  const [first, second] = seen.reservations!;
  assert.notEqual(first.subjectKey, second.subjectKey, 'each period must reserve a different subject');
  assert.equal(first.subjectLimit, 1);
});

test('a three-second beat gives up inside its own wait budget', async () => {
  const seen: SeenReservations = { periodKeys: [], calls: 0 };
  const slept: number[] = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }], seen),
    { namespace: 'arxiv', periodMs: 3_000, maxWaitMs: 4_000, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: false });
  // Period 3 starts at 9 000 (already begun), period 4 at 12 000 (2 s away):
  // both inside 4 s of 10 000. Period 5 starts at 15 000, 5 s away: outside.
  assert.equal(seen.calls, 2);
  assert.deepEqual(slept, []);
});

test('the retry-after of a beat covers the wait budget it was given', () => {
  assert.equal(paceRetryAfterSeconds(4_000), '4');
  assert.equal(paceRetryAfterSeconds(2_500), '3');
  assert.equal(paceRetryAfterSeconds(DEFAULT_MAX_WAIT_MS), PACE_RETRY_AFTER_SECONDS);
});
