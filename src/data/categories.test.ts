import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, INTEREST_AREAS, getCategoryArea, getCategoryLabel } from './categories.ts';

test('Artificial Intelligence is an interest area of its own, made of Computer Science ids', () => {
  const ai = INTEREST_AREAS.ai;
  assert.equal(ai.label, 'Artificial Intelligence');
  assert.ok('cs.AI' in ai.subcategories);
  for (const id of Object.keys(ai.subcategories)) {
    assert.equal(getCategoryArea(id), 'cs');
    assert.equal(id in INTEREST_AREAS.cs.subcategories, false);
  }

  const pickable = Object.values(INTEREST_AREAS).flatMap(area => Object.keys(area.subcategories));
  const taxonomy = Object.values(CATEGORIES).flatMap(area => Object.keys(area.subcategories));
  assert.deepEqual([...pickable].sort(), [...taxonomy].sort());
});

// A list a user publishes may carry any category string. A name that
// Object.prototype also has is an unknown category like any other, not Physics
// and not a missing label.
const PROTOTYPE_NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

test('a category named like an Object.prototype member has no area', () => {
  for (const name of PROTOTYPE_NAMES) assert.equal(getCategoryArea(name), null, name);
  assert.equal(getCategoryArea('cs.AI'), 'cs');
});

test('a category named like an Object.prototype member keeps its own name as its label', () => {
  for (const name of PROTOTYPE_NAMES) assert.equal(getCategoryLabel(name), name, name);
  assert.equal(getCategoryLabel('cs'), CATEGORIES.cs.label);
});
