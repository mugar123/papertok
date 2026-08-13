import assert from 'node:assert/strict';
import test from 'node:test';
import { explanationCacheKey, normalizePaperForExplanation } from './ai-explanation.js';

test('AI explanation cache varies with every prompt-relevant paper field', async () => {
  const base = normalizePaperForExplanation({
    id: 'paper-1',
    title: 'A paper',
    abstract: 'A sufficiently useful abstract.',
    authors: [{ name: 'Ada' }],
    year: 2026,
    journal: 'Journal A',
    categories: ['physics'],
    concepts: [{ name: 'Cosmology' }],
  });
  const changed = { ...base, authors: ['Grace'] };
  const first = await explanationCacheKey(base, 'university', 'en', 'gemini', 'model');
  const second = await explanationCacheKey(changed, 'university', 'en', 'gemini', 'model');
  assert.notEqual(first.url, second.url);
});
