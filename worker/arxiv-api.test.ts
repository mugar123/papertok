import type { TestContext } from 'node:test';
import type { WorkerEnv } from './env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_PACE_PERIOD_MS, takeArxivSeat } from './arxiv-api.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { awaitUpstreamSlot } from './upstream-pace.ts';

type Caller = 'reader' | 'agent' | 'worker' | 'digest';
interface Arrival { at: number; caller: Caller }
interface Outcome { arrival: Arrival; sentAt?: number }

const ROUND_TRIP_MS = 10;
const STEP_MS = 10;
// 2026-11-03T00:00:00Z is the start of an even (public) period.
const START = Date.UTC(2026, 10, 3);

// The request ledger as a Durable Object behaves: one request at a time, each
// a round trip away on the simulated clock.
function ledgerBinding() {
  const binding = inMemoryQuotaLedger().binding!;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    idFromName: (name: string) => binding.idFromName(name),
    get: (id: DurableObjectId) => ({
      fetch: async (url: string, init?: RequestInit) => {
        await new Promise(resolve => setTimeout(resolve, ROUND_TRIP_MS / 2));
        const answer = queue.then(() => binding.get(id).fetch(url, init));
        queue = answer.catch(() => undefined);
        const response = await answer;
        await new Promise(resolve => setTimeout(resolve, ROUND_TRIP_MS / 2));
        return response;
      },
    }),
  } as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'];
}

// How main seated the same callers: the same seats and waits, no spacing, and
// the digest's query sent at once outside the beat.
const PUBLIC = (slot: number) => slot % 2 === 0;
function mainSeat(ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], caller: Caller) {
  if (caller === 'digest') return Promise.resolve({ accepted: true });
  return awaitUpstreamSlot(ledger, {
    namespace: 'arxiv',
    periodMs: ARXIV_PACE_PERIOD_MS,
    maxWaitMs: caller === 'agent' ? 0 : ARXIV_PACE_MAX_WAIT_MS,
    accepts: caller === 'worker' ? undefined : PUBLIC,
  });
}

// A simulated clock that moves only when every caller in progress is waiting on
// a timer (each waits on at most one at a time): it then jumps to the earliest
// timer or arrival and runs it. Hashing a ledger subject runs off the event
// loop, so a caller can be busy with no callback queued.
function simulatedClock(t: TestContext) {
  let now = START;
  let sequence = 0;
  let busy = 0;
  const timers: Array<{ due: number; sequence: number; run: () => void; arrival?: boolean }> = [];
  const schedule = (run: () => void, ms: number, arrival = false) => {
    timers.push({ due: now + Math.max(0, ms), sequence: sequence += 1, run, arrival });
  };
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((run: () => void, ms = 0) => {
    schedule(run, ms);
    return 0;
  }) as unknown as typeof setTimeout);
  return {
    // Runs `work` at `at` ms after the start, counted busy until it settles.
    arrive(at: number, work: () => Promise<void>) {
      return new Promise<void>((resolve, reject) => schedule(() => {
        busy += 1;
        work().finally(() => { busy -= 1; }).then(resolve, reject);
      }, at, true));
    },
    restart() { now = START; },
    async run() {
      for (;;) {
        while (timers.filter(timer => !timer.arrival).length < busy) {
          await new Promise(resolve => setImmediate(resolve));
        }
        if (!timers.length) return;
        timers.sort((a, b) => a.due - b.due || a.sequence - b.sequence);
        const next = timers.shift()!;
        now = Math.max(now, next.due);
        next.run();
      }
    },
  };
}
type Clock = ReturnType<typeof simulatedClock>;

// Plays the arrivals on the simulated clock and returns when each one's call
// went out, or that it was refused.
async function play(
  clock: Clock,
  arrivals: Arrival[],
  seat: (ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], caller: Caller) => Promise<{ accepted: boolean; code?: string }>,
) {
  clock.restart();
  const ledger = ledgerBinding();
  const outcomes: Outcome[] = [];
  const pending = arrivals.map(arrival => clock.arrive(arrival.at, async () => {
    const taken = await seat(ledger, arrival.caller);
    assert.equal(taken.code, undefined);
    outcomes.push({ arrival, sentAt: taken.accepted ? Date.now() : undefined });
  }));
  await clock.run();
  await Promise.all(pending);
  return outcomes;
}

function sendTimes(outcomes: Outcome[]) {
  return outcomes.flatMap(outcome => (outcome.sentAt === undefined ? [] : [outcome.sentAt])).sort((a, b) => a - b);
}

function shortestGap(outcomes: Outcome[]) {
  const times = sendTimes(outcomes);
  return Math.min(...times.slice(1).map((time, index) => time - times[index]));
}

function refusedReaders(outcomes: Outcome[]) {
  return outcomes.filter(outcome => outcome.arrival.caller === 'reader' && outcome.sentAt === undefined)
    .map(outcome => outcome.arrival.at).sort((a, b) => a - b);
}

// A deterministic stream of arrivals: `rates` is the mean gap in ms between
// two arrivals of each caller.
function arrivalsFrom(seed: number, durationMs: number, rates: Partial<Record<Caller, number>>) {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const arrivals: Arrival[] = [];
  for (const [caller, meanGapMs] of Object.entries(rates) as Array<[Caller, number]>) {
    for (let at = Math.floor(random() * meanGapMs); at < durationMs; at += Math.floor(-Math.log(1 - random()) * meanGapMs) + STEP_MS) {
      arrivals.push({ at: at - (at % STEP_MS), caller });
    }
  }
  return arrivals.sort((a, b) => a.at - b.at);
}

test('a Worker lookup that takes its seat late no longer sends a reader\'s call right after it', async t => {
  const clock = simulatedClock(t);
  // The outside verifier's case on #400: the Worker's call goes out 2.9 s into
  // an odd period, and a reader who booked the next (public) seat used to send
  // 0.1 s later, at its start.
  const arrivals: Arrival[] = [{ at: 4_000, caller: 'reader' }, { at: 5_900, caller: 'worker' }];
  const main = await play(clock, arrivals, mainSeat);
  assert.ok(shortestGap(main) < 200, 'main sends the two calls within 0.2 s');

  const outcomes = await play(clock, arrivals, takeArxivSeat);
  assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
  assert.deepEqual(refusedReaders(outcomes), []);
  const reader = outcomes.find(outcome => outcome.arrival.caller === 'reader')!;
  assert.ok(reader.sentAt! - (START + reader.arrival.at) <= ARXIV_PACE_MAX_WAIT_MS);
});

test('a reader who arrives after a late Worker call waits for the gap within four seconds', async t => {
  const clock = simulatedClock(t);
  const arrivals: Arrival[] = [{ at: 5_900, caller: 'worker' }, { at: 6_000, caller: 'reader' }];
  const outcomes = await play(clock, arrivals, takeArxivSeat);
  assert.deepEqual(refusedReaders(outcomes), []);
  assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
  const reader = outcomes.find(outcome => outcome.arrival.caller === 'reader')!;
  assert.ok(reader.sentAt! - (START + reader.arrival.at) <= ARXIV_PACE_MAX_WAIT_MS);
});

test('an agent takes the current public seat at once, and the next Worker call keeps three seconds after it', async t => {
  const clock = simulatedClock(t);
  const outcomes = await play(clock, [{ at: 2_500, caller: 'agent' }, { at: 2_600, caller: 'worker' }], takeArxivSeat);
  const agent = outcomes.find(outcome => outcome.arrival.caller === 'agent')!;
  assert.ok(agent.sentAt! - (START + 2_500) <= 2 * ROUND_TRIP_MS, 'the agent did not wait for a seat ahead');
  assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
});

test('the digest takes a seat of its own on the beat and keeps three seconds from readers', async t => {
  const clock = simulatedClock(t);
  const arrivals: Arrival[] = [{ at: 1_000, caller: 'reader' }, { at: 1_100, caller: 'digest' }, { at: 1_200, caller: 'digest' }];
  const main = await play(clock, arrivals, mainSeat);
  assert.ok(shortestGap(main) < 200, 'on main the digest calls arXiv outside the beat');

  const outcomes = await play(clock, arrivals, takeArxivSeat);
  assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
  assert.deepEqual(refusedReaders(outcomes), []);
  // One digest query takes the odd seat at 3 s, the other the next one.
  assert.equal(outcomes.filter(outcome => outcome.arrival.caller === 'digest' && outcome.sentAt !== undefined).length, 2);
});

test('every arXiv query of a schedule batch of three subscribers gets a seat, so none falls back to OpenAlex', async t => {
  const clock = simulatedClock(t);
  // The schedule asks for three subscribers at once, so their queries arrive
  // together; batches follow each other. Both parities of the period.
  for (const start of [0, 1_000, 3_500, 5_900]) {
    const arrivals: Arrival[] = [0, 0, 0, 20_000, 20_000, 20_000].map(at => ({ at: start + at, caller: 'digest' }));
    const outcomes = await play(clock, arrivals, takeArxivSeat);
    assert.deepEqual(outcomes.filter(outcome => outcome.sentAt === undefined), [], `batch at ${start} ms`);
    assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
  }
});

test('a reader is not refused because a Worker lookup took the seat before theirs late', async t => {
  const clock = simulatedClock(t);
  // An agent sends late in a public period; a Worker lookup arrives right
  // after it, and a reader at the start of the next (odd) period. Main sends
  // the lookup at 3 s and the reader at 6 s. Booked behind the agent, the
  // lookup used to take a send time after 6 s, and the reader, whose wait
  // ends at 7 s, was refused.
  const arrivals: Arrival[] = [{ at: 2_900, caller: 'agent' }, { at: 2_950, caller: 'worker' }, { at: 3_000, caller: 'reader' }];
  assert.deepEqual(refusedReaders(await play(clock, arrivals, mainSeat)), []);
  const outcomes = await play(clock, arrivals, takeArxivSeat);
  assert.deepEqual(refusedReaders(outcomes), []);
  assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS);
});


// How long each caller may wait for its call, from its arrival. An agent never
// waits for a seat ahead; a call that goes out on the ledger's answer, without
// waiting, is a round trip after the arrival.
const WAIT_BOUND_MS: Record<Caller, number> = {
  reader: ARXIV_PACE_MAX_WAIT_MS,
  agent: 0,
  worker: ARXIV_PACE_MAX_WAIT_MS,
  digest: 8 * ARXIV_PACE_PERIOD_MS,
};

test('no two arXiv calls go out less than three seconds apart, from any mix of callers', async t => {
  const clock = simulatedClock(t);
  const loads: Array<Partial<Record<Caller, number>>> = [
    { reader: 2_500, worker: 3_000, agent: 6_000, digest: 9_000 },
    { reader: 10_000, worker: 4_000, agent: 10_000, digest: 20_000 },
    { worker: 1_000 },
  ];
  for (const load of loads) {
    for (let seed = 1; seed <= 40; seed += 1) {
      const outcomes = await play(clock, arrivalsFrom(seed, 60_000, load), takeArxivSeat);
      assert.ok(sendTimes(outcomes).length > 4);
      assert.ok(shortestGap(outcomes) >= ARXIV_PACE_PERIOD_MS, `${JSON.stringify(load)} seed ${seed}: ${shortestGap(outcomes)} ms`);
      for (const { arrival, sentAt } of outcomes) {
        if (sentAt !== undefined) assert.ok(sentAt - (START + arrival.at) <= WAIT_BOUND_MS[arrival.caller] + ROUND_TRIP_MS);
      }
    }
  }
});

// The Worker's lookups and the digest give way to readers, so spacing the calls
// refuses no reader that main answered; those callers take the cost instead.
test('over mixed traffic no reader is refused whom main answered', async t => {
  const clock = simulatedClock(t);
  const loads: Array<Partial<Record<Caller, number>>> = [
    { reader: 3_000, worker: 6_000, agent: 12_000 },
    { reader: 4_000, worker: 4_000, agent: 6_000 },
    { reader: 10_000, worker: 4_000, agent: 10_000 },
    { reader: 20_000, worker: 20_000, agent: 20_000 },
    { reader: 4_000, worker: 6_000, digest: 6_000 },
    { reader: 10_000, worker: 10_000, digest: 4_000 },
  ];
  for (const load of loads) {
    let main = 0;
    for (let seed = 1; seed <= 50; seed += 1) {
      const arrivals = arrivalsFrom(seed, 60_000, load);
      const refusedOnMain = refusedReaders(await play(clock, arrivals, mainSeat));
      main += refusedOnMain.length;
      const newlyRefused = refusedReaders(await play(clock, arrivals, takeArxivSeat)).filter(at => !refusedOnMain.includes(at));
      assert.deepEqual(newlyRefused, [], `${JSON.stringify(load)} seed ${seed}`);
    }
    assert.ok(main > 0, 'the load refuses some readers on main');
  }
});