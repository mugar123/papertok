import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.js';
import { rankPreferences } from './preferenceRanking.js';

const firstN = (area, n) => Object.keys(CATEGORIES[area].subcategories).slice(0, n);

test('with no affinities, the window is spread across the areas picked', () => {
  const seeded = [...firstN('physics', 5), ...firstN('eess', 5), ...firstN('mech', 5)];
  const ranked = rankPreferences(seeded, {});
  assert.equal(ranked.length, 15);
  assert.deepEqual(ranked.slice(0, 5), [
    firstN('physics', 1)[0], firstN('eess', 1)[0], firstN('mech', 1)[0],
    firstN('physics', 2)[1], firstN('eess', 2)[1],
  ]);
  // Within an area the list's own order is kept.
  assert.deepEqual(ranked.filter(id => id in CATEGORIES.physics.subcategories), firstN('physics', 5));
});

test('affinity outranks area, and ties are still interleaved below it', () => {
  const seeded = [...firstN('physics', 3), ...firstN('eess', 3)];
  const liked = firstN('eess', 3)[2];
  const disliked = firstN('physics', 1)[0];
  const ranked = rankPreferences(seeded, { [liked]: 4, [disliked]: -2 });
  assert.equal(ranked[0], liked);
  assert.equal(ranked.at(-1), disliked);
  assert.deepEqual(ranked.slice(1, 3), [firstN('physics', 2)[1], firstN('eess', 1)[0]]);
});

test('duplicates fold, unknown ids keep their order in a group of their own, and garbage is dropped', () => {
  const ranked = rankPreferences(['cs.AI', 'topic:x', 'cs.AI', 'topic:y', null, 42, ''], {});
  assert.deepEqual(ranked, ['cs.AI', 'topic:x', 'topic:y']);
  assert.deepEqual(rankPreferences(null), []);
  assert.deepEqual(rankPreferences(['cs.AI'], { 'cs.AI': 'nope' }), ['cs.AI']);
});
