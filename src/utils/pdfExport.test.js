import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdfModel, plainAuthorLine } from './pdfExport.js';

/**
 * Only the model is tested here: the paginator and the rasterizer need a DOM
 * and are verified live against the dev server. The model must mirror the
 * `.tex` export's decisions — same filtering, same numbering, same words — so
 * several of these expectations are the LaTeX suite's, restated without the
 * escaping.
 */

const PAPER = {
  title: 'Correladores & el 100% del ruido_medido',
  authors: [{ name: 'Allic Sivaramakrishnan' }, { name: 'M. Ángeles Pérez' }],
};

const SECTIONS = [
  {
    id: 's1',
    kind: 'abstract',
    heading: 'De qué va',
    paragraphs: ['Los autores calculan $\\tau$ y encuentran una distribucion nueva.'],
  },
  {
    id: 's2',
    kind: 'method',
    paragraphs: ['El método usa el 100% del ruido medido.'],
  },
];

const KIND_LABELS = { abstract: 'De qué va', method: 'Método', other: 'Sección' };

function build(overrides = {}) {
  return buildPdfModel({
    paper: PAPER,
    sections: SECTIONS,
    annotations: [],
    language: 'es',
    level: 'university',
    kindLabels: KIND_LABELS,
    originalUrl: 'https://arxiv.org/abs/2401.00001',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The byline
// ---------------------------------------------------------------------------

test('the byline is plain names, joined with commas', () => {
  assert.equal(
    plainAuthorLine(PAPER),
    'Allic Sivaramakrishnan, M. Ángeles Pérez',
  );
});

test('past twelve authors the byline says so instead of listing them', () => {
  const many = { authors: Array.from({ length: 30 }, (_, i) => ({ name: `Autor ${i}` })) };
  const line = plainAuthorLine(many);
  assert.match(line, / et al\.$/);
  assert.match(line, /Autor 11/);
  assert.doesNotMatch(line, /Autor 12/);
});

test('an empty author list is an empty byline, not "undefined"', () => {
  assert.equal(plainAuthorLine({}), '');
  assert.equal(plainAuthorLine({ authors: ['Nombre Solo'] }), 'Nombre Solo');
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

test('the model carries the frame the .tex carries: title, stamp, provenance, link', () => {
  const model = build();
  assert.equal(model.title, PAPER.title);
  assert.match(model.stamp, /nivel universitario/);
  assert.match(model.abstract, /no es obra del autor/);
  assert.match(model.provenance, /Reescrito por PaperTok/);
  assert.equal(model.originalUrl, 'https://arxiv.org/abs/2401.00001');
  assert.deepEqual(model.labels, { mine: 'Tuya', ai: 'IA' });
});

test('in English every string follows', () => {
  const model = build({ language: 'en' });
  assert.match(model.stamp, /university level/);
  assert.match(model.provenance, /Rewritten by PaperTok/);
  assert.deepEqual(model.labels, { mine: 'Yours', ai: 'AI' });
});

test('the file name is the .tex name with the other extension', () => {
  assert.equal(build().fileName, 'correladores-el-100-del-ruido-medido-en-simple.pdf');
});

test('a section without heading falls back to its kind label, then to "Sección"', () => {
  const model = build();
  assert.equal(model.sections[0].label, 'De qué va');
  assert.equal(model.sections[1].label, 'Método');
  const bare = build({ sections: [{ id: 's9', paragraphs: ['Texto.'] }], kindLabels: {} });
  assert.equal(bare.sections[0].label, 'Sección');
});

// ---------------------------------------------------------------------------
// Filtering and numbering — the .tex rules, verbatim
// ---------------------------------------------------------------------------

const ANNOTATIONS = [
  { id: 'm1', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'Los autores calculan' },
  { id: 'n1', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'una distribucion nueva', note: 'ojo aquí' },
  { id: 'a1', sectionId: 's2', paragraphIndex: 0, kind: 'ai', quote: 'ruido medido', note: 'la IA explica' },
];

test('the include switches drop exactly what they say', () => {
  const all = build({ annotations: ANNOTATIONS });
  assert.equal(all.sections[0].paragraphs[0].annotations.length, 2);
  assert.equal(all.sections[1].paragraphs[0].annotations.length, 1);

  const noAi = build({ annotations: ANNOTATIONS, include: { ai: false } });
  assert.equal(noAi.sections[1].paragraphs[0].annotations.length, 0);

  const noMine = build({ annotations: ANNOTATIONS, include: { mine: false } });
  assert.deepEqual(
    noMine.sections[0].paragraphs[0].annotations.map(item => item.id),
    ['m1'],
  );

  const noMarks = build({ annotations: ANNOTATIONS, include: { marks: false } });
  assert.deepEqual(
    noMarks.sections[0].paragraphs[0].annotations.map(item => item.id),
    ['n1'],
  );
});

test('notes are numbered in document order across sections; bare marks are not', () => {
  const model = build({ annotations: ANNOTATIONS });
  const first = model.sections[0].paragraphs[0].annotations;
  const second = model.sections[1].paragraphs[0].annotations;
  assert.equal(first.find(item => item.id === 'n1').number, 1);
  assert.equal(second.find(item => item.id === 'a1').number, 2);
  assert.equal(first.find(item => item.id === 'm1').number, undefined);
  assert.equal(model.noteCount, 2);
});

test('an annotation from a level or language this rewrite is not is left out', () => {
  const model = build({
    annotations: [
      { id: 'other', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'x', note: 'de otro nivel', level: 'beginner' },
      { id: 'en', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'x', note: 'in english', language: 'en' },
    ],
  });
  assert.equal(model.sections[0].paragraphs[0].annotations.length, 0);
  assert.equal(model.noteCount, 0);
});
