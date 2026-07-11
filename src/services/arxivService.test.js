import test from 'node:test';
import assert from 'node:assert/strict';
import { assignRequestedCategories } from './arxivService.js';

test('keeps an exact arXiv subcategory selected by the user', () => {
  const [paper] = assignRequestedCategories([{
    id: 'paper-1',
    title: 'Optical trapping',
    abstract: 'A physics experiment.',
    primaryCategory: 'physics.optics',
    categories: ['physics.optics', 'quant-ph'],
  }], ['physics.optics', 'quant-ph']);

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
});

test('maps keyword-search papers back to the most relevant requested subcategory', () => {
  const [paper] = assignRequestedCategories([{
    id: 'paper-2',
    title: 'Robotics for autonomous vehicles',
    abstract: 'A dynamics method for robotic control.',
    categories: ['cs.RO'],
  }], ['mech.fluid', 'mech.dyn']);

  assert.equal(paper.primaryCategory, 'mech.dyn');
  assert.ok(paper.allCategories.includes('cs.RO'));
});
