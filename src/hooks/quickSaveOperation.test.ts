import test from 'node:test';
import assert from 'node:assert/strict';
import { markThenConfirm, runOneAtATime } from './quickSaveOperation.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('taps on a paper while its operation runs are dropped, and the paper is free once it settles', async () => {
  const inFlight = new Set<string>();
  const write = deferred();
  let started = 0;
  const tap = () => runOneAtATime(inFlight, '2401.00001', () => { started += 1; return write.promise; });

  const taps = [tap(), tap(), tap()];
  assert.equal(started, 1, 'no second chain of writes');
  write.resolve();
  await Promise.all(taps);
  await runOneAtATime(inFlight, '2401.00001', async () => { started += 1; });
  assert.equal(started, 2);
});

test('a refused operation frees the paper too, and another paper never waits on it', async () => {
  const inFlight = new Set<string>();
  const write = deferred();
  const first = runOneAtATime(inFlight, 'a', () => write.promise);
  let other = 0;
  await runOneAtATime(inFlight, 'b', async () => { other += 1; });
  assert.equal(other, 1);
  write.reject(new Error('permission-denied'));
  await assert.rejects(first, /permission-denied/);
  assert.equal(inFlight.size, 0);
});

function save({ alreadySaved = false } = {}) {
  const calls: string[] = [];
  const document = deferred();
  const pending = markThenConfirm({
    alreadySaved,
    issued: document.promise,
    mark: async () => { calls.push('mark'); },
    unmark: async () => { calls.push('unmark'); },
    confirm: async () => { calls.push('confirm'); },
  });
  return { calls, document, pending };
}

test('a save fills the button before Firestore answers', async () => {
  const s = save();
  assert.deepEqual(s.calls, ['mark']);
  s.document.resolve();
  await s.pending;
  assert.deepEqual(s.calls, ['mark', 'confirm']);
});

test('a refused save puts the button back and reports the refusal', async () => {
  const s = save();
  s.document.reject(new Error('permission-denied'));
  await assert.rejects(s.pending, /permission-denied/);
  assert.deepEqual(s.calls, ['mark', 'unmark']);
});

test('a refused Undo on a paper saved again by hand leaves that save alone', async () => {
  const s = save({ alreadySaved: true });
  s.document.reject(new Error('unavailable'));
  await assert.rejects(s.pending, /unavailable/);
  assert.deepEqual(s.calls, ['mark']);
});
