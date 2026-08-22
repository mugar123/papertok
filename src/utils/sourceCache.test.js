import test from 'node:test';
import assert from 'node:assert/strict';
import { readSourceCache, writeSourceCache } from './sourceCache.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    _map: map,
  };
}

test('round-trips a value within its TTL', () => {
  const storage = fakeStorage();
  writeSourceCache('pubmed|q|1', { papers: [{ id: 'pmid:1' }], total: 1 }, storage);
  const hit = readSourceCache('pubmed|q|1', 60_000, storage);
  assert.deepEqual(hit, { papers: [{ id: 'pmid:1' }], total: 1 });
});

test('an expired entry reads as a miss', () => {
  const storage = fakeStorage();
  writeSourceCache('k', { papers: [] }, storage);
  const raw = JSON.parse(storage.getItem('papertok_source_cache_v1'));
  raw.k.t = Date.now() - 10 * 60 * 1000 - 1;
  storage.setItem('papertok_source_cache_v1', JSON.stringify(raw));
  assert.equal(readSourceCache('k', 10 * 60 * 1000, storage), null);
});

test('each read returns fresh objects, so callers may mutate results', () => {
  const storage = fakeStorage();
  writeSourceCache('k', { papers: [{ id: 'a' }] }, storage);
  const first = readSourceCache('k', 60_000, storage);
  first.papers[0].id = 'mutated';
  const second = readSourceCache('k', 60_000, storage);
  assert.equal(second.papers[0].id, 'a');
});

test('evicts the oldest entries beyond the cap', () => {
  const storage = fakeStorage();
  const realNow = Date.now;
  try {
    // Distinct, recent timestamps make eviction order deterministic without
    // pushing any entry past the TTL used by the reads below.
    const base = realNow();
    for (let i = 0; i < 9; i++) {
      Date.now = () => base + i * 1000;
      writeSourceCache(`k${i}`, i, storage);
    }
    Date.now = () => base + 9000;
    const store = JSON.parse(storage.getItem('papertok_source_cache_v1'));
    assert.equal(Object.keys(store).length, 6);
    assert.equal(readSourceCache('k0', 60_000, storage), null);
    assert.equal(readSourceCache('k2', 60_000, storage), null);
    assert.equal(readSourceCache('k3', 60_000, storage), 3);
    assert.equal(readSourceCache('k8', 60_000, storage), 8);
  } finally {
    Date.now = realNow;
  }
});

test('corrupt storage contents read as a miss and never throw', () => {
  const storage = fakeStorage();
  storage.setItem('papertok_source_cache_v1', '{not json');
  assert.equal(readSourceCache('k', 60_000, storage), null);
  writeSourceCache('k', 1, storage);
  assert.equal(readSourceCache('k', 60_000, storage), 1);
});

test('missing storage disables caching without errors', () => {
  assert.equal(readSourceCache('k', 60_000, null), null);
  writeSourceCache('k', 1, null);
});
