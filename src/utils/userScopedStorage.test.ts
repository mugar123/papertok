import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearUserScopedStorage,
  getLocalHiddenStorageKey,
  getOnboardingStorageKey,
  getOwnListsStorageKey,
  getSeenPapersStorageKey,
  readSeenPaperIds,
  readStoredLists,
  readStoredOnboarding,
  removeLegacySeenPaperIds,
  saveSeenPaperIds,
  saveStoredLists,
  saveStoredOnboarding,
} from './userScopedStorage.ts';

function createStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
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
 * The removed profile page remembered its follow counters under
 * `papertok_followStats:{uid}`. Nothing writes that key any more, but devices
 * that stored one still lose it when that account signs out.
 */

test('signing out takes the legacy follow counters with everything else', () => {
  const storage = createStorage();

  storage.setItem('papertok_followStats:user-g', JSON.stringify({ followers: { count: 43, capped: false } }));
  storage.setItem('papertok_followStats:user-h', JSON.stringify({ followers: { count: 2, capped: false } }));
  saveSeenPaperIds('user-g', new Set(['paper-a']), storage);

  clearUserScopedStorage('user-g', storage);

  assert.equal(storage.getItem('papertok_followStats:user-g'), null);
  assert.ok(storage.getItem('papertok_followStats:user-h'), 'another account keeps its own key');
  assert.deepEqual([...readSeenPaperIds('user-g', storage)], []);
});

/**
 * The removed public-profile editor remembered the owner's profile under
 * `papertok_ownProfile:{uid}`. Nothing writes that key any more either.
 */

test('signing out takes the legacy stored profile with everything else', () => {
  const storage = createStorage();

  storage.setItem('papertok_ownProfile:user-i', JSON.stringify({ uid: 'user-i', handle: 'alice', displayName: 'Alice' }));
  storage.setItem('papertok_ownProfile:user-j', JSON.stringify({ uid: 'user-j', handle: 'bob', displayName: 'Bob' }));

  clearUserScopedStorage('user-i', storage);

  assert.equal(storage.getItem('papertok_ownProfile:user-i'), null);
  assert.ok(storage.getItem('papertok_ownProfile:user-j'), 'another account keeps its own key');
});

/* --- The owner's lists, remembered across reloads ------------------------- */

const listStore = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => map.set(key, String(value)),
    removeItem: (key: string) => map.delete(key),
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
  };
};

const aList = (id: string, papers = 2) => ({
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
  assert.equal(read!.length, 2);
  assert.deepEqual(read![0].paperIds, ['a_p0', 'a_p1'], 'opening a seeded card must not find it empty');
  assert.equal(read![0].name, 'List a');
  assert.equal(read![0].color, 'teal');

  // The sync clocks are deliberately not stored: read back from a previous
  // session they would tell the freshness check something nobody confirmed.
  assert.equal('updatedAt' in read![0], false);
  assert.equal('publicSyncedAt' in read![0], false);
});

test('nothing stored, or nonsense stored, reads as "no answer" rather than "no lists"', () => {
  const storage = listStore();
  assert.equal(readStoredLists('uid-l2', storage), null);

  storage.setItem(getOwnListsStorageKey('uid-l2')!, 'not json at all');
  assert.equal(readStoredLists('uid-l2', storage), null);

  storage.setItem(getOwnListsStorageKey('uid-l2')!, '{"not":"an array"}');
  assert.equal(readStoredLists('uid-l2', storage), null);

  // An entry with no paper ids cannot be opened, so it is not an entry.
  storage.setItem(getOwnListsStorageKey('uid-l2')!, '[{"id":"x","name":"X"}]');
  assert.equal(readStoredLists('uid-l2', storage), null);

  assert.equal(readStoredLists(null!, storage), null);
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
  assert.ok(read!.length < 3, 'the budget must actually bite');
  for (const entry of read!) {
    assert.equal(entry.paperIds!.length, 40, 'every stored list keeps all of its ids');
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

test('onboarding completion survives a reload, per account', () => {
  const storage = listStore();
  saveStoredOnboarding('uid-o1', { complete: true, preferences: ['astro'] }, storage);
  assert.deepEqual(readStoredOnboarding('uid-o1', storage), {
    complete: true,
    preferences: ['astro'],
  });
  assert.equal(readStoredOnboarding('uid-o2', storage), null);
  assert.ok(getOnboardingStorageKey('uid-o1')!.includes('onboarding'));

  clearUserScopedStorage('uid-o1', storage);
  assert.equal(readStoredOnboarding('uid-o1', storage), null);
});

/* --- The hidden-comments list belongs to the account that hid them ---------
   It used to live under one global key, so it outlived its session on a shared
   browser: the next account inherited what the previous one had chosen not to
   see. Now the key carries the uid, and the sign-out that clears every other
   per-account cache clears this one too. */

test('clearUserScopedStorage drops the hidden-comments list', () => {
  const storage = createStorage();
  storage.setItem(getLocalHiddenStorageKey('alice')!, '["c1"]');
  storage.setItem(getLocalHiddenStorageKey('bob')!, '["c2"]');
  storage.setItem('papertok:locallyHiddenComments', '["legacy"]');

  clearUserScopedStorage('alice', storage);

  assert.equal(storage.getItem(getLocalHiddenStorageKey('alice')!), null);
  assert.equal(storage.getItem('papertok:locallyHiddenComments'), null,
    'the orphaned global key is never migrated, only swept away');
  assert.equal(storage.getItem(getLocalHiddenStorageKey('bob')!), '["c2"]',
    'and the other account on this browser keeps its own');
});

test('the hidden-comments key is namespaced by uid, and refuses to exist without one', () => {
  assert.equal(getLocalHiddenStorageKey('alice'), 'papertok:locallyHiddenComments:alice');
  assert.equal(getLocalHiddenStorageKey(''), null);
  assert.equal(getLocalHiddenStorageKey(null), null);
});

// Until the list kept only papers the reader viewed it held every paper a load
// showed, so it names cards that were never on screen. It also names every
// paper the reader viewed before, so the account's first viewed list starts
// from it once; a viewed list that already exists is not replaced.
test('the list written when it held every loaded paper starts the viewed list once, and is swept', () => {
  const storage = createStorage();
  storage.setItem('papertok_seenIds:user-a', JSON.stringify(['viewed-before-release', 'loaded-never-viewed']));
  storage.setItem('papertok_seenIds:user-b', JSON.stringify(['b-loaded']));

  assert.deepEqual([...readSeenPaperIds('user-a', storage)], [], 'the old list is not read as it is');
  removeLegacySeenPaperIds(storage, 'user-a');

  assert.deepEqual([...readSeenPaperIds('user-a', storage)], ['viewed-before-release', 'loaded-never-viewed'], 'nothing seen before the release is shown again');
  assert.equal(storage.getItem('papertok_seenIds:user-a'), null);
  assert.equal(storage.getItem('papertok_seenIds:user-b'), JSON.stringify(['b-loaded']), 'another account is left alone');
});

test('an existing viewed list is kept when an old list is swept', () => {
  const storage = createStorage();
  storage.setItem('papertok_seenIds:user-a', JSON.stringify(['loaded-never-viewed']));
  saveSeenPaperIds('user-a', new Set(['viewed']), storage);
  removeLegacySeenPaperIds(storage, 'user-a');

  assert.equal(storage.getItem('papertok_seenIds:user-a'), null);
  assert.deepEqual([...readSeenPaperIds('user-a', storage)], ['viewed'], 'the current list is not replaced or swept');
});

test('a corrupt old list is swept and starts nothing', () => {
  const storage = createStorage();
  storage.setItem('papertok_seenIds:user-a', '{not json');
  removeLegacySeenPaperIds(storage, 'user-a');

  assert.equal(storage.getItem('papertok_seenIds:user-a'), null);
  assert.deepEqual([...readSeenPaperIds('user-a', storage)], []);
});
