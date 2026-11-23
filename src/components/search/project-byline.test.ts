import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectByline } from './project-byline.ts';

test('labels project budgets without guessing a currency', () => {
  assert.equal(projectByline('SNSF', 90593, undefined, 'en-US'), 'SNSF · Budget 90,593');
  assert.equal(projectByline('Funder', 90593, 'EUR', 'en-US'), 'Funder · Budget €90,593');
  assert.equal(projectByline('SNSF', undefined, undefined, 'en-US'), 'SNSF');
  assert.equal(projectByline('', 0, undefined, 'en-US'), 'Budget 0');
});
