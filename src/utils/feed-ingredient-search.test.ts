import assert from 'node:assert/strict';
import test from 'node:test';
import { ingredientOfAuthor, ingredientOfJournal, ingredientOfTopic, ingredientResults, keywordIngredient, searchFailureNotice, suggestedIngredients } from './feed-ingredient-search.ts';

test('a search result becomes the ingredient it stands for', () => {
  assert.deepEqual(ingredientOfTopic({ id: 'physics', display_name: 'Physics', level: 0, _localTopic: true, categoryIds: ['quant-ph', 'hep-th'] }), { kind: 'area', id: 'physics' });
  assert.deepEqual(ingredientOfTopic({ id: 'quant-ph', display_name: 'Quantum Physics', level: 1, _localTopic: true, categoryIds: ['quant-ph'] }), { kind: 'category', id: 'quant-ph' });
  assert.deepEqual(ingredientOfTopic({ id: 'https://openalex.org/T10020', display_name: 'Quantum error correction', level: 2, _localTopic: false }), { kind: 'topic', id: 'T10020', label: 'Quantum error correction' });
  assert.deepEqual(ingredientOfAuthor({ id: 'https://openalex.org/A5023888391', display_name: 'Aiko Sato' }), { kind: 'author', id: 'A5023888391', label: 'Aiko Sato' });
  assert.deepEqual(keywordIngredient('  Quantum   Memory '), { kind: 'keyword', query: 'quantum memory' });
  assert.equal(keywordIngredient('?'), null);
  assert.equal(ingredientOfTopic({ id: 'no-such-area', display_name: 'Nothing', level: 0, _localTopic: true }), null);
  assert.equal(ingredientOfAuthor({ id: 'https://openalex.org/W1', display_name: 'A work' }), null);
  assert.deepEqual(ingredientOfJournal({ id: 'https://openalex.org/S156274416', display_name: 'Nature Physics', publisher: 'Nature Portfolio' }), { kind: 'journal', id: 'S156274416', label: 'Nature Physics' });
  assert.equal(ingredientOfJournal({ id: 'https://openalex.org/A5023888391', display_name: 'Not a source', publisher: null }), null);
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
    journals: [],
  });
  assert.deepEqual(results.topics, [{ kind: 'category', id: 'quant-ph' }, { kind: 'topic', id: 'T10020', label: 'Quantum error correction' }]);
  assert.deepEqual(results.authors.map(({ ingredient }) => ingredient.kind === 'author' && ingredient.id), ['A0', 'A1', 'A2', 'A3', 'A4']);
  assert.deepEqual(results.keyword, { kind: 'keyword', query: 'quantum' });
  assert.equal(ingredientResults({ text: '?', topics: [], authors: [], journals: [] }).keyword, null);
});

test('an author result carries the institution OpenAlex gave, and none when it gave none', () => {
  const { authors } = ingredientResults({
    text: 'aiko sato',
    topics: [],
    journals: [],
    authors: [
      { id: 'https://openalex.org/A1', display_name: 'Aiko Sato', institution: '慶應義塾大学', institutionData: { display_name: '慶應義塾大学', localized_names: { en: 'Keio University' } } },
      { id: 'https://openalex.org/A1', display_name: 'Aiko Sato', institution: 'Another University' },
      { id: 'https://openalex.org/A2', display_name: 'Aiko Sato', institution: 'University of Tokyo' },
      { id: 'https://openalex.org/A3', display_name: 'Aiko Sato', institution: null },
    ],
  });
  assert.deepEqual(authors, [
    { ingredient: { kind: 'author', id: 'A1', label: 'Aiko Sato' }, institution: 'Keio University' },
    { ingredient: { kind: 'author', id: 'A2', label: 'Aiko Sato' }, institution: 'University of Tokyo' },
    { ingredient: { kind: 'author', id: 'A3', label: 'Aiko Sato' }, institution: null },
  ]);
});

test('a journal result carries its publisher, and an id that is not a source is dropped', () => {
  const { journals } = ingredientResults({
    text: 'nature',
    topics: [],
    authors: [],
    journals: [
      { id: 'https://openalex.org/S156274416', display_name: 'Nature Physics', publisher: 'Nature Portfolio' },
      { id: 'https://openalex.org/A1', display_name: 'An author', publisher: null },
      { id: 'https://openalex.org/S4210234670', display_name: 'Nature Reviews Physics', publisher: null },
    ],
  });
  assert.deepEqual(journals, [
    { ingredient: { kind: 'journal', id: 'S156274416', label: 'Nature Physics' }, publisher: 'Nature Portfolio' },
    { ingredient: { kind: 'journal', id: 'S4210234670', label: 'Nature Reviews Physics' }, publisher: null },
  ]);
});

test('a search source that failed is named; none failing says nothing', () => {
  const none = { topics: false, authors: false, journals: false };
  assert.equal(searchFailureNotice({ ...none, topics: true }), 'Topics could not be searched.');
  assert.equal(searchFailureNotice({ ...none, authors: true }), 'Authors could not be searched.');
  assert.equal(searchFailureNotice({ ...none, journals: true }), 'Journals could not be searched.');
  assert.equal(searchFailureNotice({ ...none, topics: true, authors: true }), 'Topics and authors could not be searched.');
  assert.equal(searchFailureNotice({ ...none, topics: true, journals: true }), 'Topics and journals could not be searched.');
  assert.equal(searchFailureNotice({ ...none, authors: true, journals: true }), 'Authors and journals could not be searched.');
  assert.equal(searchFailureNotice({ topics: true, authors: true, journals: true }), 'Topics, authors and journals could not be searched.');
  assert.equal(searchFailureNotice(none), null);
});
