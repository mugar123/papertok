import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, getCategoryArea, getCategoryLabel } from './categories.ts';

test('Artificial Intelligence is an area of its own, made of arXiv Computer Science ids', () => {
  const ai = CATEGORIES.ai;
  assert.equal(ai.label, 'Artificial Intelligence');
  assert.deepEqual(Object.keys(ai.subcategories).sort(), ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.NE']);
  for (const id of Object.keys(ai.subcategories)) {
    assert.equal(getCategoryArea(id), 'ai', id);
    assert.equal(id in CATEGORIES.cs.subcategories, false, id);
  }
  assert.equal(getCategoryArea('cs.CR'), 'cs');
  assert.equal(getCategoryLabel('cs.CL'), 'Computation and Language');
});

test('every leaf belongs to exactly one area', () => {
  const leaves = Object.values(CATEGORIES).flatMap(area => Object.keys(area.subcategories));
  assert.equal(new Set(leaves).size, leaves.length);
});

// A list a user publishes may carry any category string. A name that
// Object.prototype also has is an unknown category like any other, not Physics
// and not a missing label.
const PROTOTYPE_NAMES = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];

test('a category named like an Object.prototype member has no area', () => {
  for (const name of PROTOTYPE_NAMES) assert.equal(getCategoryArea(name), null, name);
  assert.equal(getCategoryArea('cs.AI'), 'ai');
});

test('a category named like an Object.prototype member keeps its own name as its label', () => {
  for (const name of PROTOTYPE_NAMES) assert.equal(getCategoryLabel(name), name, name);
  assert.equal(getCategoryLabel('cs'), CATEGORIES.cs.label);
});
