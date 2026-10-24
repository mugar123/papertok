import test from 'node:test';
import assert from 'node:assert/strict';
import { readRecentSearches, updateRecentSearches } from './recent-searches.ts';

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

test('recents belong to a UID; guests neither read nor write another account', () => {
  const store = storage();
  updateRecentSearches('alice', 'Quantum gravity', false, store);
  updateRecentSearches('bob', 'Human Brain Project', false, store);
  assert.deepEqual(readRecentSearches('alice', store), ['Quantum gravity']);
  assert.deepEqual(readRecentSearches('bob', store), ['Human Brain Project']);
  assert.deepEqual(updateRecentSearches(undefined, 'Private guest query', false, store), []);
  assert.deepEqual(readRecentSearches(undefined, store), []);
  assert.equal(store.getItem('papertok_recentSearches_undefined'), null);
});

test('only the last five distinct queries persist, with the newest first', () => {
  const store = storage();
  for (const query of ['one', 'two', 'three', 'four', 'five', 'six', ' THREE ']) updateRecentSearches('user', query, false, store);
  assert.deepEqual(readRecentSearches('user', store), ['THREE', 'six', 'five', 'four', 'two']);
});

test('removing a query persists for that user without affecting another user', () => {
  const store = storage();
  for (const uid of ['alice', 'bob']) updateRecentSearches(uid, 'Quantum gravity', false, store);
  updateRecentSearches('alice', 'Quantum gravity', true, store);
  assert.deepEqual(readRecentSearches('alice', store), []);
  assert.deepEqual(readRecentSearches('bob', store), ['Quantum gravity']);
});

test('malformed or unavailable storage does not invent recent searches or break the field', () => {
  const store = storage();
  store.setItem('papertok_recentSearches_user', '{');
  assert.deepEqual(readRecentSearches('user', store), []);
  const blocked = { getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Unavailable'); } };
  assert.deepEqual(readRecentSearches('user', blocked), []);
  assert.deepEqual(updateRecentSearches('user', 'A new query', false, blocked), ['A new query']);
});
