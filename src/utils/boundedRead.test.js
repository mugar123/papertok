import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_STALL_MS,
  ReadTimedOutError,
  SLOW_NOTICE_AFTER_MS,
  isReadTimeout,
  isTransientReadError,
  patientRead,
  registerStallRecovery,
  slowNoticeStatus,
  withReadTimeout,
} from './boundedRead.js';

/** A hand-cranked clock, so the tests never wait in real time. */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimer(callback, ms) {
      const id = nextId; nextId += 1;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimer(id) { pending.delete(id); },
    /** Fires every armed timer, or only the ones set for `matchMs`. */
    fire(matchMs) {
      const entries = [...pending.entries()]
        .filter(([, entry]) => matchMs === undefined || entry.ms === matchMs);
      entries.forEach(([id]) => pending.delete(id));
      entries.forEach(([, entry]) => entry.callback());
    },
    get armed() { return pending.size; },
    get delay() { return [...pending.values()][0]?.ms; },
    get delays() { return [...pending.values()].map(entry => entry.ms); },
  };
}

/** The rejection Firestore hands back after its own ten-second verdict. */
function unavailable() {
  return Object.assign(
    new Error('Failed to get document because the client is offline.'),
    { code: 'unavailable' },
  );
}

/** Lets queued `.then` handlers run without waiting in real time. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Defaults that keep a test off the real `navigator` and `window`. */
const noAmbient = { checkOffline: () => false, subscribeOnline: () => () => {} };

test('a read that answers in time passes its value straight through', async () => {
  const timers = fakeTimers();
  const value = await withReadTimeout(Promise.resolve('thread'), { ...timers });
  assert.equal(value, 'thread');
  assert.equal(timers.armed, 0, 'the timer must be cleared, not left to fire later');
});

test('a read that never answers is rejected as a timeout', async () => {
  const timers = fakeTimers();
  const pending = withReadTimeout(new Promise(() => {}), { ...timers, label: 'comment thread' });
  timers.fire();
  const error = await pending.then(() => null, e => e);
  assert.ok(error instanceof ReadTimedOutError);
  assert.equal(isReadTimeout(error), true);
  assert.equal(error.label, 'comment thread');
  assert.match(error.message, /comment thread/);
});

test('a genuine failure is passed through untouched, not disguised as a timeout', async () => {
  const timers = fakeTimers();
  const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  const error = await withReadTimeout(Promise.reject(denied), { ...timers }).then(() => null, e => e);
  assert.equal(error, denied);
  assert.equal(isReadTimeout(error), false, 'a denial is an answer; a timeout is not');
  assert.equal(timers.armed, 0);
});

test('an answer arriving after the timeout cannot resolve the settled promise', async () => {
  const timers = fakeTimers();
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const bounded = withReadTimeout(slow, { ...timers });
  timers.fire();
  const first = await bounded.then(() => 'resolved', e => (isReadTimeout(e) ? 'timed-out' : 'other'));
  assert.equal(first, 'timed-out');

  // Firestore cannot cancel a read, so the late answer does arrive. It must
  // not resolve a promise the caller has already given up on.
  release('late answer');
  const second = await bounded.then(() => 'resolved', e => (isReadTimeout(e) ? 'timed-out' : 'other'));
  assert.equal(second, 'timed-out', 'the outcome must stay stable');
});

test('the default bound is generous but finite', () => {
  const timers = fakeTimers();
  withReadTimeout(new Promise(() => {}), { ...timers });
  assert.equal(timers.delay, DEFAULT_READ_TIMEOUT_MS);
  assert.ok(DEFAULT_READ_TIMEOUT_MS >= 3000, 'must not fire on a merely slow connection');
  assert.ok(Number.isFinite(DEFAULT_READ_TIMEOUT_MS), 'an unbounded wait is the bug being fixed');
});

test('isReadTimeout ignores anything that is not a timeout', () => {
  assert.equal(isReadTimeout(null), false);
  assert.equal(isReadTimeout(undefined), false);
  assert.equal(isReadTimeout(new Error('boom')), false);
});

// ---------------------------------------------------------------------------
// patientRead — the measured failure this exists for: a first read against a
// silent connection must not end in "could not be loaded".

/** Attempts whose answers the test releases by hand. */
function scriptedAttempts() {
  const launched = [];
  const makeAttempt = () => new Promise((resolve, reject) => {
    launched.push({ resolve, reject });
  });
  return { makeAttempt, launched };
}

test('a slow first read does not end in failure: the retry answers instead', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const slowNotices = [];
  const read = patientRead(makeAttempt, {
    ...timers, attempts: 2, onSlow: n => slowNotices.push(n),
  });
  assert.equal(launched.length, 1, 'one attempt in flight');

  timers.fire();                       // first timeout: attempt 1 is slow, not dead
  assert.equal(launched.length, 2, 'a second attempt launches instead of giving up');
  assert.deepEqual(slowNotices, [1], 'the interface is told "slow", not "failed"');

  launched[1].resolve('thread');
  assert.equal(await read, 'thread', 'the retry answer resolves the read normally');
});

test('the slow first attempt itself can still win after the retry launches', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const read = patientRead(makeAttempt, { ...timers, attempts: 2 });
  timers.fire();
  assert.equal(launched.length, 2);
  launched[0].resolve('late but first');   // the original answers before the retry
  assert.equal(await read, 'late but first');
});

test('when every attempt times out, the late answer is still delivered', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  let late = null;
  const read = patientRead(makeAttempt, {
    ...timers, attempts: 2, label: 'comment thread', onLateResult: value => { late = value; },
  });
  timers.fire();                       // slow notice, attempt 2
  timers.fire();                       // final timeout
  const error = await read.then(() => null, e => e);
  assert.equal(isReadTimeout(error), true);
  assert.equal(error.label, 'comment thread');

  // The stall ends at its own pace — nine seconds, not six — and the screen
  // still gets the data, with no user action.
  launched[0].resolve('the thread, eventually');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(late, 'the thread, eventually');

  // Only once: the second stalled attempt resolving must not re-deliver.
  launched[1].resolve('duplicate');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(late, 'the thread, eventually');
});

test('a real failure is immediate — deterministic errors do not deserve patience', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  const read = patientRead(makeAttempt, { ...timers, attempts: 3 });
  launched[0].reject(denied);
  const error = await read.then(() => null, e => e);
  assert.equal(error, denied);
  assert.equal(launched.length, 1, 'no retries burned on a denial that will not change');
});

test('a success before the first timeout resolves without ever signalling slow', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const slowNotices = [];
  const read = patientRead(makeAttempt, { ...timers, attempts: 2, onSlow: n => slowNotices.push(n) });
  launched[0].resolve('fast');
  assert.equal(await read, 'fast');
  assert.deepEqual(slowNotices, [], 'a fast read never hears about slowness');
  assert.equal(timers.armed, 0, 'and leaves no timer behind');
});

// ---------------------------------------------------------------------------
// The measured bug: Firestore's own ten-second verdict arrives as a rejection,
// not as a timeout, and it used to walk straight past all the patience above.

test('isTransientReadError tells "not now" apart from "not ever"', () => {
  for (const code of ['unavailable', 'deadline-exceeded', 'internal',
    'cancelled', 'aborted', 'resource-exhausted', 'unknown']) {
    assert.equal(isTransientReadError({ code }), true, `${code} deserves patience`);
  }
  for (const code of ['permission-denied', 'unauthenticated', 'not-found',
    'invalid-argument', 'failed-precondition', 'unimplemented']) {
    assert.equal(isTransientReadError({ code }), false, `${code} will not change`);
  }
  assert.equal(isTransientReadError(new ReadTimedOutError('thread')), true);
  assert.equal(isTransientReadError(new TypeError('a bug in our own code')), false);
  assert.equal(isTransientReadError(null), false);
});

test('a stalled connection is not a verdict: the read waits and the retry answers', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const notices = [];
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 2,
    onSlow: (attempt, info) => notices.push({ attempt, ...info }),
  });

  launched[0].reject(unavailable());
  await tick();

  assert.equal(launched.length, 1, 'the dead attempt is not replaced on the spot');
  assert.deepEqual(notices, [{ attempt: 1, offline: false }],
    'the interface is told "slow", never "could not be loaded"');
  assert.ok(timers.delays.includes(800), 'the retry waits out a backoff first');

  timers.fire(800);
  assert.equal(launched.length, 2, 'and then asks again');
  launched[1].resolve('thread');
  assert.equal(await read, 'thread');
});

test('repeated instant rejections back off instead of burning the budget', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const read = patientRead(makeAttempt, { ...timers, ...noAmbient, attempts: 2 });
  read.catch(() => {});

  // Once the SDK has latched itself offline it rejects in under a millisecond:
  // without a growing pause these four rounds would all land in the same tick.
  const seen = [];
  for (let round = 0; round < 4; round += 1) {
    launched[round].reject(unavailable());
    await tick();
    seen.push(timers.delays.find(ms => ms !== 6000));
    timers.fire(seen[round]);
  }
  assert.deepEqual(seen, [800, 1600, 3200, 6400], 'each round waits twice as long');
  assert.equal(launched.length, 5, 'one read per round, not a spin');
});

test('the backoff is capped, so a long outage costs one cheap read per pause', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 2, retryDelayMs: 4000, maxRetryDelayMs: 8000,
  });
  read.catch(() => {});

  const seen = [];
  for (let round = 0; round < 3; round += 1) {
    launched[round].reject(unavailable());
    await tick();
    const delay = timers.delays.find(ms => ms !== 6000);
    seen.push(delay);
    timers.fire(delay);
  }
  assert.deepEqual(seen, [4000, 8000, 8000], 'doubling stops at the ceiling');
});

test('with no network the notice says so, and the online event skips the wait', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const notices = [];
  let wake = null;
  const read = patientRead(makeAttempt, {
    ...timers, attempts: 2,
    checkOffline: () => true,
    subscribeOnline: (listener) => { wake = listener; return () => { wake = null; }; },
    onSlow: (attempt, info) => notices.push(info),
  });

  launched[0].reject(unavailable());
  await tick();
  assert.deepEqual(notices, [{ offline: true }], '"no connection" is a different truth');
  assert.ok(timers.delays.includes(8000), 'offline goes straight to the longest pause');

  wake();
  assert.equal(launched.length, 2, 'coming back online re-reads at once');
  launched[1].resolve('thread');
  assert.equal(await read, 'thread');
});

test('a stall that ends after the verdict still heals the screen, with no user action', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  let late = null;
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 1, label: 'comment thread',
    onLateResult: (value) => { late = value; },
  });

  launched[0].reject(unavailable());     // Firestore's ten-second verdict
  await tick();
  timers.fire(800);                      // backoff elapses, ask again
  timers.fire(6000);                     // the retry times out: budget spent

  const error = await read.then(() => null, e => e);
  assert.equal(isReadTimeout(error), true, 'the caller sees a timeout, not a failure');
  assert.equal(error.cause?.code, 'unavailable', 'and can still see what really happened');

  // The promise is settled, but the loop is not: this is the whole point.
  launched[1].reject(unavailable());
  await tick();
  timers.fire(timers.delays.find(ms => ms !== 6000));
  await tick();
  launched[2].resolve('the thread, eventually');
  await tick();
  assert.equal(late, 'the thread, eventually', 'the answer lands with nobody touching anything');
});

test('the retry loop stops when nobody is listening for a late answer', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const read = patientRead(makeAttempt, { ...timers, ...noAmbient, attempts: 1 });
  read.catch(() => {});

  timers.fire(6000);                     // the only attempt times out
  launched[0].reject(unavailable());
  await tick();
  assert.equal(timers.armed, 0, 'no onLateResult means the loop has no consumer');
  assert.equal(launched.length, 1);
});

test('a deterministic error ends the retry loop even after the verdict', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 1, onLateResult: () => {},
  });
  read.catch(() => {});

  timers.fire(6000);
  launched[0].reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
  await tick();
  assert.equal(timers.armed, 0, 'asking again will never change a denial');
});

test('aborting stops every timer and every retry', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const controller = new AbortController();
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 2, signal: controller.signal, onLateResult: () => {},
  });
  read.catch(() => {});

  launched[0].reject(unavailable());
  await tick();
  assert.ok(timers.armed > 0, 'a retry is pending');

  controller.abort();                    // the screen unmounted
  assert.equal(timers.armed, 0, 'nothing is left to fire');
  timers.fire();
  assert.equal(launched.length, 1, 'and no further read is issued');
});

test('an already-aborted signal never reads at all', () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const controller = new AbortController();
  controller.abort();
  patientRead(makeAttempt, { ...timers, ...noAmbient, signal: controller.signal }).catch(() => {});
  assert.equal(launched.length, 0);
  assert.equal(timers.armed, 0);
});

test('a read that never comes back is retried too, not just one that rejects', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  let late = null;
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 1,
    onLateResult: (value) => { late = value; },
  });
  read.catch(() => {});

  timers.fire(6000);                 // the only attempt times out: budget spent
  assert.ok(timers.delays.includes(800), 'a fresh read is queued behind the backoff');

  // The first attempt is a hostage of the dead connection and will never
  // answer. Only a new read can heal the screen.
  timers.fire(800);
  assert.equal(launched.length, 2, 'so a new one is issued');
  launched[1].resolve('the thread, eventually');
  await tick();
  assert.equal(late, 'the thread, eventually');
  assert.equal(timers.armed, 0, 'and the loop stops once the answer lands');
});

test('the healing loop survives a retry that also never comes back', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  let late = null;
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 1,
    onLateResult: (value) => { late = value; },
  });
  read.catch(() => {});

  timers.fire(6000);                 // the verdict
  timers.fire(800);                  // first healing read
  assert.equal(launched.length, 2);

  // It hangs exactly like the first one did. The loop must not stop here.
  timers.fire(6000);
  assert.ok(timers.delays.includes(1600), 'the next read is queued, at a longer pause');
  timers.fire(1600);
  assert.equal(launched.length, 3, 'the screen keeps asking while nobody is watching');

  launched[2].resolve('the thread, eventually');
  await tick();
  assert.equal(late, 'the thread, eventually');
  assert.equal(timers.armed, 0);
});

// --- when a wait has waited long enough to be worth words -----------------

test('a rejection that arrives in the first frame does not make the screen say "slow"', () => {
  // The measured case: an unconfirmed absence (see cacheAuthority.js) rejects
  // in about half a millisecond, and onSlow fires on ANY transient rejection.
  assert.equal(slowNoticeStatus(2, { offline: false }), null);
  assert.equal(slowNoticeStatus(0, {}), null);
  assert.equal(slowNoticeStatus(SLOW_NOTICE_AFTER_MS - 1, undefined), null);
});

test('past the threshold the wait gets its words', () => {
  assert.equal(slowNoticeStatus(SLOW_NOTICE_AFTER_MS, { offline: false }), 'slow');
  assert.equal(slowNoticeStatus(30_000, {}), 'slow');
});

test('no connection needs no wait: the browser already knows', () => {
  assert.equal(slowNoticeStatus(0, { offline: true }), 'offline');
  assert.equal(slowNoticeStatus(30_000, { offline: true }), 'offline');
});

test('the threshold is below the read budget, so a real timeout still speaks at the first one', () => {
  assert.ok(SLOW_NOTICE_AFTER_MS < DEFAULT_READ_TIMEOUT_MS);
  assert.equal(slowNoticeStatus(DEFAULT_READ_TIMEOUT_MS, { offline: false }), 'slow');
  // Injectable, so a caller with a different budget is not stuck with ours.
  assert.equal(slowNoticeStatus(500, { offline: false }, 400), 'slow');
});

// --- a stream that has died under a live client ---------------------------
//
// Measured 2026-09-06 against production with the SDK's requests held at the
// network: a getDoc and a getDocs issued against a silent listen stream had
// not settled after 96 s, and did not settle when the network came back
// either — the SDK never re-opens a stream it believes is healthy. A
// disableNetwork/enableNetwork pair rebuilt it in 6 ms: the hostages settled
// at once (a cached document with its data, an uncached one as `unavailable`,
// a query as an empty cache answer) and the next read answered from the
// server in 130 ms. `patientRead` is where every screen already waits, so it
// is where the stream gets its kick.

test('an attempt that has not answered by stallMs asks for the stream to be recovered, once', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const stalls = [];
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 2, stallMs: 3000,
    onStall: (attempt) => stalls.push(attempt),
  });

  assert.ok(timers.delays.includes(3000), 'the stall watch is armed with the attempt');
  timers.fire(3000);
  assert.deepEqual(stalls, [1], 'still no answer at the threshold: the stream is kicked');

  // The kick flushes the hostage as the SDK's own "client is offline" — a
  // transient — and the retry that follows meets the rebuilt stream.
  launched[0].reject(unavailable());
  await tick();
  timers.fire(800);
  assert.equal(launched.length, 2);
  launched[1].resolve('the lists, from the server');
  assert.equal(await read, 'the lists, from the server');
  assert.deepEqual(stalls, [1], 'the retry answered before its own stall watch fired');
});

test('a read that answers before stallMs never touches the stream', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const stalls = [];
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, stallMs: 3000, onStall: (attempt) => stalls.push(attempt),
  });
  launched[0].resolve('fast');
  assert.equal(await read, 'fast');
  timers.fire(3000);
  assert.deepEqual(stalls, [], 'a settled read has nothing to recover');
  assert.equal(timers.armed, 0);
});

test('with no network there is no stream to recover, so the stall watch stays quiet', () => {
  const timers = fakeTimers();
  const { makeAttempt } = scriptedAttempts();
  const stalls = [];
  patientRead(makeAttempt, {
    ...timers, checkOffline: () => true, subscribeOnline: () => () => {},
    stallMs: 3000, onStall: (attempt) => stalls.push(attempt),
  }).catch(() => {});
  timers.fire(3000);
  assert.deepEqual(stalls, [], 'the browser already said offline; a kick would only churn');
});

test('the stall threshold sits below the read budget, so the kick lands before the verdict', () => {
  assert.ok(DEFAULT_STALL_MS < DEFAULT_READ_TIMEOUT_MS);
  assert.ok(DEFAULT_STALL_MS >= 2000, 'well above a healthy cold read (450 ms measured)');
});

test('with no onStall of its own, a read uses the recovery registered for the app', async () => {
  const timers = fakeTimers();
  const { makeAttempt } = scriptedAttempts();
  const calls = [];
  const restore = registerStallRecovery(() => calls.push('kick'));
  try {
    patientRead(makeAttempt, { ...timers, ...noAmbient, stallMs: 3000 }).catch(() => {});
    timers.fire(3000);
    assert.deepEqual(calls, ['kick']);
  } finally {
    restore();
  }
  const { makeAttempt: again } = scriptedAttempts();
  patientRead(again, { ...timers, ...noAmbient, stallMs: 3000 }).catch(() => {});
  timers.fire(3000);
  assert.deepEqual(calls, ['kick'], 'once unregistered, a stall is only waited out');
});

test('an answer the caller cannot act on is a "not now", not a result', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  const notices = [];
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 2,
    // A query flushed from the cache by the kick: empty, and not the server's word.
    isAnswer: (snapshot) => snapshot.authoritative,
    onSlow: (attempt, info) => notices.push({ attempt, ...info }),
  });

  launched[0].resolve({ authoritative: false, docs: [] });
  await tick();
  assert.equal(launched.length, 1, 'not replaced on the spot');
  assert.deepEqual(notices, [{ attempt: 1, offline: false }], 'the screen may say slow, never empty');
  assert.ok(timers.delays.includes(800), 'a fresh read is queued behind the backoff');

  timers.fire(800);
  launched[1].resolve({ authoritative: true, docs: ['a list'] });
  assert.deepEqual(await read, { authoritative: true, docs: ['a list'] });
});

test('a late answer the caller cannot act on is not delivered as the healing result either', async () => {
  const timers = fakeTimers();
  const { makeAttempt, launched } = scriptedAttempts();
  let late = null;
  const read = patientRead(makeAttempt, {
    ...timers, ...noAmbient, attempts: 1,
    isAnswer: (snapshot) => snapshot.authoritative,
    onLateResult: (value) => { late = value; },
  });
  read.catch(() => {});

  timers.fire(6000);                       // the verdict
  launched[0].resolve({ authoritative: false });
  await tick();
  assert.equal(late, null, 'an empty cache answer must not heal the screen with nothing');
  assert.ok(timers.armed > 0, 'the loop keeps asking');
  timers.fire();                           // the backoff
  assert.equal(launched.length, 2);
  launched[1].resolve({ authoritative: true });
  await tick();
  assert.deepEqual(late, { authoritative: true });
});
