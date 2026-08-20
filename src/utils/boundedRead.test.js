import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_READ_TIMEOUT_MS,
  ReadTimedOutError,
  isReadTimeout,
  patientRead,
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
    fire() {
      const entries = [...pending.entries()];
      pending.clear();
      entries.forEach(([, entry]) => entry.callback());
    },
    get armed() { return pending.size; },
    get delay() { return [...pending.values()][0]?.ms; },
  };
}

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
