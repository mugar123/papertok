import test from 'node:test';
import assert from 'node:assert/strict';
import { GUEST_CATEGORIES, buildGuestDiscoveryQuery, guestCategoryLabel } from './guestFeedPlan.js';

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
