import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listsHolding,
  mergeCreatedLists,
  readOwnLists,
  snapshotIsAuthoritative,
  toProfileListCards,
  withPaperMembership,
} from './ownLists.js';

/**
 * The save-and-organize modal told an account with four lists that it had none
 * and offered to create one. Reproduced against the live backend: with the
 * connection down and a query target this page had not asked for before,
 * `getDocs` resolved — did not reject — with 0 documents, `fromCache: true`,
 * in 0.5 ms, and the modal rendered "You do not have any lists yet."
 *
 * These tests are that bug, and the shape of every read in this family: an
 * absence is only real when the server is the one reporting it.
 */

function snapshot(documents, { fromCache = false } = {}) {
  return {
    empty: documents.length === 0,
    size: documents.length,
    metadata: { fromCache },
    forEach: (callback) => documents.forEach(
      ({ id, ...data }) => callback({ id, data: () => data }),
    ),
  };
}

const LISTS = [
  { id: 'list_1', name: 'Papers de azúcar', paperIds: ['2006.02185', '2005.13905'] },
  { id: 'list_2', name: 'Relatividad numérica', paperIds: [] },
];

test('THE BUG: opening the modal with existing lists finds them', () => {
  const result = readOwnLists(snapshot(LISTS), '2006.02185');

  assert.equal(result.authoritative, true);
  assert.deepEqual(result.lists.map(list => list.name), ['Papers de azúcar', 'Relatividad numérica']);
  assert.deepEqual([...result.inLists], ['list_1'], 'the paper is checked in the list that holds it');
});

test('a cache-served empty answer is NOT an account without lists', () => {
  const result = readOwnLists(snapshot([], { fromCache: true }), '2006.02185');

  assert.equal(
    result.authoritative,
    false,
    'nobody confirmed this account has no lists — the backend never answered',
  );
});

test('an empty answer the server confirmed is a real empty account', () => {
  const result = readOwnLists(snapshot([], { fromCache: false }), '2006.02185');

  assert.equal(result.authoritative, true);
  assert.deepEqual(result.lists, []);
});

test('lists served from cache are still lists', () => {
  // Stale data beats a spinner, and the revalidation behind it corrects it.
  // Only an *absence* has to come from the server.
  const result = readOwnLists(snapshot(LISTS, { fromCache: true }), '2005.13905');

  assert.equal(result.authoritative, true);
  assert.equal(result.lists.length, 2);
  assert.deepEqual([...result.inLists], ['list_1']);
});

test('a snapshot that never arrived is not an answer', () => {
  assert.equal(snapshotIsAuthoritative(undefined), false);
  assert.equal(snapshotIsAuthoritative(null), false);
});

test('membership is computed per paper, not carried over', () => {
  const other = readOwnLists(snapshot(LISTS), 'not-in-any-list');
  assert.deepEqual([...other.inLists], []);

  const none = readOwnLists(snapshot(LISTS), undefined);
  assert.deepEqual([...none.inLists], [], 'no paper means no membership to compute');
  assert.equal(none.lists.length, 2, 'but the lists are still returned');
});

test('a snapshot reporting size but no `empty` flag is still read correctly', () => {
  // Not every snapshot-shaped object carries `empty`; falling back to `size`
  // keeps the rule from silently inverting on one.
  const bare = {
    size: 0,
    metadata: { fromCache: true },
    forEach: () => {},
  };
  assert.equal(snapshotIsAuthoritative(bare), false);
});

// ---------------------------------------------------------------------------
// The session cache the save modal paints from. Saving fifty papers in a row
// used to re-read all sixty list documents fifty times; painting from a cache
// removes that, and creates one obligation in exchange — the cache has to
// learn what the save just wrote.

test('membership can be asked of lists that never came from a snapshot', () => {
  const lists = [
    { id: 'a', paperIds: ['p1', 'p2'] },
    { id: 'b', paperIds: [] },
    { id: 'c' },
  ];
  assert.deepEqual([...listsHolding(lists, 'p1')], ['a']);
  assert.deepEqual([...listsHolding(lists, 'p9')], []);
  assert.deepEqual([...listsHolding(lists, null)], [], 'no paper, no membership');
  assert.deepEqual([...listsHolding(null, 'p1')], []);
});

test('THE REGRESSION THE CACHE COULD CAUSE: a save must be visible on reopen', () => {
  const cached = [{ id: 'a', paperIds: [] }, { id: 'b', paperIds: ['p1'] }];
  const after = withPaperMembership(cached, 'p1', { added: ['a'], removed: ['b'] });

  // Reopening the modal on the same paper reads membership off the cache, so
  // this is exactly what the checkboxes will show.
  assert.deepEqual([...listsHolding(after, 'p1')], ['a']);
});

test('the write-through mirrors arrayUnion and arrayRemove, idempotently', () => {
  const lists = [{ id: 'a', paperIds: ['p1'] }, { id: 'b', paperIds: [] }];

  const addedTwice = withPaperMembership(
    withPaperMembership(lists, 'p1', { added: ['a'] }), 'p1', { added: ['a'] },
  );
  assert.deepEqual(addedTwice[0].paperIds, ['p1'], 'adding a present id is a no-op');

  const removedTwice = withPaperMembership(
    withPaperMembership(lists, 'p1', { removed: ['b'] }), 'p1', { removed: ['b'] },
  );
  assert.deepEqual(removedTwice[1].paperIds, [], 'removing an absent id is a no-op');
});

test('the write-through copies rather than mutates the cached array', () => {
  const lists = [{ id: 'a', paperIds: ['p1'] }, { id: 'b', paperIds: [] }];
  const before = JSON.stringify(lists);
  const after = withPaperMembership(lists, 'p2', { added: ['b'] });

  assert.equal(JSON.stringify(lists), before, 'the entry on screen is shared; leave it alone');
  assert.notEqual(after, lists);
  assert.equal(after[0], lists[0], 'an untouched list keeps its identity');
  assert.deepEqual(after[1].paperIds, ['p2']);
});

test('a save that changed nothing returns the very same array', () => {
  const lists = [{ id: 'a', paperIds: [] }];
  assert.equal(withPaperMembership(lists, 'p1', {}), lists);
  assert.equal(withPaperMembership(lists, 'p1', { added: [], removed: [] }), lists);
  assert.equal(withPaperMembership(lists, null, { added: ['a'] }), lists);
});

test('a list the cache does not know about is left alone', () => {
  const lists = [{ id: 'a', paperIds: [] }];
  const after = withPaperMembership(lists, 'p1', { added: ['ghost'] });
  assert.deepEqual(after, lists, 'no phantom entries invented for an unknown id');
});

/* --- A list created while the read was in flight ----------------------------
   The "Create a new list" button is on screen from the first frame, before the
   lists have landed. The document is written straight away, but the `getDocs`
   already on the wire was issued BEFORE it existed, so its snapshot cannot
   contain it. Applying that snapshot wholesale wiped the list the user had
   just made off the screen AND out of the shared session cache — which
   `rememberOwnLists` then stamped fresh, so every other screen agreed it did
   not exist for the next thirty seconds. */

test('THE BUG: a list created during the read survives the snapshot that predates it', () => {
  const fetched = [{ id: 'list_1', name: 'A', paperIds: [] }];
  const created = [{ id: 'list_2', name: 'Just made', paperIds: [] }];

  const merged = mergeCreatedLists(fetched, created);
  assert.deepEqual(merged.map(list => list.id), ['list_1', 'list_2']);
  assert.equal(merged[1].name, 'Just made');
});

test('a snapshot that has caught up does not duplicate the created list', () => {
  const fetched = [
    { id: 'list_1', name: 'A', paperIds: [] },
    { id: 'list_2', name: 'Renamed on another device', paperIds: ['p1'] },
  ];
  const created = [{ id: 'list_2', name: 'Just made', paperIds: [] }];

  const merged = mergeCreatedLists(fetched, created);
  assert.deepEqual(merged.map(list => list.id), ['list_1', 'list_2']);
  assert.equal(merged[1].name, 'Renamed on another device', 'the server wins once it knows');
  assert.equal(merged, fetched, 'nothing to merge means the very same array');
});

test('merging nothing returns the fetched lists untouched', () => {
  const fetched = [{ id: 'list_1', paperIds: [] }];
  assert.equal(mergeCreatedLists(fetched, []), fetched);
  assert.equal(mergeCreatedLists(fetched, null), fetched);
});

test('toProfileListCards maps full documents without inventing titles', () => {
  const cards = toProfileListCards([
    { id: 'a', name: 'Notes', paperIds: ['p1', 'p2'], publicShareId: 'share1', color: '#111' },
    { id: 'b', title: 'Already a card', paperCount: 4, isPublished: true },
    { id: '', name: 'No id', paperIds: [] },
    { id: 'c', name: '', paperIds: [] },
  ]);
  assert.deepEqual(cards.map(card => [card.id, card.title, card.paperCount, card.isPublished]), [
    ['a', 'Notes', 2, true],
    ['b', 'Already a card', 4, true],
  ]);
  assert.equal(cards[0].color, '#111');
});
