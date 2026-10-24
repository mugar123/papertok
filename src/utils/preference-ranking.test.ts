import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.ts';
import { createEmptyInteractionProfile, readProfileSignals, recordInteractionEvent, type InteractionEvent } from './interaction-profile.ts';
import { rankPreferences } from './preference-ranking.ts';

const firstN = (area: string, n: number|undefined) => Object.keys(CATEGORIES[area].subcategories).slice(0, n);

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
  const ranked = rankPreferences(['cs.AI', 'topic:x', 'cs.AI', 'topic:y', null!, 42 as never, ''], {});
  assert.deepEqual(ranked, ['cs.AI', 'topic:x', 'topic:y']);
  assert.deepEqual(rankPreferences(null!), []);
  assert.deepEqual(rankPreferences(['cs.AI'], { 'cs.AI': 'nope' as never }), ['cs.AI']);
});

// A reader with ten interests in two areas, as in the 2026-10-20 feed audit.
const TEN = ['cs.AI', 'quant-ph', 'cs.LG', 'cond-mat.supr-con', 'cs.CV', 'cond-mat.str-el', 'cs.CL', 'cond-mat.mtrl-sci', 'cs.NE', 'cond-mat.mes-hall'];
const affinitiesAfter = (events: InteractionEvent[], daysLater = 0) => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const profile = createEmptyInteractionProfile();
  events.forEach(event => recordInteractionEvent(profile, event, now));
  return readProfileSignals(profile, now + daysLater * 86_400_000).categoryAffinities;
};

test('one skip or one quick view leaves an interest where it was, today and a year on', () => {
  const neutral = rankPreferences(TEN, {});
  for (const event of [
    { paperId: 'a', kind: 'skip', category: 'cs.AI' },
    { paperId: 'a', kind: 'viewTime', category: 'cs.AI', viewTime: 2 },
  ]) {
    for (const days of [0, 365]) {
      assert.deepEqual(rankPreferences(TEN, affinitiesAfter([event], days)), neutral, `${event.kind}, ${days} days later`);
    }
  }
  // A long read still moves its interest up.
  assert.equal(rankPreferences(TEN, affinitiesAfter([{ paperId: 'b', kind: 'viewTime', category: 'cs.NE', viewTime: 13 }]))[0], 'cs.NE');
});
