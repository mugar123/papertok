import assert from 'node:assert/strict';
import test from 'node:test';
import { ingredientOfAuthor, ingredientOfTopic, ingredientResults, keywordIngredient, searchFailureNotice, suggestedIngredients } from './feed-ingredient-search.ts';

test('a search result becomes the ingredient it stands for', () => {
  assert.deepEqual(ingredientOfTopic({ id: 'physics', display_name: 'Physics', level: 0, _localTopic: true, categoryIds: ['quant-ph', 'hep-th'] }), { kind: 'area', id: 'physics' });
  assert.deepEqual(ingredientOfTopic({ id: 'quant-ph', display_name: 'Quantum Physics', level: 1, _localTopic: true, categoryIds: ['quant-ph'] }), { kind: 'category', id: 'quant-ph' });
  assert.deepEqual(ingredientOfTopic({ id: 'https://openalex.org/T10020', display_name: 'Quantum error correction', level: 2, _localTopic: false }), { kind: 'topic', id: 'T10020', label: 'Quantum error correction' });
  assert.deepEqual(ingredientOfAuthor({ id: 'https://openalex.org/A5023888391', display_name: 'Aiko Sato' }), { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' });
  assert.deepEqual(keywordIngredient('  Quantum   Memory '), { kind: 'keyword', query: 'quantum memory' });
  assert.equal(keywordIngredient('?'), null);
  assert.equal(ingredientOfTopic({ id: 'no-such-area', display_name: 'Nothing', level: 0, _localTopic: true }), null);
  assert.equal(ingredientOfAuthor({ id: 'https://openalex.org/W1', display_name: 'A work' }), null);
});

test('the suggestions are the reader\'s own topics that the feed does not hold yet', () => {
  assert.deepEqual(suggestedIngredients(['quant-ph', 'cs.CR'], [{ kind: 'category', id: 'quant-ph' }]), [{ kind: 'category', id: 'cs.CR' }]);
  assert.deepEqual(suggestedIngredients(['physics', 'unknown-id', 'physics'], []), [{ kind: 'area', id: 'physics' }]);
  assert.equal(suggestedIngredients(['quant-ph', 'cs.CR', 'hep-th', 'cs.LG', 'cs.AI', 'math.CO', 'astro-ph.GA'], []).length, 6);
  assert.equal(suggestedIngredients(['quant-ph', 'cs.CR'], [], 1).length, 1);
});

test('the results are grouped as topics, authors and the keyword, without repeats', () => {
  const results = ingredientResults({
    text: 'quantum',
    topics: [
      { id: 'quant-ph', display_name: 'Quantum Physics', level: 1, _localTopic: true },
      { id: 'quant-ph', display_name: 'Quantum Physics', level: 1, _localTopic: true },
      { id: 'T10020', display_name: 'Quantum error correction', level: 2, _localTopic: false },
      { id: 'not-a-topic', display_name: 'Broken', level: 2, _localTopic: false },
    ],
    authors: Array.from({ length: 7 }, (_, n) => ({ id: `https://openalex.org/A${n}`, display_name: `Author ${n}` })),
  });
  assert.deepEqual(results.topics, [{ kind: 'category', id: 'quant-ph' }, { kind: 'topic', id: 'T10020', label: 'Quantum error correction' }]);
  assert.deepEqual(results.authors.map(author => author.kind === 'author' && author.id), ['A0', 'A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(results.keyword, { kind: 'keyword', query: 'quantum' });
  assert.equal(ingredientResults({ text: '?', topics: [], authors: [] }).keyword, null);
});

test('a search source that failed is named; none failing says nothing', () => {
  assert.equal(searchFailureNotice({ topics: true, authors: false }), 'Topics could not be searched.');
  assert.equal(searchFailureNotice({ topics: false, authors: true }), 'Authors could not be searched.');
  assert.equal(searchFailureNotice({ topics: true, authors: true }), 'Topics and authors could not be searched.');
  assert.equal(searchFailureNotice({ topics: false, authors: false }), null);
});
