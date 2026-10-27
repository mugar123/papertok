import test from 'node:test';
import assert from 'node:assert/strict';
import { unmarkRead } from './unmark-read.ts';

type Entry = { paperId: string; readAt?: string | null };

// FeedContext's two pieces of state, each changed through an updater as React runs it.
function feedState() {
  const state = {
    readIds: new Set(['p1', 'p2']),
    library: {
      p1: { paperId: 'p1', readAt: '2026-10-20T09:00:00.000Z' },
      p2: { paperId: 'p2', readAt: '2026-10-21T09:00:00.000Z' },
    } as Record<string, Entry>,
  };
  return {
    state,
    setReadIds: (update: (ids: Set<string>) => Set<string>) => { state.readIds = update(state.readIds); },
    setLibrary: (update: (library: Record<string, Entry>) => Record<string, Entry>) => { state.library = update(state.library); },
  };
}

const silenced = async (run: () => Promise<unknown>) => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

test('a refused write the caller asked about puts the mark and its time back, and says so', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  const refused = new Error('permission-denied');
  let restored = 0;
  await silenced(() => assert.rejects(unmarkRead('p2', {
    setReadIds,
    setLibrary,
    write: () => Promise.reject(refused),
    onUnmarked: () => {},
    onRestored: () => { restored += 1; },
    throwOnError: true,
    stillSignedIn: () => true,
  }), refused));
  assert.deepEqual([...state.readIds].sort(), ['p1', 'p2'], 'the row is still in Reading history');
  assert.equal(state.library.p2.readAt, '2026-10-21T09:00:00.000Z', 'and keeps its place in it');
  assert.equal(restored, 1);
});

test('the mark is gone while the write is in flight, and stays gone once it is accepted', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  let accept!: () => void;
  const pending = unmarkRead('p2', {
    setReadIds,
    setLibrary,
    write: () => new Promise<void>((resolve) => { accept = resolve; }),
    onUnmarked: () => {},
    onRestored: () => { assert.fail('the write was accepted'); },
    throwOnError: true,
    stillSignedIn: () => true,
  });
  assert.deepEqual([...state.readIds], ['p1']);
  accept();
  await pending;
  assert.deepEqual([...state.readIds], ['p1']);
  assert.equal(state.library.p2.readAt, null);
  assert.equal(state.library.p1.readAt, '2026-10-20T09:00:00.000Z');
});

test('a refusal that lands after the account changed leaves the new account alone', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  await silenced(() => assert.rejects(unmarkRead('p2', {
    setReadIds,
    setLibrary,
    write: () => Promise.reject(new Error('permission-denied')),
    onUnmarked: () => {},
    onRestored: () => { assert.fail('nothing is put back over another account'); },
    throwOnError: true,
    stillSignedIn: () => false,
  }), /permission-denied/));
  assert.deepEqual([...state.readIds], ['p1']);
});

test('callers that did not ask keep what they had: the refusal is logged, not thrown', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  const logged: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await unmarkRead('p2', {
      setReadIds,
      setLibrary,
      write: () => Promise.reject(new Error('permission-denied')),
      onUnmarked: () => {},
      onRestored: () => { assert.fail('no rollback without throwOnError'); },
      stillSignedIn: () => true,
    });
  } finally {
    console.error = original;
  }
  assert.deepEqual([...state.readIds], ['p1']);
  assert.equal(logged.length, 1);
});

test('with afterWrite the mark stays until the write is accepted, and a refusal leaves it untouched', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  let unmarked = 0;
  let answer!: { accept: () => void; refuse: (error: Error) => void };
  const write = () => new Promise<void>((accept, refuse) => { answer = { accept, refuse }; });
  const options = {
    setReadIds,
    setLibrary,
    write,
    onUnmarked: () => { unmarked += 1; },
    onRestored: () => { assert.fail('nothing was taken off'); },
    throwOnError: true,
    afterWrite: true,
    stillSignedIn: () => true,
  };

  const refused = unmarkRead('p2', options);
  assert.deepEqual([...state.readIds].sort(), ['p1', 'p2'], 'the row stays while the write is in flight');
  answer.refuse(new Error('permission-denied'));
  await silenced(() => assert.rejects(refused, /permission-denied/));
  assert.deepEqual([...state.readIds].sort(), ['p1', 'p2']);
  assert.equal(state.library.p2.readAt, '2026-10-21T09:00:00.000Z');
  assert.equal(unmarked, 0, 'the profile never hears of a removal that did not happen');

  const accepted = unmarkRead('p2', options);
  answer.accept();
  await accepted;
  assert.deepEqual([...state.readIds], ['p1']);
  assert.equal(state.library.p2.readAt, null);
  assert.equal(unmarked, 1);
});
