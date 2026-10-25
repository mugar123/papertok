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
