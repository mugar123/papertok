import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../data/categories.js';
import { GUEST_CATEGORIES, buildGuestDiscoveryQuery, buildGuestFeedPlan, guestCategoryLabel } from './guestFeedPlan.js';

// The root invariant. Four consumers read this list, and an id the schema does
// not know slips past all of them as a literal string: no label, no domain
// source, and a billed OpenAlex call spent on the id itself.
test('every guest category exists in the internal schema', () => {
  const missing = [];
  GUEST_CATEGORIES.forEach(categoryId => guestCategoryLabel(categoryId, id => missing.push(id)));
  assert.deepEqual(missing, []);
});

test('the discovery query carries labels, never raw ids', () => {
  const query = buildGuestDiscoveryQuery();

  assert.equal(query.includes('q-bio.NC'), false);
  assert.ok(query.includes('"Neuroscience"'));
  assert.ok(query.includes('"Cosmology"'));
  assert.equal((query.match(/"/g) || []).length, GUEST_CATEGORIES.length * 2);
});

test('an id outside the schema falls back to itself and says so', () => {
  const seen = [];

  assert.equal(guestCategoryLabel('q-bio.NC', id => seen.push(id)), 'q-bio.NC');
  assert.deepEqual(seen, ['q-bio.NC']);
});

// ── A guest who answered the interests prompt ───────────────────────────────

test('with no areas the plan is the fixed sample, unchanged', () => {
  const plan = buildGuestFeedPlan([]);

  assert.equal(plan.key, 'default');
  assert.deepEqual(plan.categories, [...GUEST_CATEGORIES]);
  assert.deepEqual(plan.arxivCategories, [...GUEST_CATEGORIES]);
  assert.equal(plan.discoveryQuery, buildGuestDiscoveryQuery());
  assert.equal(plan.pubmedQuery, 'neuroscience OR bioinformatics');
  assert.deepEqual(buildGuestFeedPlan(['not-an-area']).key, 'default');
});

test('every category a chosen plan asks for exists in the internal schema', () => {
  const plan = buildGuestFeedPlan(['physics', 'cs', 'bio', 'med', 'econ']);
  const missing = [];
  [...plan.categories, ...plan.arxivCategories, ...plan.pubmedCategories]
    .forEach(id => guestCategoryLabel(id, missed => missing.push(missed)));
  assert.deepEqual(missing, []);
});

test('the chosen areas are all represented, and each source is capped', () => {
  const plan = buildGuestFeedPlan(['econ', 'physics', 'cs', 'math']);

  assert.equal(plan.key, 'physics+cs+math+econ');
  assert.ok(plan.categories.length > 40, 'the full union routes the domain plan');
  assert.equal(plan.arxivCategories.length, 6);
  // Round-robin: the first category of every area before any area's second.
  const firstOf = area => Object.keys(CATEGORIES[area].subcategories)[0];
  assert.deepEqual(plan.arxivCategories.slice(0, 4), ['physics', 'cs', 'math', 'econ'].map(firstOf));
  assert.equal((plan.discoveryQuery.match(/"/g) || []).length, 5 * 2);
  assert.ok(plan.discoveryQuery.includes('"Artificial Intelligence"'));
  assert.ok(plan.discoveryQuery.includes(`"${CATEGORIES.econ.subcategories[firstOf('econ')].labelEn}"`));
});

test('PubMed is only asked for biology and medicine, and arXiv never for them', () => {
  const life = buildGuestFeedPlan(['bio', 'med']);
  assert.equal(life.pubmedCategories.length, 3);
  assert.ok(life.pubmedQuery.includes('"'));
  assert.deepEqual(life.arxivCategories, []);

  const exact = buildGuestFeedPlan(['cs']);
  assert.deepEqual(exact.pubmedCategories, []);
  assert.equal(exact.pubmedQuery, '');
  assert.ok(exact.arxivCategories.every(id => id.startsWith('cs.')));
});

test('the same areas in any order make the same plan', () => {
  assert.equal(buildGuestFeedPlan(['bio', 'cs']).key, buildGuestFeedPlan(['cs', 'bio', 'cs']).key);
});
