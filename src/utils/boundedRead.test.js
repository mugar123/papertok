import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_READ_TIMEOUT_MS,
  ReadTimedOutError,
  isReadTimeout,
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
