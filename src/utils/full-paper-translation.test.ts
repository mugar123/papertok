import assert from 'node:assert/strict';
import test from 'node:test';
import type { Block, FullText, Inline } from './full-text.ts';
import { applyTranslatedPassages, planFullPaperTranslation } from './full-paper-translation.ts';

const formula: Inline = { t: 'math', tex: 'x^2', mathml: '' };
const code: Inline = { t: 'code', children: [{ t: 'text', text: 'x = 1' }] };
const citation: Inline = { t: 'ref', target: 'B1', cites: true, children: [{ t: 'text', text: '[1]' }] };
const paragraph: Block = { t: 'p', children: [{ t: 'text', text: 'The value is ' }, formula, code, citation] };
const doc: FullText = {
  source: 'arxiv', sourceUrl: 'https://arxiv.org/html/1706.03762',
  title: { t: 'heading', level: 1, children: [{ t: 'text', text: 'A model of sequences' }] },
  abstract: [{ t: 'p', children: [{ t: 'text', text: 'An abstract.' }] }],
  body: [
    { t: 'heading', level: 2, id: 's1', children: [{ t: 'text', text: 'Introduction' }] },
    paragraph,
    { t: 'table', rows: [], caption: [{ t: 'text', text: 'Untouched table' }] },
    { t: 'figure', images: [], caption: [{ t: 'text', text: 'Untouched figure' }] },
    { t: 'heading', level: 2, id: 's2', children: [{ t: 'text', text: 'Results' }] },
  ],
  notes: [], references: [], conversionErrors: 0,
};

test('chunks by section and replaces only prose while reusing the original formula, code and citations', () => {
  const plan = planFullPaperTranslation(doc);
  assert.ok(plan);
  assert.deepEqual(plan.source, [['A model of sequences', 'An abstract.'], ['Introduction', 'The value is '], ['Results']]);
  const translated = applyTranslatedPassages(plan.chunks[1], ['Introducción', 'El valor es'], 'es');
  const heading = translated.get(doc.body[0]);
  assert.deepEqual(heading, { t: 'heading', level: 2, id: 's1', children: [{ t: 'text', text: 'Introducción', language: 'es' }] });
  const passage = translated.get(paragraph);
  assert.equal(passage?.t, 'p');
  assert.deepEqual(passage.children[0], { t: 'text', text: 'El valor es ', language: 'es' });
  assert.equal(passage.children[1], formula);
  assert.equal(passage.children[2], code);
  assert.equal(passage.children[3], citation);
  assert.equal(translated.has(doc.body[2]), false);
  assert.equal(translated.has(doc.body[3]), false);
  assert.deepEqual(paragraph.children[0], { t: 'text', text: 'The value is ' });
});

test('a document outside the pilot or too large is refused whole', () => {
  assert.equal(planFullPaperTranslation({ ...doc, source: 'europepmc' }), null);
  assert.equal(planFullPaperTranslation({ ...doc, body: [] }), null);
  assert.equal(planFullPaperTranslation({ ...doc, conversionErrors: 1 }), null);
  assert.equal(planFullPaperTranslation({ ...doc, body: [{ t: 'p', children: [{ t: 'text', text: 'é'.repeat(3_000) }] }] }), null);
  const headings = Array.from({ length: 17 }, (_, index): Block => ({
    t: 'heading', level: 2, children: [{ t: 'text', text: `Section ${index}` }],
  }));
  assert.equal(planFullPaperTranslation({ ...doc, body: [...headings, paragraph] }), null);
});
