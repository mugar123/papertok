import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionCache } from './sessionCache.js';

test('stores and returns values by key', () => {
  const cache = createSessionCache();
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('missing'), undefined);
});

test('evicts the least recently used entry past maxEntries', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');       // 'a' is now the fresher of the two
  cache.set('c', 3);    // evicts 'b', not 'a'
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('set refreshes recency and replaces the value', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10);   // refreshed: 'b' is now the oldest
  cache.set('c', 3);
  assert.equal(cache.get('a'), 10);
  assert.equal(cache.get('b'), undefined);
});

test('delete and clear remove entries', () => {
  const cache = createSessionCache();
  cache.set('a', 1);
  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
  cache.set('b', 2);
  cache.clear();
  assert.equal(cache.get('b'), undefined);
});
