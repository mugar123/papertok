import test from 'node:test';
import assert from 'node:assert/strict';
import { removePaperFromList } from './remove-paper-from-list.ts';

type List = { id: string; name: string; paperIds?: string[]; updatedAt?: unknown };

const ownLists = (): List[] => [
  { id: 'list_1', name: 'Reading group', paperIds: ['p1', 'p2', 'p3'] },
  { id: 'list_2', name: 'Methods', paperIds: ['p2'] },
];

// The screen's `setLists`: the updater runs against whatever is on screen now.
const screen = (initial: List[]) => {
  const state = { lists: initial };
  const apply = (update: (lists: List[]) => List[]) => { state.lists = update(state.lists); };
  return { state, apply };
};

test('a refused write leaves the list as it was and tells the owner', async () => {
  const { state, apply } = screen(ownLists());
  const failures: unknown[] = [];
  const refused = new Error('permission-denied');
  await removePaperFromList('list_1', 'p2', {
    write: () => Promise.reject(refused),
    apply,
    onFailed: (error) => { failures.push(error); },
  });
  assert.deepEqual(state.lists, ownLists());
  assert.deepEqual(failures, [refused]);
});

test('a write that throws before it reaches the server is reported the same way', async () => {
  const { state, apply } = screen(ownLists());
  const failures: string[] = [];
  await removePaperFromList('list_1', 'p2', {
    write: () => { throw new Error('signed out'); },
    apply,
    onFailed: (error) => { failures.push((error as Error).message); },
  });
  assert.deepEqual(state.lists, ownLists());
  assert.deepEqual(failures, ['signed out']);
});

test('the paper leaves only when the server has accepted the removal', async () => {
  const { state, apply } = screen(ownLists());
  let accept!: () => void;
  const pending = removePaperFromList('list_1', 'p2', {
    write: () => new Promise<void>((resolve) => { accept = resolve; }),
    apply,
    onFailed: () => { assert.fail('the write was accepted'); },
  });
  assert.deepEqual(state.lists, ownLists(), 'still listed while the write is in flight');
  accept();
  await pending;
  assert.deepEqual(state.lists[0].paperIds, ['p1', 'p3']);
});

test('an accepted removal stamps this list only and leaves the others alone', async () => {
  const { state, apply } = screen(ownLists());
  const before = Date.now();
  await removePaperFromList('list_1', 'p2', {
    write: () => Promise.resolve(),
    apply,
    onFailed: () => { assert.fail('the write was accepted'); },
  });
  const [edited, untouched] = state.lists;
  assert.ok(edited.updatedAt instanceof Date && edited.updatedAt.getTime() >= before);
  assert.deepEqual(untouched, ownLists()[1]);
});
