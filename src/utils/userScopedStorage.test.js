import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSeenPapersStorageKey,
  readSeenPaperIds,
  removeLegacySeenPaperIds,
  saveSeenPaperIds,
} from './userScopedStorage.js';

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('seen-paper history is isolated by user id', () => {
  const storage = createStorage();

  saveSeenPaperIds('user-a', new Set(['paper-a']), storage);
  saveSeenPaperIds('user-b', new Set(['paper-b']), storage);

  assert.deepEqual([...readSeenPaperIds('user-a', storage)], ['paper-a']);
  assert.deepEqual([...readSeenPaperIds('user-b', storage)], ['paper-b']);
  assert.notEqual(getSeenPapersStorageKey('user-a'), getSeenPapersStorageKey('user-b'));
});

test('seen-paper history is capped without mixing accounts', () => {
  const storage = createStorage();

  saveSeenPaperIds('user-a', new Set(['one', 'two', 'three']), storage, 2);

  assert.deepEqual([...readSeenPaperIds('user-a', storage)], ['two', 'three']);
  assert.deepEqual([...readSeenPaperIds(null, storage)], []);
});

test('legacy shared history is removed without deleting scoped histories', () => {
  const storage = createStorage();
  storage.setItem('papertok_seenIds', JSON.stringify(['shared-paper']));
  saveSeenPaperIds('user-a', new Set(['private-paper']), storage);

  removeLegacySeenPaperIds(storage);

  assert.equal(storage.getItem('papertok_seenIds'), null);
  assert.deepEqual([...readSeenPaperIds('user-a', storage)], ['private-paper']);
});

