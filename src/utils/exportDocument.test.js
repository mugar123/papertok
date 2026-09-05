import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bylineText,
  colophonTitleText,
  documentCopy,
  documentMeta,
  exportFileName,
  formatExportDate,
  numberAnnotations,
  runningTitleText,
  sectionMarkText,
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

test('bylineText: pasados doce autores, la línea lo dice en vez de listarlos', () => {
  // Esta rama vivía probada solo en `plainAuthorLine` (pdfExport.js, borrado:
  // ahora `bylineText` hace ese trabajo para los dos formatos). Al borrar
  // aquel test junto con la función, la rama de "et al." se quedaba sin
  // ningún test que la vigilara — la única que tenía cobertura, porque el
  // resto del comportamiento de `bylineText` ya lo cubre `documentMeta` más
  // abajo (lista vacía, un único autor).
  const many = { authors: Array.from({ length: 30 }, (_, i) => ({ name: `Autor ${i}` })) };
  const line = bylineText(many);
  assert.match(line, / et al\.$/);
  assert.match(line, /Autor 11/);
  assert.doesNotMatch(line, /Autor 12/);
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

// ---------------------------------------------------------------------------
// El título del colofón (hallazgo de compilar, no de los tests: un título
// sin tope deja de caber en el `\minipage` del colofón — latexExport.js —
// mucho antes de que un título de paper real pudiera acercarse al límite)
// ---------------------------------------------------------------------------

test('colophonTitleText: un título corriente no se toca', () => {
  assert.equal(
    colophonTitleText({ title: 'Worldline proper length correlators' }),
    'Worldline proper length correlators',
  );
  assert.equal(colophonTitleText({}), '');
  assert.equal(colophonTitleText({ title: '' }), '');
});

test('colophonTitleText: pasado el tope, se recorta con honestidad — como bylineText hace con "et al."', () => {
  const long = 'x'.repeat(600);
  const capped = colophonTitleText({ title: long });
  assert.equal(capped, `${'x'.repeat(500)}…`);
  assert.equal(capped.length, 501);
});

test('colophonTitleText: el límite es exacto — justo en 500 no hay elipsis, en 501 sí', () => {
  assert.equal(colophonTitleText({ title: 'x'.repeat(500) }), 'x'.repeat(500));
  assert.doesNotMatch(colophonTitleText({ title: 'x'.repeat(500) }), /…/);
  assert.match(colophonTitleText({ title: 'x'.repeat(501) }), /…$/);
});

test('colophonTitleText: el límite se puede ajustar, como el de bylineText', () => {
  assert.equal(colophonTitleText({ title: 'abcdef' }, 5), 'abcde…');
});

test('el título del colofón y el de la cabecera se recortan cada uno a su propio tope; el de portada no', () => {
  // `meta.title` alimenta la portada (`{\LARGE ...}`, un párrafo corriente
  // que sí se parte entre páginas) y se queda sin tope. La fila del colofón
  // vive dentro de un `\minipage` que no puede partirse (Task 6) y se recorta
  // a 500. `meta.runningTitle` es el tercer caso, distinto de los otros dos:
  // alimenta `\fancyhead[L]` (latexExport.js), una cabecera de una sola línea
  // sin ajuste compartida con `\leftmark` a la derecha — sin tope, un título
  // largo choca contra la sección en vez de partirse donde haga falta
  // (hallazgo de compilar, `runningTitleText` más abajo). Se recorta a 45,
  // no a 500: ningún parecido con el tope del colofón más allá del mecanismo.
  const long = 'Y'.repeat(600);
  const meta = documentMeta({
    paper: { title: long, authors: [] },
    language: 'es', level: 'university', originalUrl: '',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
  });
  assert.equal(meta.title, long);
  assert.equal(meta.runningTitle, `${'Y'.repeat(45)}…`);
  const titleRow = meta.colophon.rows.find(row => row.key === 'Artículo original');
  assert.equal(titleRow.value, `${long.slice(0, 500)}…`);
});

// ---------------------------------------------------------------------------
// El título de la cabecera de página (hallazgo de compilar, no de los tests:
// `\fancyhead[L]` (este título) y `\fancyhead[R]` (`\leftmark`, el número de
// sección — ver `sectionMarkText`, más abajo) son dos zonas sin ajuste
// de línea ni control de colisión — latexExport.js — que compiladas con un
// título de 102 caracteres, ni siquiera especialmente largo, se imprimieron
// una encima de la otra, ilegibles, sin un solo aviso de compilación)
// ---------------------------------------------------------------------------

test('runningTitleText: un título corriente no se toca', () => {
  assert.equal(
    runningTitleText({ title: 'Worldline proper length correlators' }),
    'Worldline proper length correlators',
  );
  assert.equal(runningTitleText({}), '');
  assert.equal(runningTitleText({ title: '' }), '');
});

test('runningTitleText: pasado el tope, se recorta con honestidad — el mismo mecanismo que colophonTitleText', () => {
  const long = 'x'.repeat(90);
  const capped = runningTitleText({ title: long });
  assert.equal(capped, `${'x'.repeat(45)}…`);
  assert.equal(capped.length, 46);
});

test('runningTitleText: el límite es exacto — justo en 45 no hay elipsis, en 46 sí', () => {
  assert.equal(runningTitleText({ title: 'x'.repeat(45) }), 'x'.repeat(45));
  assert.doesNotMatch(runningTitleText({ title: 'x'.repeat(45) }), /…/);
  assert.match(runningTitleText({ title: 'x'.repeat(46) }), /…$/);
});

test('runningTitleText: el límite se puede ajustar, como el de colophonTitleText', () => {
  assert.equal(runningTitleText({ title: 'abcdef' }, 5), 'abcde…');
});

// ---------------------------------------------------------------------------
// El rótulo de sección en el titulillo — la otra mitad de la misma colisión
// que el bloque de arriba. Vivía en `latexExport.js` (el 30 se midió allí,
// contra la tipografía del `.tex`) pero lo que acota no es una
// particularidad de ese formato: es qué le está permitido decir al
// titulillo, y el PDF tiene el suyo propio con la misma forma. Sin este
// tope, un rótulo de sección de 40 caracteres — nada adversarial — bastaba
// para envolver a dos líneas el titulillo del PDF en cuanto compartía
// página con un título de portada ya en su límite de 45 (docD, verificación
// en vivo de Task 11) — el mismo fallo de colisión que el bloque de arriba
// documenta para el `.tex`, sin haber tenido nunca su propio tope.
// ---------------------------------------------------------------------------

test('sectionMarkText: un rótulo corriente no se toca', () => {
  assert.equal(sectionMarkText('Qué significa'), 'Qué significa');
  assert.equal(sectionMarkText(''), '');
  assert.equal(sectionMarkText(undefined), '');
});

test('sectionMarkText: pasado el tope, se recorta con honestidad — el mismo mecanismo que runningTitleText', () => {
  const long = 'x'.repeat(60);
  const capped = sectionMarkText(long);
  assert.equal(capped, `${'x'.repeat(30)}…`);
  assert.equal(capped.length, 31);
});

test('sectionMarkText: el límite es exacto — justo en 30 no hay elipsis, en 31 sí', () => {
  assert.equal(sectionMarkText('x'.repeat(30)), 'x'.repeat(30));
  assert.doesNotMatch(sectionMarkText('x'.repeat(30)), /…/);
  assert.match(sectionMarkText('x'.repeat(31)), /…$/);
});

test('sectionMarkText: el límite se puede ajustar, como el de runningTitleText', () => {
  assert.equal(sectionMarkText('abcdef', 5), 'abcde…');
});
