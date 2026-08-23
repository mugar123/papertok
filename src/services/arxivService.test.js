import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignRequestedCategories,
  buildAuthorQuery,
  buildSearchQuery,
  clearCache,
  fetchPapers,
} from './arxivService.js';

// Under node the module sees no import.meta.env, so neither the Worker route nor
// the dev proxy is configured -- exactly the state in which the dead corsproxy.io
// and allorigins cascade used to run. It has to fail without calling anything.
test('fails without reaching for a third-party proxy when no arXiv route exists', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const requested = [];
  globalThis.fetch = (input) => {
    requested.push(String(input?.url || input));
    return Promise.resolve(new Response('', { status: 200 }));
  };
  console.error = () => {};

  try {
    clearCache();
    await assert.rejects(
      fetchPapers(['cs.AI'], 0, 5),
      /No se pudo conectar con arXiv/,
    );
    assert.deepEqual(requested, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    clearCache();
  }
});

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

// A quote inside the phrase used to close arXiv's quoted term early, which is
// answered with an empty or wrong result set rather than an error.
test('keeps the arXiv phrase quotes balanced whatever the user typed', () => {
  assert.equal(buildAuthorQuery('Ada "Countess" Lovelace'), 'au:"Ada Countess Lovelace"');
  assert.equal(buildSearchQuery('  "quantum" error correction  '), 'all:"quantum error correction"');
  assert.equal((buildAuthorQuery('A" OR au:B').match(/"/g) || []).length, 2);
  assert.equal((buildSearchQuery('a"b"c').match(/"/g) || []).length, 2);
});
