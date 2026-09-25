import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answerSlot,
  buildSectionOrder,
  countAnnotations,
  filterAnnotations,
  isAnnotationFilter,
  sortAnnotations,
} from './annotationOrder.js';

const SECTIONS = [{ id: 'abstract' }, { id: 'methods' }, { id: 'results' }];

test('the rail reads in document order, not arrival order', () => {
  const order = buildSectionOrder(SECTIONS);
  const sorted = sortAnnotations([
    { id: 'c', sectionId: 'results', paragraphIndex: 0 },
    { id: 'a', sectionId: 'abstract', paragraphIndex: 1 },
    { id: 'b', sectionId: 'methods', paragraphIndex: 0 },
  ], order);
  assert.deepEqual(sorted.map(item => item.id), ['a', 'b', 'c']);
});

test('within a section, paragraphs decide', () => {
  const order = buildSectionOrder(SECTIONS);
  const sorted = sortAnnotations([
    { id: 'later', sectionId: 'methods', paragraphIndex: 4 },
    { id: 'earlier', sectionId: 'methods', paragraphIndex: 1 },
  ], order);
  assert.deepEqual(sorted.map(item => item.id), ['earlier', 'later']);
});

test('two annotations on the same paragraph keep the order they arrived in', () => {
  const order = buildSectionOrder(SECTIONS);
  const sorted = sortAnnotations([
    { id: 'first', sectionId: 'abstract', paragraphIndex: 0 },
    { id: 'second', sectionId: 'abstract', paragraphIndex: 0 },
  ], order);
  assert.deepEqual(sorted.map(item => item.id), ['first', 'second']);
});

test('an annotation whose section is gone sinks to the end, it is not dropped', () => {
  const order = buildSectionOrder(SECTIONS);
  const sorted = sortAnnotations([
    { id: 'orphan', sectionId: 'a-heading-this-level-does-not-have', paragraphIndex: 0 },
    { id: 'placed', sectionId: 'results', paragraphIndex: 0 },
  ], order);
  assert.deepEqual(sorted.map(item => item.id), ['placed', 'orphan']);
});

test('sorting does not mutate what it was given', () => {
  const input = [
    { id: 'b', sectionId: 'methods', paragraphIndex: 0 },
    { id: 'a', sectionId: 'abstract', paragraphIndex: 0 },
  ];
  sortAnnotations(input, buildSectionOrder(SECTIONS));
  assert.deepEqual(input.map(item => item.id), ['b', 'a']);
});

test('a highlight you wrote on is still yours', () => {
  const items = [
    { id: 'mark', kind: 'user' },
    { id: 'note', kind: 'user', note: 'algo' },
    { id: 'answer', kind: 'ai', note: 'lo que significa' },
  ];
  assert.deepEqual(filterAnnotations(items, 'mine').map(i => i.id), ['mark', 'note']);
  assert.deepEqual(filterAnnotations(items, 'ai').map(i => i.id), ['answer']);
  assert.equal(filterAnnotations(items, 'all').length, 3);
});

test('an unknown filter shows everything rather than nothing', () => {
  const items = [{ id: 'a', kind: 'user' }];
  assert.equal(filterAnnotations(items, 'nonsense').length, 1);
  assert.equal(isAnnotationFilter('nonsense'), false);
  assert.equal(isAnnotationFilter('ai'), true);
});

test('marks and notes are counted apart, because they are not the same thing', () => {
  const counted = countAnnotations([
    { kind: 'user' },
    { kind: 'user', note: 'mía' },
    { kind: 'ai', note: 'del modelo' },
  ]);
  assert.deepEqual(counted, { notes: 2, marks: 1, total: 3 });
});

// Where "explain this" writes its answer: the card that says the model is
// reading waits in the slot the answer will be filed into, so the margin moves
// to one place once (reported 2026-09-24: the answer landed off screen, below a
// card that had waited at the top of the list and then vanished).
const FILED = [
  { id: 'a', sectionId: 'abstract', paragraphIndex: 0 },
  { id: 'b', sectionId: 'methods', paragraphIndex: 2 },
  { id: 'c', sectionId: 'results', paragraphIndex: 0 },
];

test('an answer waits where it will be filed: after the notes above its passage, before the ones below', () => {
  const order = buildSectionOrder(SECTIONS);
  assert.equal(answerSlot(FILED, { sectionId: 'methods', paragraphIndex: 1 }, order), 1);
});

test('an answer goes after the notes already on its own paragraph, as a new note is filed', () => {
  const order = buildSectionOrder(SECTIONS);
  assert.equal(answerSlot(FILED, { sectionId: 'methods', paragraphIndex: 2 }, order), 2);
});

test('an answer about a section the rewrite no longer has waits at the end', () => {
  const order = buildSectionOrder(SECTIONS);
  assert.equal(answerSlot(FILED, { sectionId: 'gone', paragraphIndex: 0 }, order), 3);
});

test('with no passage asked about there is no slot', () => {
  assert.equal(answerSlot(FILED, null, buildSectionOrder(SECTIONS)), null);
});
