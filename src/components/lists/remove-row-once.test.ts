import test from 'node:test';
import assert from 'node:assert/strict';
import type { MarkWriteOptions } from '../../context/write-mark.ts';
import { writeMark } from '../../context/write-mark.ts';
import { removePaperFromMarkList } from './remove-paper-from-mark-list.ts';
import { removeRowOnce, rowRemovalKey } from './remove-row-once.ts';

type Paper = { id: string };

// The Lists page's pending removals, held the way React state holds them.
function pendingRemovals() {
  let pending: ReadonlySet<string> = new Set();
  return {
    current: () => pending,
    set: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => { pending = update(pending); },
  };
}

// A Favorites unlike the way FeedContext sends it: each call writes, and each
// accepted write records an unlike in the reading profile.
function favorites() {
  const writes: Array<() => void> = [];
  let unlikes = 0;
  const toggleLike = (paper: Paper, options: MarkWriteOptions) => writeMark({
    show: () => { unlikes += 1; },
    write: () => new Promise<void>((accept) => { writes.push(accept); }),
    failure: 'refused',
    ...options,
    stillSignedIn: () => true,
  });
  const unused = () => Promise.reject(new Error('not this list'));
  const remove = () => removePaperFromMarkList('__favorites__', 'p1', { id: 'p1' }, {
    toggleLike, unmarkAsRead: unused, toggleReadLater: unused, onFailed: () => assert.fail('accepted'),
  })!;
  return { writes, unlikes: () => unlikes, remove };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

test('a second Remove on a Favorites row whose removal is pending sends no second unlike', async () => {
  const pending = pendingRemovals();
  const { writes, unlikes, remove } = favorites();
  const key = rowRemovalKey('__favorites__', 'p1');

  removeRowOnce(pending.current(), pending.set, key, remove);
  assert.ok(pending.current().has(key), 'the row shows its removal is pending');
  removeRowOnce(pending.current(), pending.set, key, remove);
  assert.equal(writes.length, 1);

  writes[0]();
  await settle();
  assert.equal(unlikes(), 1);
  assert.equal(pending.current().has(key), false, 'the row is no longer pending once the write answers');
});

test('once a removal has answered (a refusal included), the row can be removed again', async () => {
  const pending = pendingRemovals();
  const key = rowRemovalKey('__favorites__', 'p1');
  let tries = 0;
  removeRowOnce(pending.current(), pending.set, key, async () => { tries += 1; });
  await settle();
  removeRowOnce(pending.current(), pending.set, key, async () => { tries += 1; });
  await settle();
  assert.equal(tries, 2);
});

test('the same paper can be removed from two lists at once', () => {
  const pending = pendingRemovals();
  let started = 0;
  const never = () => { started += 1; return new Promise<void>(() => {}); };
  removeRowOnce(pending.current(), pending.set, rowRemovalKey('__favorites__', 'p1'), never);
  removeRowOnce(pending.current(), pending.set, rowRemovalKey('list-1', 'p1'), never);
  assert.equal(started, 2);
});
