import assert from 'node:assert/strict';
import test from 'node:test';
import {
  documentCopy,
  documentMeta,
  exportFileName,
  formatExportDate,
  numberAnnotations,
  summarizeExport,
} from './exportDocument.js';

test('annotations are grouped by paragraph in document order', () => {
  const sections = [{ id: 's1' }, { id: 's2' }];
  const { byParagraph, numbered } = numberAnnotations(sections, [
    { id: 'c', sectionId: 's2', paragraphIndex: 0, quote: 'ccc', note: 'tercera' },
    { id: 'a', sectionId: 's1', paragraphIndex: 0, quote: 'aaa', note: 'primera' },
    { id: 'b', sectionId: 's1', paragraphIndex: 1, quote: 'bbb', note: 'segunda' },
  ]);
  assert.deepEqual(numbered.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(byParagraph.get('s1:0')[0].id, 'a');
  assert.equal(byParagraph.get('s2:0')[0].id, 'c');
});

test('a bare highlight is grouped but not numbered', () => {
  const { byParagraph, numbered } = numberAnnotations([{ id: 's1' }], [
    { id: 'mark', sectionId: 's1', paragraphIndex: 0, quote: 'aaa' },
  ]);
  assert.equal(numbered.length, 0);
  assert.equal(byParagraph.get('s1:0').length, 1);
});

test('the file is named after the paper, safely', () => {
  assert.equal(
    exportFileName({ title: 'Correladores & el 100% del ruido_medido' }, 'es'),
    'correladores-el-100-del-ruido-medido-en-simple.tex',
  );
  assert.equal(exportFileName({ title: 'Ñandú en Ávila' }, 'en'), 'nandu-en-avila-plain-words.tex');
  // A title made entirely of punctuation must still produce a filename.
  assert.equal(exportFileName({ title: '///' }, 'es'), 'paper-en-simple.tex');
  assert.equal(exportFileName({}, 'es'), 'paper-en-simple.tex');
});

test('the file name can carry another extension for the other formats', () => {
  assert.equal(
    exportFileName({ title: 'Ñandú en Ávila' }, 'en', 'pdf'),
    'nandu-en-avila-plain-words.pdf',
  );
  assert.equal(exportFileName({}, 'es', 'pdf'), 'paper-en-simple.pdf');
});

test('the card can count what it is about to export without building it', () => {
  assert.deepEqual(summarizeExport([
    { quote: 'a', kind: 'user' },
    { quote: 'b', kind: 'user', note: 'x' },
    { quote: 'c', kind: 'ai', note: 'y' },
    { quote: '', kind: 'user' },
  ]), { marks: 1, mine: 1, ai: 1 });
});

test('documentCopy hands each language its own strings, and defaults to Spanish', () => {
  assert.match(documentCopy('en').provenance, /Rewritten by PaperTok/);
  assert.match(documentCopy('es').provenance, /Reescrito por PaperTok/);
  assert.match(documentCopy('fr').provenance, /Reescrito por PaperTok/);
  assert.equal(documentCopy('es').levels.university, 'universitario');
});

test('la fecha se compone en el idioma del documento', () => {
  const day = new Date(Date.UTC(2026, 8, 4));
  assert.equal(formatExportDate(day, 'es'), '4 de septiembre de 2026');
  assert.equal(formatExportDate(day, 'en'), '4 September 2026');
});

test('una fecha que no lo es no rompe el documento', () => {
  // El export no puede caerse por esto: si la fecha falta, la línea la pierde.
  assert.equal(formatExportDate(new Date('nada'), 'es'), '');
  assert.equal(formatExportDate(null, 'es'), '');
});

test('los metadatos salen montados y en los dos idiomas', () => {
  const meta = documentMeta({
    paper: { title: 'Worldline proper length correlators', authors: [{ name: 'A. Sivaramakrishnan' }] },
    language: 'es',
    level: 'university',
    originalUrl: 'https://arxiv.org/abs/2405.04331',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 2, mine: 3, ai: 1 },
  });
  assert.equal(meta.masthead, 'PaperTok · Versión en lenguaje sencillo');
  assert.equal(meta.level, 'Nivel universitario');
  assert.equal(meta.noticeLabel, 'Aviso');
  assert.equal(meta.source, 'Artículo original: https://arxiv.org/abs/2405.04331 · 4 de septiembre de 2026');
  assert.equal(meta.runningTitle, 'Worldline proper length correlators');
  assert.equal(meta.colophon.heading, 'Procedencia');
  assert.deepEqual(meta.colophon.rows.map(row => row.key), [
    'Artículo original', 'Autoría', 'Fuente', 'Esta versión', 'Anotado con',
  ]);
  assert.equal(meta.colophon.rows.at(-1).value, '2 subrayados y 4 notas: 3 del lector, 1 de la IA');
});

test('la mitad que vale cero no se imprime', () => {
  // Un documento con notas y ningún subrayado suelto es el caso normal, y
  // «0 subrayados y 4 notas» es exactamente lo que no se puede imprimir.
  const copy = documentCopy('es');
  assert.equal(copy.annotatedWith({ marks: 0, mine: 2, ai: 2 }), '4 notas: 2 del lector, 2 de la IA');
  assert.equal(copy.annotatedWith({ marks: 3, mine: 0, ai: 0 }), '3 subrayados');
  assert.equal(copy.annotatedWith({ marks: 1, mine: 1, ai: 0 }), '1 subrayado y 1 nota: 1 del lector, 0 de la IA');
  assert.equal(copy.annotatedWith({ marks: 0, mine: 0, ai: 0 }), 'Sin subrayados ni notas');
});

test('sin enlace al original la línea de fuente no queda coja', () => {
  const meta = documentMeta({
    paper: { title: 'T', authors: [] },
    language: 'es', level: 'beginner', originalUrl: '',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 0, mine: 0, ai: 0 },
  });
  assert.equal(meta.source, '4 de septiembre de 2026');
  assert.equal(meta.byline, '');
  assert.equal(meta.colophon.rows.find(row => row.key === 'Fuente'), undefined);
  assert.equal(meta.colophon.rows.at(-1).value, 'Sin subrayados ni notas');
});

test('en inglés cambia todo, no solo el título', () => {
  const meta = documentMeta({
    paper: { title: 'T', authors: [{ name: 'A. B.' }] },
    language: 'en', level: 'researcher', originalUrl: 'https://doi.org/10.1/x',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
    counts: { marks: 1, mine: 0, ai: 2 },
  });
  assert.equal(meta.masthead, 'PaperTok · Plain-language version');
  assert.equal(meta.level, 'Researcher level');
  assert.equal(meta.noticeLabel, 'Notice');
  assert.equal(meta.colophon.heading, 'Provenance');
  assert.equal(meta.colophon.rows.at(-1).value, '1 highlight and 2 notes: 0 yours, 2 from the AI');
});
