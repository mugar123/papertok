import test from 'node:test';
import assert from 'node:assert/strict';
import { INTEREST_AREAS } from '../data/categories.ts';
import {
  GUEST_INTERESTS_STORAGE_KEY,
  GUEST_SEED_PER_AREA,
  GUEST_SEED_MAX,
  clearGuestInterests,
  guestSeedCategoriesForAreas,
  guestSeedSizeForAreas,
  normalizeGuestAreas,
  normalizeGuestTopics,
  readGuestInterests,
  saveGuestInterests,
} from './guestInterests.ts';
import { getDomainSourcePlan } from '../services/domainSourceService.ts';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => map.set(key, String(value)),
    removeItem: (key: string) => map.delete(key),
    get size() { return map.size; },
  };
}

test('areas are normalized to known keys, deduped, in taxonomy order', () => {
  assert.deepEqual(normalizeGuestAreas(['bio', 'cs', 'bio', 'nope', 42, 'physics']), ['physics', 'cs', 'bio']);
  assert.deepEqual(normalizeGuestAreas('cs'), []);
  assert.deepEqual(normalizeGuestAreas(null), []);
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
  assert.deepEqual(readGuestInterests(storage), { areas: ['cs', 'bio'], topics: [], dismissed: false });
});

test('an emptied pick reads as dismissed, with no areas', () => {
  const storage = fakeStorage();
  saveGuestInterests(['cs'], storage);
  saveGuestInterests([], storage);
  assert.deepEqual(readGuestInterests(storage), { areas: [], topics: [], dismissed: true });
});

test('a stored list of unknown keys reads as dismissed rather than as a pick', () => {
  const storage = fakeStorage({
    [GUEST_INTERESTS_STORAGE_KEY]: JSON.stringify({ areas: ['zzz'], dismissedAt: null }),
  });
  assert.deepEqual(readGuestInterests(storage), { areas: [], topics: [], dismissed: true });
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
  assert.doesNotThrow(() => clearGuestInterests(broken));
});

test('the seed takes the first five of each area, interleaved across areas', () => {
  const firstN = (area: string, n: number|undefined) => Object.keys(INTEREST_AREAS[area].subcategories).slice(0, n);
  const seed = guestSeedCategoriesForAreas(['mech', 'physics', 'eess']);
  assert.equal(GUEST_SEED_PER_AREA, 5);
  assert.equal(seed.length, 15);
  // Taxonomy order for the areas (physics before eess before mech), and the
  // first of every area before any area's second.
  assert.deepEqual(seed.slice(0, 3), [firstN('physics', 1)[0], firstN('eess', 1)[0], firstN('mech', 1)[0]]);
  assert.deepEqual(seed.slice(3, 6), [firstN('physics', 2)[1], firstN('eess', 2)[1], firstN('mech', 2)[1]]);
  assert.deepEqual(seed.filter(id => id in INTEREST_AREAS.physics.subcategories), firstN('physics', 5));
  assert.equal(new Set(seed).size, 15);
});

test('a small area contributes what it has, and the seed never reaches the rules cap', () => {
  assert.deepEqual(guestSeedCategoriesForAreas(['econ']), Object.keys(INTEREST_AREAS.econ.subcategories));
  const everything = guestSeedCategoriesForAreas(Object.keys(INTEREST_AREAS));
  assert.ok(everything.length <= 100, `${everything.length} preferences would be refused by firestore.rules`);
  assert.deepEqual(guestSeedCategoriesForAreas(['nope']), []);
  assert.deepEqual(guestSeedCategoriesForAreas(null!), []);
  assert.deepEqual(guestSeedCategoriesForAreas(['cs'], 2), Object.keys(INTEREST_AREAS.cs.subcategories).slice(0, 2));
});

test('topics survive only inside a chosen area, in taxonomy order', () => {
  assert.deepEqual(
    normalizeGuestTopics(['cs.CV', 'bio.neuro', 'cs.AI', 'cs.AI', 'made.up', 7], ['ai']),
    ['cs.AI', 'cs.CV'],
  );
  assert.deepEqual(normalizeGuestTopics('cs.AI', ['ai']), []);
});

test('a pick with topics round-trips, and dropping an area drops its topics', () => {
  const storage = fakeStorage();
  const stored = saveGuestInterests({ areas: ['physics', 'ai'], topics: ['cs.LG', 'quant-ph', 'bio.neuro'] }, storage);
  assert.deepEqual(stored, ['physics', 'ai']);
  assert.deepEqual(readGuestInterests(storage), { areas: ['physics', 'ai'], topics: ['quant-ph', 'cs.LG'], dismissed: false });

  // The header chip's sheet saves areas alone: that answer has no topics.
  saveGuestInterests({ areas: ['ai'], topics: ['cs.LG', 'quant-ph'] }, storage);
  assert.deepEqual(readGuestInterests(storage)!.topics, ['cs.LG']);
});

test('an answer stored before topics existed reads as whole areas', () => {
  const storage = fakeStorage({
    [GUEST_INTERESTS_STORAGE_KEY]: JSON.stringify({ areas: ['math'], dismissedAt: null }),
  });
  assert.deepEqual(readGuestInterests(storage), { areas: ['math'], topics: [], dismissed: false });
});

test('a narrowed area seeds exactly its topics, and the seed stays under the rules cap', () => {
  const seed = guestSeedCategoriesForAreas(['physics', 'ai'], GUEST_SEED_PER_AREA, ['cs.CL', 'cs.CV']);
  const physicsFirst = Object.keys(INTEREST_AREAS.physics.subcategories).slice(0, GUEST_SEED_PER_AREA);
  assert.deepEqual(seed.filter(id => id.startsWith('cs.')), ['cs.CV', 'cs.CL']);
  assert.deepEqual(seed.filter(id => physicsFirst.includes(id)), physicsFirst, 'an untouched area keeps its bounded five');

  const everyTopic = Object.values(INTEREST_AREAS).flatMap(area => Object.keys(area.subcategories));
  const all = guestSeedCategoriesForAreas(Object.keys(INTEREST_AREAS), GUEST_SEED_PER_AREA, everyTopic);
  assert.equal(all.length, GUEST_SEED_MAX, 'every topic ticked still makes a profile the rules accept');
});

test('the seed cap is the rules cap', async () => {
  const { USER_PREFERENCES_MAX } = await import('./accountOnboarding.ts');
  assert.equal(GUEST_SEED_MAX, USER_PREFERENCES_MAX);
});

test('the guest reading choice survives the bridge and is removed with it', () => {
  const storage = fakeStorage();
  saveGuestInterests({ areas: ['ai'], topics: ['cs.LG'], readingLevel: 'beginner' }, storage);
  assert.deepEqual(readGuestInterests(storage), {
    areas: ['ai'], topics: ['cs.LG'], dismissed: false, readingLevel: 'beginner',
  });
  clearGuestInterests(storage);
  assert.equal(readGuestInterests(storage), null);
});

test('invalid guest reading levels normalize safely and old answers stay compatible', () => {
  const storage = fakeStorage();
  saveGuestInterests({ areas: ['cs'], readingLevel: 'invalid' }, storage);
  assert.equal(readGuestInterests(storage)!.readingLevel, 'university');
  saveGuestInterests({ areas: ['cs'] }, storage);
  assert.deepEqual(readGuestInterests(storage), { areas: ['cs'], topics: [], dismissed: false });
});

test('the email digest travels only as an explicit yes', () => {
  const storage = fakeStorage();
  saveGuestInterests({ areas: ['cs'], emailDigest: true }, storage);
  assert.equal(readGuestInterests(storage)!.emailDigest, true);
  saveGuestInterests({ areas: ['cs'], emailDigest: false }, storage);
  assert.equal('emailDigest' in readGuestInterests(storage)!, false);
  storage.setItem('papertok_guestInterests', JSON.stringify({ areas: ['cs'], emailDigest: 'yes' }));
  assert.equal('emailDigest' in readGuestInterests(storage)!, false);
  clearGuestInterests(storage);
  assert.equal(readGuestInterests(storage), null);
});

test('a university address travels with the answer only when it has a domain', () => {
  const storage = fakeStorage();
  saveGuestInterests({ areas: ['cs'], institutionEmail: ' Alice@USAL.es ' }, storage);
  assert.equal(readGuestInterests(storage)?.institutionEmail, 'alice@usal.es');
  saveGuestInterests({ areas: ['cs'], institutionEmail: 'alice@localhost' }, storage);
  assert.equal('institutionEmail' in readGuestInterests(storage)!, false);
  storage.setItem('papertok_guestInterests', JSON.stringify({ areas: ['cs'], institutionEmail: 'not an address' }));
  assert.deepEqual(readGuestInterests(storage), { areas: ['cs'], topics: [], dismissed: false });
});

test('the seed size counts what the answer stands for before the cap', () => {
  // Two whole areas: five each. One area narrowed to three topics: three.
  assert.equal(guestSeedSizeForAreas(['physics', 'cs']), 10);
  assert.equal(guestSeedSizeForAreas(['physics', 'ai'], 5, ['cs.LG', 'cs.CL', 'cs.CV']), 8);
  // Every topic of every area is more than the cap allows, and the size says
  // so where the capped seed would quietly stop at the cap.
  const everything = Object.entries(INTEREST_AREAS).flatMap(([, area]) => Object.keys(area.subcategories));
  const allAreas = Object.keys(INTEREST_AREAS);
  assert.ok(guestSeedSizeForAreas(allAreas, 5, everything) > GUEST_SEED_MAX);
  assert.equal(guestSeedCategoriesForAreas(allAreas, 5, everything).length, GUEST_SEED_MAX);
});

test('Artificial Intelligence picked alone seeds AI topics that reach the AI sources', () => {
  const seed = guestSeedCategoriesForAreas(['ai']);
  assert.ok(seed.includes('cs.AI'));
  assert.equal(seed.some(id => id in INTEREST_AREAS.cs.subcategories), false);

  const plan = getDomainSourcePlan(seed);
  assert.ok(plan.huggingFace.includes('cs.AI'));
  assert.ok(plan.openReview.includes('cs.AI'));
});
