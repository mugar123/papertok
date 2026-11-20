import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DISMISSED_PER_FEED,
  changeDismissed,
  forgetDismissed,
  readDismissed,
  subscribeDismissed,
} from './custom-feed-dismissed.ts';
import { clearUserScopedStorage, getCustomFeedDismissedStorageKey } from './user-scoped-storage.ts';

function createStorage() {
  const values = new Map<string, string>();
  return {
    full: false,
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) {
      if (this.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      values.set(key, value);
    },
    removeItem: (key: string) => { values.delete(key); },
  };
}

type DeviceStorage = ReturnType<typeof createStorage>;

// What the feed's Not interested and its Undo do to the list.
const dismiss = (uid: string, feedId: string, paperId: string, storage: DeviceStorage) => {
  changeDismissed(uid, feedId, ids => [...ids.filter(id => id !== paperId), paperId], storage);
};
const restore = (uid: string, feedId: string, paperId: string, storage: DeviceStorage) => {
  changeDismissed(uid, feedId, ids => ids.filter(id => id !== paperId), storage);
};

test('a feed remembers the newest two hundred papers removed from it, and the account\'s sign-out forgets them', () => {
  const storage = createStorage();
  const removed = Array.from({ length: MAX_DISMISSED_PER_FEED + 1 }, (_, index) => `paper-${index}`);
  changeDismissed('uid-1', 'abcd1234', () => removed, storage);
  assert.equal(MAX_DISMISSED_PER_FEED, 200);
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), removed.slice(1));

  clearUserScopedStorage('uid-1', storage);
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), []);
});

test('each feed and each account keeps its own removed papers, and forgetting one feed leaves the others', () => {
  const storage = createStorage();
  dismiss('uid-1', 'abcd1234', 'paper-a', storage);
  dismiss('uid-1', 'efgh5678', 'paper-b', storage);
  dismiss('uid-2', 'abcd1234', 'paper-c', storage);

  forgetDismissed('uid-1', 'abcd1234', storage);
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), []);
  assert.deepEqual(readDismissed('uid-1', 'efgh5678', storage), ['paper-b']);
  assert.deepEqual(readDismissed('uid-2', 'abcd1234', storage), ['paper-c']);
});

test('malformed stored content reads as no removed papers', () => {
  const storage = createStorage();
  const key = getCustomFeedDismissedStorageKey('uid-1')!;
  for (const stored of ['not json', '["paper-a"]', '{"abcd1234":"paper-a"}', 'null']) {
    storage.setItem(key, stored);
    assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), [], stored);
  }
  storage.setItem(key, '{"abcd1234":["paper-a",7,null]}');
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), ['paper-a']);
});

// Paper X removed, the reader leaves the feed and comes back, removes Y, then
// presses the Undo of X, whose toast outlived the first visit.
test('an Undo from an earlier visit takes its paper back from the list as it is now, and the visit on screen hears it', () => {
  const storage = createStorage();
  dismiss('uid-3', 'abcd1234', 'paper-x', storage);
  const shown: string[][] = [];
  const stop = subscribeDismissed('uid-3', 'abcd1234', () => { shown.push(readDismissed('uid-3', 'abcd1234', storage)); });
  dismiss('uid-3', 'abcd1234', 'paper-y', storage);
  restore('uid-3', 'abcd1234', 'paper-x', storage);
  stop();
  assert.deepEqual(readDismissed('uid-3', 'abcd1234', storage), ['paper-y'], 'Y stays removed and X is back');
  assert.deepEqual(shown, [['paper-x', 'paper-y'], ['paper-y']], 'the visit on screen showed each change');
});

test('a change to another feed or another account is not heard, and one heard no more after unsubscribing', () => {
  const storage = createStorage();
  let heard = 0;
  const stop = subscribeDismissed('uid-4', 'abcd1234', () => { heard += 1; });
  dismiss('uid-4', 'efgh5678', 'paper-a', storage);
  dismiss('uid-5', 'abcd1234', 'paper-a', storage);
  assert.equal(heard, 0);
  dismiss('uid-4', 'abcd1234', 'paper-a', storage);
  assert.equal(heard, 1);
  stop();
  restore('uid-4', 'abcd1234', 'paper-a', storage);
  assert.equal(heard, 1);
});

// React's useSyncExternalStore renders again whenever the list it reads is a
// different object, so an unchanged list has to read as the same one.
test('a visit reads what another tab stored, and the same list while nothing changed', () => {
  const storage = createStorage();
  dismiss('uid-6', 'abcd1234', 'paper-a', storage);
  const first = readDismissed('uid-6', 'abcd1234', storage);
  assert.equal(readDismissed('uid-6', 'abcd1234', storage), first);
  storage.setItem(getCustomFeedDismissedStorageKey('uid-6')!, '{"abcd1234":["paper-a","paper-b"]}');
  assert.deepEqual(readDismissed('uid-6', 'abcd1234', storage), ['paper-a', 'paper-b']);
});

test('a removal that full storage could not keep stays for the session', () => {
  const storage = createStorage();
  dismiss('uid-7', 'abcd1234', 'paper-a', storage);
  storage.full = true;
  dismiss('uid-7', 'abcd1234', 'paper-b', storage);
  assert.deepEqual(readDismissed('uid-7', 'abcd1234', storage), ['paper-a', 'paper-b'], 'a visit later in the session still leaves both out');
  storage.full = false;
  dismiss('uid-7', 'abcd1234', 'paper-c', storage);
  const key = getCustomFeedDismissedStorageKey('uid-7')!;
  assert.deepEqual(JSON.parse(storage.getItem(key)!), { abcd1234: ['paper-a', 'paper-b', 'paper-c'] }, 'the next change with room stores the whole list');
  storage.setItem(key, '{"abcd1234":["paper-d"]}');
  assert.deepEqual(readDismissed('uid-7', 'abcd1234', storage), ['paper-d'], 'and storage holds the list again, another tab\'s changes included');
});
