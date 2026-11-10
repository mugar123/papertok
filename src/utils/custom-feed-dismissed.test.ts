import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DISMISSED_PER_FEED, forgetDismissed, readDismissed, saveDismissed } from './custom-feed-dismissed.ts';
import { clearUserScopedStorage, getCustomFeedDismissedStorageKey } from './user-scoped-storage.ts';

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('a feed remembers the newest two hundred papers removed from it, and the account\'s sign-out forgets them', () => {
  const storage = createStorage();
  const removed = Array.from({ length: MAX_DISMISSED_PER_FEED + 1 }, (_, index) => `paper-${index}`);
  saveDismissed('uid-1', 'abcd1234', removed, storage);
  assert.equal(MAX_DISMISSED_PER_FEED, 200);
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), removed.slice(1));

  clearUserScopedStorage('uid-1', storage);
  assert.deepEqual(readDismissed('uid-1', 'abcd1234', storage), []);
});

test('each feed and each account keeps its own removed papers, and forgetting one feed leaves the others', () => {
  const storage = createStorage();
  saveDismissed('uid-1', 'abcd1234', ['paper-a'], storage);
  saveDismissed('uid-1', 'efgh5678', ['paper-b'], storage);
  saveDismissed('uid-2', 'abcd1234', ['paper-c'], storage);

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
