import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.js';
import {
  GUEST_INTERESTS_STORAGE_KEY,
  GUEST_SEED_PER_AREA,
  clearGuestInterests,
  dismissGuestInterests,
  guestCategoriesForAreas,
  guestSeedCategoriesForAreas,
  normalizeGuestAreas,
  readGuestInterests,
  saveGuestInterests,
} from './guestInterests.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    get size() { return map.size; },
  };
}

test('areas are normalized to known keys, deduped, in taxonomy order', () => {
  assert.deepEqual(normalizeGuestAreas(['bio', 'cs', 'bio', 'nope', 42, 'physics']), ['physics', 'cs', 'bio']);
  assert.deepEqual(normalizeGuestAreas('cs'), []);
  assert.deepEqual(normalizeGuestAreas(null), []);
});

test('the categories of an area are exactly the schema subcategories', () => {
  const ids = guestCategoriesForAreas(['cs', 'unknown']);
  assert.deepEqual(ids, Object.keys(CATEGORIES.cs.subcategories));
  assert.ok(ids.includes('cs.AI'));
});

test('a never-answered device reads as null', () => {
  assert.equal(readGuestInterests(fakeStorage()), null);
  assert.equal(readGuestInterests(fakeStorage({ [GUEST_INTERESTS_STORAGE_KEY]: '{not json' })), null);
  assert.equal(readGuestInterests(fakeStorage({ [GUEST_INTERESTS_STORAGE_KEY]: '"cs"' })), null);
});

test('a saved pick comes back normalized and not dismissed', () => {
  const storage = fakeStorage();
  const stored = saveGuestInterests(['bio', 'cs', 'made-up'], storage);

  assert.deepEqual(stored, ['cs', 'bio']);
  assert.deepEqual(readGuestInterests(storage), { areas: ['cs', 'bio'], dismissed: false });
});

test('"not now" and an emptied pick both read as dismissed, with no areas', () => {
  const storage = fakeStorage();
  dismissGuestInterests(storage);
  assert.deepEqual(readGuestInterests(storage), { areas: [], dismissed: true });

  saveGuestInterests(['cs'], storage);
  saveGuestInterests([], storage);
  assert.deepEqual(readGuestInterests(storage), { areas: [], dismissed: true });
});

test('a stored list of unknown keys reads as dismissed rather than as a pick', () => {
  const storage = fakeStorage({
    [GUEST_INTERESTS_STORAGE_KEY]: JSON.stringify({ areas: ['zzz'], dismissedAt: null }),
  });
  assert.deepEqual(readGuestInterests(storage), { areas: [], dismissed: true });
});

test('clearing forgets the answer entirely', () => {
  const storage = fakeStorage();
  saveGuestInterests(['math'], storage);
  clearGuestInterests(storage);

  assert.equal(readGuestInterests(storage), null);
  assert.equal(storage.size, 0);
});

test('a storage that throws never reaches the caller', () => {
  const broken = {
    getItem() { throw new Error('quota'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('quota'); },
  };
  assert.equal(readGuestInterests(broken), null);
  assert.deepEqual(saveGuestInterests(['cs'], broken), ['cs']);
  assert.doesNotThrow(() => dismissGuestInterests(broken));
  assert.doesNotThrow(() => clearGuestInterests(broken));
});

test('the seed takes the first five of each area, interleaved across areas', () => {
  const firstN = (area, n) => Object.keys(CATEGORIES[area].subcategories).slice(0, n);
  const seed = guestSeedCategoriesForAreas(['mech', 'physics', 'eess']);
  assert.equal(GUEST_SEED_PER_AREA, 5);
  assert.equal(seed.length, 15);
  // Taxonomy order for the areas (physics before eess before mech), and the
  // first of every area before any area's second.
  assert.deepEqual(seed.slice(0, 3), [firstN('physics', 1)[0], firstN('eess', 1)[0], firstN('mech', 1)[0]]);
  assert.deepEqual(seed.slice(3, 6), [firstN('physics', 2)[1], firstN('eess', 2)[1], firstN('mech', 2)[1]]);
  assert.deepEqual(seed.filter(id => id in CATEGORIES.physics.subcategories), firstN('physics', 5));
  assert.equal(new Set(seed).size, 15);
});

test('a small area contributes what it has, and the seed never reaches the rules cap', () => {
  assert.deepEqual(guestSeedCategoriesForAreas(['econ']), Object.keys(CATEGORIES.econ.subcategories));
  const everything = guestSeedCategoriesForAreas(Object.keys(CATEGORIES));
  assert.ok(everything.length <= 100, `${everything.length} preferences would be refused by firestore.rules`);
  assert.deepEqual(guestSeedCategoriesForAreas(['nope']), []);
  assert.deepEqual(guestSeedCategoriesForAreas(null), []);
  assert.deepEqual(guestSeedCategoriesForAreas(['cs'], 2), Object.keys(CATEGORIES.cs.subcategories).slice(0, 2));
});
