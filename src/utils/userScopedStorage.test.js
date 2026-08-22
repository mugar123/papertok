import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearUserScopedStorage,
  getFollowStatsStorageKey,
  getSeenPapersStorageKey,
  readSeenPaperIds,
  readStoredFollowStats,
  removeLegacySeenPaperIds,
  saveSeenPaperIds,
  saveStoredFollowStats,
} from './userScopedStorage.js';

function createStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
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

test('logout removes only the current user personal caches', () => {
  const storage = createStorage();
  storage.setItem('papertok_seenIds:user-a', '[]');
  storage.setItem('papertok_seenIds:user-b', '[]');
  storage.setItem('papertok_feed_snapshot_user-a_physics', '{}');
  storage.setItem('papertok_feed_snapshot_user-b_physics', '{}');
  storage.setItem('papertok_following_user-a', '[]');
  storage.setItem('papertok_following_updates_user-a', '{}');
  storage.setItem('papertok_language', 'en');

  clearUserScopedStorage('user-a', storage);

  assert.equal(storage.getItem('papertok_seenIds:user-a'), null);
  assert.equal(storage.getItem('papertok_feed_snapshot_user-a_physics'), null);
  assert.equal(storage.getItem('papertok_following_user-a'), null);
  assert.equal(storage.getItem('papertok_following_updates_user-a'), null);
  assert.equal(storage.getItem('papertok_seenIds:user-b'), '[]');
  assert.equal(storage.getItem('papertok_feed_snapshot_user-b_physics'), '{}');
  assert.equal(storage.getItem('papertok_language'), 'en');
});

/**
 * The follow counters of your own profile, remembered across a reload.
 *
 * The session cache spares every re-entry within a tab but dies with it, and a
 * `count()` aggregation is server-only — so the first visit after a reload had
 * no local answer of any kind and said so with an ellipsis. This is the seed
 * that closes that last gap.
 */

test('follow counters survive a reload, per account', () => {
  const storage = createStorage();

  saveStoredFollowStats('user-a', {
    followers: { count: 43, capped: false },
    followed: { count: 7, capped: true },
  }, storage);
  saveStoredFollowStats('user-b', { followers: { count: 0, capped: false } }, storage);

  assert.deepEqual(readStoredFollowStats('user-a', storage), {
    followers: { count: 43, capped: false },
    followed: { count: 7, capped: true },
  });
  assert.deepEqual(readStoredFollowStats('user-b', storage).followers, { count: 0, capped: false });
  assert.equal(readStoredFollowStats('user-b', storage).followed, null, 'a counter never stored is not a zero');
  assert.equal(readStoredFollowStats('user-c', storage), null);
});

test('a counter that failed to read is not written, and rubbish does not come back', () => {
  const storage = createStorage();

  saveStoredFollowStats('user-d', {
    followers: { count: null, capped: false },
    followed: null,
  }, storage);
  assert.equal(readStoredFollowStats('user-d', storage), null, 'nothing worth keeping, nothing written');

  storage.setItem(getFollowStatsStorageKey('user-e'), '{ not json');
  assert.equal(readStoredFollowStats('user-e', storage), null);

  storage.setItem(getFollowStatsStorageKey('user-f'), JSON.stringify({ followers: { count: 'many' } }));
  assert.equal(readStoredFollowStats('user-f', storage), null, 'a count that is not a number is not a count');

  assert.equal(getFollowStatsStorageKey(null), null);
  assert.equal(readStoredFollowStats(null, storage), null);
});

test('signing out takes the follow counters with everything else', () => {
  const storage = createStorage();

  saveStoredFollowStats('user-g', { followers: { count: 43, capped: false } }, storage);
  saveSeenPaperIds('user-g', new Set(['paper-a']), storage);

  clearUserScopedStorage('user-g', storage);

  assert.equal(readStoredFollowStats('user-g', storage), null);
  assert.deepEqual([...readSeenPaperIds('user-g', storage)], []);
});
