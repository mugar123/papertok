import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { libraryTags, suggestTags } from './tag-suggestions.ts';

const paper: Partial<Paper> = {
  categories: ['quant-ph'],
  keywords: ['quant-ph', { display_name: 'Surface code', score: 0.9 }] as Paper['keywords'],
  concepts: [
    { display_name: 'Physics', score: 0.95, level: 0 },
    { display_name: 'Quantum error correction', score: 0.8, level: 2 },
    { display_name: 'Qubit', score: 0.6, level: 3 },
  ] as Paper['concepts'],
  topics: [{ display_name: 'Quantum error correction', score: 0.99 }] as Paper['topics'],
};

test('the reader\'s own matching tags come first, in their spelling', () => {
  const tags = suggestTags(paper, { userTags: ['QEC', 'Qubit', 'decoding'], limit: 3 });
  assert.deepEqual(tags, ['Qubit', 'surface code', 'quantum error correction']);
});

test('category codes, duplicates and tags already on the paper are skipped; generic concepts go last', () => {
  const tags = suggestTags(paper, { current: ['surface code'], area: 'Physics', limit: 10 });
  assert.deepEqual(tags, ['quantum error correction', 'qubit', 'quantum physics', 'physics']);
});

test('a category code reported as a keyword becomes its name, and the area still closes the row', () => {
  assert.deepEqual(suggestTags({ categories: ['cs.LG'], keywords: ['cs.LG'] }, { area: 'Computer Science' }), ['machine learning', 'computer science']);
});

test('library tags are ranked by use', () => {
  assert.deepEqual(libraryTags({ a: { tags: ['x', 'y'] }, b: { tags: ['y'] }, c: {} }), ['y', 'x']);
});

test('a paper with only arXiv categories is offered their names, not just its area', () => {
  const tags = suggestTags({ categories: ['cs.LG', 'stat.ML'], primaryCategory: 'cs.LG' }, { area: 'Computer Science', limit: 5 });
  assert.ok(tags.length >= 2, `expected the categories in words, got ${JSON.stringify(tags)}`);
  assert.ok(!tags.includes('cs.lg'));
});
