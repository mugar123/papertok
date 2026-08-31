import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearUserScopedStorage,
  getFollowStatsStorageKey,
  getOnboardingStorageKey,
  getOwnListsStorageKey,
  getOwnProfileStorageKey,
  getSeenPapersStorageKey,
  readSeenPaperIds,
  readStoredFollowStats,
  readStoredLists,
  readStoredOnboarding,
  readStoredProfile,
  removeLegacySeenPaperIds,
  saveSeenPaperIds,
  saveStoredFollowStats,
  saveStoredLists,
  saveStoredOnboarding,
  saveStoredProfile,
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

/* --- The owner's lists, remembered across reloads ------------------------- */

const listStore = () => {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    get length() { return map.size; },
    key: index => [...map.keys()][index] ?? null,
  };
};

const aList = (id, papers = 2) => ({
  id, name: `List ${id}`, emoji: 'Folder', color: 'teal',
  paperIds: Array.from({ length: papers }, (_, i) => `${id}_p${i}`),
  publicShareId: null,
  updatedAt: '2026-08-27T00:00:00.000Z',
  publicSyncedAt: '2026-08-26T00:00:00.000Z',
});

test('a stored list comes back whole, and nothing else comes back at all', () => {
  const storage = listStore();
  saveStoredLists('uid-l1', [aList('a'), aList('b')], storage);

  const read = readStoredLists('uid-l1', storage);
  assert.equal(read.length, 2);
  assert.deepEqual(read[0].paperIds, ['a_p0', 'a_p1'], 'opening a seeded card must not find it empty');
  assert.equal(read[0].name, 'List a');
  assert.equal(read[0].color, 'teal');

  // The sync clocks are deliberately not stored: read back from a previous
  // session they would tell the freshness check something nobody confirmed.
  assert.equal('updatedAt' in read[0], false);
  assert.equal('publicSyncedAt' in read[0], false);
});

test('nothing stored, or nonsense stored, reads as "no answer" rather than "no lists"', () => {
  const storage = listStore();
  assert.equal(readStoredLists('uid-l2', storage), null);

  storage.setItem(getOwnListsStorageKey('uid-l2'), 'not json at all');
  assert.equal(readStoredLists('uid-l2', storage), null);

  storage.setItem(getOwnListsStorageKey('uid-l2'), '{"not":"an array"}');
  assert.equal(readStoredLists('uid-l2', storage), null);

  // An entry with no paper ids cannot be opened, so it is not an entry.
  storage.setItem(getOwnListsStorageKey('uid-l2'), '[{"id":"x","name":"X"}]');
  assert.equal(readStoredLists('uid-l2', storage), null);

  assert.equal(readStoredLists(null, storage), null);
  assert.equal(readStoredLists('uid-l2', null), null);
});

test('the budget drops whole lists, never half of one', () => {
  const storage = listStore();
  // Three lists that cannot all fit: the last is left out entirely rather than
  // stored without the ids that make it openable.
  const lists = [aList('a', 40), aList('b', 40), aList('c', 40)];
  const oneFits = JSON.stringify({
    id: 'a', name: 'List a', emoji: 'Folder', color: 'teal',
    paperIds: lists[0].paperIds, publicShareId: null,
  }).length;
  saveStoredLists('uid-l3', lists, storage, oneFits * 2 + 4);

  const read = readStoredLists('uid-l3', storage);
  assert.ok(read.length < 3, 'the budget must actually bite');
  for (const entry of read) {
    assert.equal(entry.paperIds.length, 40, 'every stored list keeps all of its ids');
  }
});

test('an empty answer clears the key instead of leaving the old one standing', () => {
  const storage = listStore();
  saveStoredLists('uid-l4', [aList('a')], storage);
  assert.ok(readStoredLists('uid-l4', storage));

  // The owner deleted their last list. The seed must not resurrect it.
  saveStoredLists('uid-l4', [], storage);
  assert.equal(readStoredLists('uid-l4', storage), null);
});

test('storage that throws is survivable', () => {
  const hostile = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('full'); },
    removeItem: () => { throw new Error('blocked'); },
    length: 0,
    key: () => null,
  };
  assert.doesNotThrow(() => saveStoredLists('uid-l5', [aList('a')], hostile));
  assert.equal(readStoredLists('uid-l5', hostile), null);
});

test('signing out takes the lists with it', () => {
  const storage = listStore();
  saveStoredLists('uid-l6', [aList('a')], storage);
  assert.ok(readStoredLists('uid-l6', storage));

  clearUserScopedStorage('uid-l6', storage);
  assert.equal(readStoredLists('uid-l6', storage), null,
    'another account on this device must never be seeded with these');
});

test('the owner public profile is remembered without its photo', () => {
  const storage = listStore();
  saveStoredProfile('uid-p1', {
    uid: 'uid-p1',
    handle: 'alice',
    displayName: 'Alice',
    bio: 'Hello',
    photo: 'data:image/png;base64,AAAA',
    visibility: 'public',
    createdAt: '2026-03-01T00:00:00.000Z',
  }, storage);
  const read = readStoredProfile('uid-p1', storage);
  assert.equal(read.handle, 'alice');
  assert.equal(read.displayName, 'Alice');
  assert.equal(read.photo, undefined);
  assert.equal(read.createdAt, '2026-03-01T00:00:00.000Z');
  assert.equal(readStoredProfile('uid-p1', null), null);

  clearUserScopedStorage('uid-p1', storage);
  assert.equal(readStoredProfile('uid-p1', storage), null);
  assert.ok(getOwnProfileStorageKey('uid-p1').includes('ownProfile'));
});

test('onboarding completion survives a reload, per account', () => {
  const storage = listStore();
  saveStoredOnboarding('uid-o1', { complete: true, preferences: ['astro'] }, storage);
  assert.deepEqual(readStoredOnboarding('uid-o1', storage), {
    complete: true,
    preferences: ['astro'],
  });
  assert.equal(readStoredOnboarding('uid-o2', storage), null);
  assert.ok(getOnboardingStorageKey('uid-o1').includes('onboarding'));

  clearUserScopedStorage('uid-o1', storage);
  assert.equal(readStoredOnboarding('uid-o1', storage), null);
});
