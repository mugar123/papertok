import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPdfModel } from './pdfExport.js';
import { buildLatexDocument } from './latexExport.js';

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
// The model's shape — `meta` is `documentMeta`'s own object, mounted whole,
// and every section carries the heading as it was printed in the source
// paper. Both formats are the same document, so the two are cross-checked
// against `latexExport.js` directly rather than against a restated fixture.
// ---------------------------------------------------------------------------

test('el modelo lleva los metadatos montados, no las piezas sueltas', () => {
  const model = build({ generatedAt: new Date(Date.UTC(2026, 8, 4)) });
  assert.equal(model.meta.masthead, 'PaperTok · Versión en lenguaje sencillo');
  assert.equal(model.meta.level, 'Nivel universitario');
  assert.match(model.meta.source, /4 de septiembre de 2026/);
  assert.equal(model.meta.colophon.rows.length > 0, true);
});

test('el encabezado original del paper llega al modelo del PDF', () => {
  const model = build({
    sections: [{ ...SECTIONS[0], originalHeading: '2. Methods' }],
  });
  assert.equal(model.sections[0].originalHeading, '2. Methods');
});

test('una sección sin encabezado original lo deja vacío, no undefined', () => {
  const model = build();
  assert.equal(model.sections[1].originalHeading, '');
});

test('el modelo del PDF y el del .tex cuentan lo mismo', () => {
  // Los dos formatos son el mismo documento: si divergen, uno miente.
  const args = { paper: PAPER, sections: SECTIONS, annotations: [], language: 'es',
    level: 'university', kindLabels: KIND_LABELS, originalUrl: 'https://arxiv.org/abs/2401.00001',
    generatedAt: new Date(Date.UTC(2026, 8, 4)) };
  const model = buildPdfModel(args);
  const { source } = buildLatexDocument(args);
  assert.ok(source.includes(model.meta.colophon.rows.at(-1).value));
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

test('the model carries the frame the .tex carries: title, level, notice, provenance, source', () => {
  const model = build();
  assert.equal(model.meta.title, PAPER.title);
  assert.equal(model.meta.level, 'Nivel universitario');
  assert.match(model.meta.notice, /no es obra del autor/);
  assert.match(model.meta.provenance, /Reescrito por PaperTok/);
  assert.match(model.meta.source, /arxiv\.org\/abs\/2401\.00001/);
  assert.deepEqual(model.labels, { mine: 'Tuya', ai: 'IA' });
});

test('in English every string follows', () => {
  const model = build({ language: 'en' });
  assert.equal(model.meta.level, 'University level');
  assert.match(model.meta.provenance, /Rewritten by PaperTok/);
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
// The running head's own cap (Task 11 live verification): `buildBlocks`
// (browser-only, verified live) writes the mast from `runningLabel`, not
// `label` — unbounded, a routine 40-character section heading wrapped the
// mast to two lines the moment it shared a page with a paper title already
// at its own 45-character cap (`runningTitleText`), seen on a real
// document, not an adversarial one. `label` — what the page's own `<h2>`
// prints — stays whole either way; only the text repeated in the mast is
// capped, the same split the .tex keeps between `\section{full}` and its
// short `\sectionmark` argument (`sectionMarkText`, exportDocument.js).
// ---------------------------------------------------------------------------

test('a section heading past the cap is truncated for the running head; the page keeps it whole', () => {
  const long = 'x'.repeat(60);
  const model = build({ sections: [{ id: 's9', heading: long, paragraphs: ['Texto.'] }] });
  assert.equal(model.sections[0].label, long);
  assert.equal(model.sections[0].runningLabel, `${'x'.repeat(30)}…`);
});

test('an ordinary section heading is not cut short in either field', () => {
  const model = build();
  assert.equal(model.sections[0].runningLabel, model.sections[0].label);
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
