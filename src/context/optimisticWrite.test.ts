import test from 'node:test';
import assert from 'node:assert/strict';
import { writeOptimistically } from './optimisticWrite.ts';

function session(signedIn: string | undefined) {
  const shown: string[] = [];
  let release!: (error: Error) => void;
  const refused = new Promise<void>((_resolve, reject) => { release = reject; });
  const state = { signedIn };
  const pending = writeOptimistically({
    previous: 'beginner',
    next: 'researcher',
    apply: value => { shown.push(value); },
    write: () => refused,
    startedBy: signedIn,
    signedInUid: () => state.signedIn,
  });
  return { shown, state, pending, refuse: () => release(new Error('permission-denied')) };
}

test('a write the same account sees refused is rolled back and rethrown', async () => {
  const a = session('account-a');
  assert.deepEqual(a.shown, ['researcher'], 'shown at once');
  a.refuse();
  await assert.rejects(a.pending, /permission-denied/);
  assert.deepEqual(a.shown, ['researcher', 'beginner']);
});

test('a refusal that lands after A switched to B leaves B\'s state alone', async () => {
  const a = session('account-a');
  a.state.signedIn = 'account-b';
  a.refuse();
  await assert.rejects(a.pending, /permission-denied/);
  assert.deepEqual(a.shown, ['researcher'], 'A\'s previous value is not painted over B');
});

test('a refusal that lands after A signed out rolls nothing back either', async () => {
  const a = session('account-a');
  a.state.signedIn = undefined;
  a.refuse();
  await assert.rejects(a.pending, /permission-denied/);
  assert.deepEqual(a.shown, ['researcher']);
});

test('a write that lands returns what it wrote', async () => {
  const shown: string[] = [];
  const result = await writeOptimistically({
    previous: 'beginner', next: 'university', apply: value => { shown.push(value); },
    write: async () => {}, startedBy: 'account-a', signedInUid: () => 'account-a',
  });
  assert.equal(result, 'university');
  assert.deepEqual(shown, ['university']);
});
