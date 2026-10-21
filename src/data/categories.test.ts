import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, INTEREST_AREAS, getCategoryArea } from './categories.ts';

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
