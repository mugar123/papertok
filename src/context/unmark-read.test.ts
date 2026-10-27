import test from 'node:test';
import assert from 'node:assert/strict';
import { unmarkRead } from './unmark-read.ts';
import { markChanges } from './write-mark.ts';

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
    stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
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
    stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
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
    stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
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
      stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
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
    stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
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

test('a Reading history removal answered after something else took the mark off tells the profile nothing', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  let accept!: () => void;
  let unmarked = 0;
  const removal = unmarkRead('p2', {
    setReadIds,
    setLibrary,
    write: () => new Promise<void>((resolve) => { accept = resolve; }),
    onUnmarked: () => { unmarked += 1; },
    onRestored: () => { assert.fail('nothing was refused'); },
    throwOnError: true,
    afterWrite: true,
    stillSignedIn: () => true,
    stillNewest: () => true,
    stillRead: () => state.readIds.has('p2'),
  });
  // A profile reload, which numbers no change, already shows the paper unread.
  setReadIds((ids) => new Set([...ids].filter((id) => id !== 'p2')));
  accept();
  await removal;
  assert.deepEqual([...state.readIds], ['p1']);
  assert.equal(unmarked, 0, 'no second unread in the reading profile');
});

test('a Reading history removal answered after the card unmarked and marked the paper read leaves it read', async () => {
  const { state, setReadIds, setLibrary } = feedState();
  const startChange = markChanges();
  const answers: Array<() => void> = [];
  let unmarked = 0;
  const unmark = (afterWrite: boolean) => unmarkRead('p2', {
    setReadIds,
    setLibrary,
    write: () => new Promise<void>((accept) => { answers.push(accept); }),
    onUnmarked: () => { unmarked += 1; },
    onRestored: () => { assert.fail('nothing was refused'); },
    throwOnError: true,
    afterWrite,
    stillSignedIn: () => true,
    stillNewest: startChange('read:p2'),
    stillRead: () => state.readIds.has('p2'),
  });

  const removal = unmark(true);
  // The open card still shows the paper read: its toggle takes the mark off,
  // then puts it back the way markAsRead does.
  const cardUnmark = unmark(false);
  startChange('read:p2');
  setReadIds((ids) => new Set(ids).add('p2'));
  setLibrary((library) => ({ ...library, p2: { ...library.p2, readAt: '2026-10-26T09:00:00.000Z' } }));
  answers.forEach((accept) => accept());
  await Promise.all([removal, cardUnmark]);

  assert.deepEqual([...state.readIds].sort(), ['p1', 'p2'], 'the paper is still in Reading history');
  assert.equal(state.library.p2.readAt, '2026-10-26T09:00:00.000Z', 'with the time it was marked read again');
  assert.equal(unmarked, 1, 'the profile hears only the card\'s unmark');
});
