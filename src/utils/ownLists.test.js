import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnLists, snapshotIsAuthoritative } from './ownLists.js';

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
