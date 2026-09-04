import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorLine,
  buildLatexDocument,
  escapeLatexText,
  isSafeMath,
  renderParagraph,
} from './latexExport.js';

/**
 * Every expectation here was established by compiling the output with pdfLaTeX
 * and looking at the page, not by reasoning about LaTeX. Three of them exist
 * because the reasoning had been wrong.
 */

const LABELS = { mine: 'Tuya', ai: 'IA' };

const MARK = {
  id: 'a1', sectionId: 's1', paragraphIndex: 0, kind: 'user',
  quote: 'Los autores calculan', note: 'Una nota.',
};

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

test('a backslash does not eat the braces the escape itself inserts', () => {
  // The bug this catches shipped in the first draft and compiled cleanly: the
  // backslash was replaced with `\textbackslash{}` and a later pass escaped the
  // braces that replacement had just added, printing `\{}` on the page.
  assert.equal(escapeLatexText('a \\ b'), 'a \\textbackslash{} b');
  assert.equal(escapeLatexText('~'), '\\textasciitilde{}');
  assert.equal(escapeLatexText('^'), '\\textasciicircum{}');
});

test('every special character LaTeX reserves is escaped', () => {
  assert.equal(
    escapeLatexText('{ } $ & # _'),
    '\\{ \\} \\$ \\& \\# \\_',
  );
});

test('the percent normalizeLatexText already escaped is not escaped twice', () => {
  // `normalizeLatexText` runs before this and turns every `%` into `\%`.
  // Escaping the backslash of that pair would print a literal `\%`.
  assert.equal(escapeLatexText('el 100\\% de los casos'), 'el 100\\% de los casos');
  assert.equal(escapeLatexText('el 100% de los casos'), 'el 100\\% de los casos');
});

test('empty and missing values escape to nothing rather than to "undefined"', () => {
  assert.equal(escapeLatexText(undefined), '');
  assert.equal(escapeLatexText(null), '');
  assert.equal(escapeLatexText(''), '');
});

// ---------------------------------------------------------------------------
// What may reach the file as live LaTeX
// ---------------------------------------------------------------------------

test('a control word ending in a digit is still caught', () => {
  // `\b` was the wrong boundary and let this through: there is no word boundary
  // between the `e` of `write` and the `1` of `18`. Compiled, it vanished from
  // the page silently.
  assert.equal(isSafeMath('\\write18{rm -rf /}'), false);
});

test('the file and shell primitives are refused', () => {
  for (const attack of [
    '\\input{/etc/passwd}',
    '\\include{secret}',
    '\\openout15=x',
    '\\read1 to \\x',
    '\\def\\x{y}',
    '\\gdef\\x{y}',
    '\\csname relax\\endcsname',
    '\\immediate\\write16{hi}',
    '\\catcode`\\%=11',
    '\\directlua{os.execute("x")}',
    '\\loop\\repeat',
    '\\usepackage{shellesc}',
  ]) {
    assert.equal(isSafeMath(attack), false, `should refuse: ${attack}`);
  }
});

test('an attempt to end the document early is refused', () => {
  assert.equal(isSafeMath('x \\end{document} y'), false);
  assert.equal(isSafeMath('x \\end {document} y'), false);
});

test('ordinary mathematics is not refused', () => {
  for (const formula of [
    '\\langle \\tau^2 \\rangle - \\langle \\tau \\rangle^2',
    '\\frac{a}{b}',
    '\\sum_{q \\le Q} c_q(n)',
    '\\sqrt{E}',
    '\\mathcal{F}_i',
    '[M : N]',
    // `\begin`/`\end` stay allowed: an aligned block is ordinary maths, and
    // denying it costs more real formulas than it protects.
    '\\begin{aligned} x &= 1 \\end{aligned}',
  ]) {
    assert.equal(isSafeMath(formula), true, `should allow: ${formula}`);
  }
});

test('a refused formula is shown as its source, never dropped', () => {
  const out = renderParagraph('Mira esto: $\\input{/etc/passwd}$ y ya.', []);
  assert.match(out, /textbackslash\{\}input/);
  assert.doesNotMatch(out, /\$\\input/);
});

// ---------------------------------------------------------------------------
// Highlights and notes
// ---------------------------------------------------------------------------

test('a highlight that spans a formula comes out as ONE swatch', () => {
  // `soul` carries inline maths and line breaks perfectly well — verified by
  // compiling. Emitting two adjacent \hl would leave a seam down the formula.
  const text = 'La varianza $\\langle \\tau^2 \\rangle$ deja de anularse hoy.';
  const out = renderParagraph(text, [
    { id: 'a1', kind: 'user', quote: 'La varianza $\\langle \\tau^2 \\rangle$ deja de anularse' },
  ], LABELS);
  assert.equal((out.match(/\\hl\{/g) || []).length, 1);
  assert.match(out, /\\hl\{La varianza \$\\langle \\tau\^2 \\rangle\$ deja de anularse\}/);
});

test('a note becomes a footnote right after the swatch, not inside it', () => {
  // Inside, the marker escapes the colour and leaves a gap — compiled and seen.
  const out = renderParagraph('Una frase larga que se subraya entera.', [
    { id: 'a1', kind: 'user', quote: 'Una frase larga que se subraya entera', note: 'Mi nota.' },
  ], LABELS);
  assert.match(out, /\\hl\{[^}]*\}\\footnote\{\\ptkind\{Tuya\}\\quad Mi nota\.\}/);
});

test('the note says who wrote it', () => {
  const mine = renderParagraph('Una frase larga que se subraya entera.', [
    { id: 'a1', kind: 'user', quote: 'Una frase larga que se subraya entera', note: 'x' },
  ], LABELS);
  const theirs = renderParagraph('Una frase larga que se subraya entera.', [
    { id: 'a1', kind: 'ai', quote: 'Una frase larga que se subraya entera', note: 'x' },
  ], LABELS);
  assert.match(mine, /\\ptkind\{Tuya\}/);
  assert.match(theirs, /\\ptkind\{IA\}/);
});

test('a bare highlight gets colour and no footnote', () => {
  const out = renderParagraph('Una frase larga que se subraya entera.', [
    { id: 'a1', kind: 'user', quote: 'Una frase larga que se subraya entera' },
  ], LABELS);
  assert.match(out, /\\hl\{/);
  assert.doesNotMatch(out, /\\footnote/);
});

test('a note is escaped like any other prose', () => {
  const out = renderParagraph('Una frase larga que se subraya entera.', [
    { id: 'a1', kind: 'user', quote: 'Una frase larga que se subraya entera', note: '100% & _esto_' },
  ], LABELS);
  assert.match(out, /100\\% \\& \\_esto\\_/);
});

test('a paragraph with nothing marked is just escaped prose', () => {
  const out = renderParagraph('Sin nada que marcar, con un 50% y $x^2$.', []);
  assert.doesNotMatch(out, /\\hl/);
  assert.match(out, /50\\%/);
  assert.match(out, /\$x\^2\$/);
});

test('la marca del lector es lavado y la de la IA, punteado', () => {
  const text = 'Los autores calculan el tiempo propio de la particula.';
  const mine = { id: 'm', kind: 'user', quote: 'Los autores calculan' };
  const ai = { id: 'a', kind: 'ai', quote: 'el tiempo propio' };
  const out = renderParagraph(text, [mine, ai], LABELS);
  assert.match(out, /\\hl\{Los autores calculan\}/);
  assert.match(out, /\\dotuline\{el tiempo propio\}/);
});

test('una marca de la IA que cruza una fórmula sigue siendo un solo comando', () => {
  // El mismo motivo que ya tenía \hl: dos comandos seguidos dejan una costura
  // visible a mitad de la marca. \dotuline admite matemáticas dentro y parte
  // entre líneas — compilado y mirado.
  const text = 'La anchura $\\tau$ crece con la energia.';
  const ai = { id: 'a', kind: 'ai', quote: 'La anchura $\\tau$ crece' };
  const out = renderParagraph(text, [ai], LABELS);
  assert.equal(out.match(/\\dotuline\{/g).length, 1);
});

test('la nota va detrás de la marca, sea del tipo que sea', () => {
  const text = 'Los autores calculan el tiempo propio.';
  const ai = { id: 'a', kind: 'ai', quote: 'Los autores calculan', note: 'Ojo.' };
  const out = renderParagraph(text, [ai], LABELS);
  assert.match(out, /\\dotuline\{Los autores calculan\}\\footnote\{\\ptkind\{IA\}/);
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const PAPER = {
  title: 'Correladores & el 100% del ruido_medido',
  authors: [{ name: 'Allic Sivaramakrishnan' }, { name: 'M. Ángeles Pérez' }],
};

const SECTIONS = [{
  id: 's1',
  kind: 'abstract',
  heading: 'De qué va',
  paragraphs: ['Los autores calculan $\\tau$ y encuentran una distribucion nueva.'],
}];

function build(overrides = {}) {
  return buildLatexDocument({
    paper: PAPER,
    sections: SECTIONS,
    annotations: [],
    language: 'es',
    level: 'university',
    kindLabels: { abstract: 'Resumen' },
    originalUrl: 'https://arxiv.org/abs/2405.04331',
    ...overrides,
  });
}

test('the preamble does not declare a font the compiling machine may not have', () => {
  // Newsreader is self-hosted as a bundled webfont (@fontsource-variable),
  // not a font file installed on the compiling machine, so a live
  // `\setmainfont` line fails outright. Commented out, the file builds with
  // pdflatex as well as xelatex.
  const { source } = build();
  assert.match(source, /^% \\setmainfont\{Newsreader\}$/m);
  assert.doesNotMatch(source, /^\\setmainfont/m);
  assert.match(source, /\\usepackage\{lmodern\}/);
});

test('Spanish keeps the decimal point inside maths', () => {
  // Without es-nodecimaldot, babel rewrites `$0.02$` as `0,02` — silently
  // changing the paper's numbers. Seen on the compiled page.
  assert.match(build().source, /\\usepackage\[spanish,es-nodecimaldot,es-noquoting\]\{babel\}/);
  assert.match(build({ language: 'en' }).source, /\\usepackage\[english\]\{babel\}/);
});

test('the title, the authors and the level travel with the file', () => {
  const { source } = build();
  assert.match(source, /\{\\LARGE Correladores \\& el 100\\% del ruido\\_medido\\par\}/);
  assert.match(source, /\{\\large Allic Sivaramakrishnan, M\. Ángeles Pérez\\par\}/);
  assert.match(source, /Nivel universitario/);
});

test('provenance is a page footer, not one of the notes', () => {
  const { source } = build();
  assert.match(source, /\\fancyfoot\[L\]/);
  assert.match(source, /No es obra de sus autores/);
  // The cover prints the source URL as escaped text in its source line now,
  // not as a clickable \url{} — that comes back later, in the colophon's
  // "Fuente" row, which this task does not build.
  assert.match(source, /https:\/\/arxiv\.org\/abs\/2405\.04331/);
  // It must never be a numbered footnote: those belong to the reader's notes.
  assert.doesNotMatch(source, /\\footnote\{[^}]*No es obra/);
});

test('a paper with no link still gets a footer', () => {
  const { source } = build({ originalUrl: '' });
  assert.match(source, /\\fancyfoot\[L\]/);
  assert.doesNotMatch(source, /\\url\{\}/);
});

test('what the reader chose not to include is not in the file', () => {
  const annotations = [
    { id: 'm', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'Los autores calculan' },
    { id: 'n', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'una distribucion nueva', note: 'mia' },
    { id: 'i', sectionId: 's1', paragraphIndex: 0, kind: 'ai', quote: 'y encuentran una', note: 'del modelo' },
  ];
  assert.match(build({ annotations }).source, /mia/);
  assert.doesNotMatch(build({ annotations, include: { mine: false } }).source, /mia/);
  assert.doesNotMatch(build({ annotations, include: { ai: false } }).source, /del modelo/);
  // Turning off bare marks must not take the notes with them.
  const noMarks = build({ annotations, include: { marks: false } }).source;
  assert.match(noMarks, /mia/);
});

test('soul is only pulled in when something is actually highlighted', () => {
  assert.doesNotMatch(build().source, /\\usepackage\{soul\}/);
  const withMark = build({
    annotations: [{ id: 'm', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'Los autores calculan' }],
  });
  assert.match(withMark.source, /\\usepackage\{soul\}/);
});

test('un documento con marcas de la IA nada más no carga soul', () => {
  // `ulem` se carga siempre (Task 3); `soul` solo hace falta para `\hl`, y un
  // documento con marcas de la IA pero ninguna del lector no usa `\hl`. Emitir
  // `\sethlcolor` sin `soul` cargado no compila, así que esto es lo único que
  // `hasHighlights` tenía que afinar.
  const { source } = build({
    annotations: [{ id: 'a', sectionId: 's1', paragraphIndex: 0, kind: 'ai', quote: 'Los autores calculan' }],
  });
  assert.doesNotMatch(source, /\\usepackage\{soul\}/);
  assert.doesNotMatch(source, /\\sethlcolor/);
  assert.match(source, /\\dotuline\{Los autores calculan\}/);
});

test('the document is closed exactly once', () => {
  const { source } = build();
  assert.equal((source.match(/\\begin\{document\}/g) || []).length, 1);
  assert.equal((source.match(/\\end\{document\}/g) || []).length, 1);
});

test('a section with no heading falls back to its kind, then to a generic word', () => {
  const noHeading = buildLatexDocument({
    paper: PAPER,
    sections: [{ id: 's1', kind: 'methods', paragraphs: ['Texto.'] }],
    kindLabels: { methods: 'Método' },
  });
  assert.match(noHeading.source, /\\section\{Método\}/);
  const unknown = buildLatexDocument({
    paper: PAPER,
    sections: [{ id: 's1', kind: 'nonesuch', paragraphs: ['Texto.'] }],
  });
  assert.match(unknown.source, /\\section\{Sección\}/);
});

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

test('a long byline is cut with et al. rather than run on for a page', () => {
  const many = { authors: Array.from({ length: 30 }, (_, i) => ({ name: `Autor ${i}` })) };
  assert.match(authorLine(many), /Autor 11 et al\.$/);
  assert.equal(authorLine({ authors: [] }), '');
  assert.equal(authorLine({}), '');
  // Authors sometimes arrive as bare strings rather than objects.
  assert.match(authorLine({ authors: ['Ada Lovelace'] }), /Ada Lovelace/);
});

test('the byline wraps instead of running off the page', () => {
  // Nine authors is an ordinary paper. Compiled and looked at: bare `\author`
  // set them on one line and the last two names ran off the page. A centred
  // `\parbox` fixed that once, but the cover is flush left now and `flushleft`
  // wraps ordinary text on its own — so nine names come back as one plain,
  // comma-joined line, not a manually wrapped box.
  const names = Array.from({ length: 9 }, (_, i) => `Autor Apellido ${i}`);
  assert.equal(authorLine({ authors: names }), names.join(', '));
});

test('typographic punctuation survives pdflatex', () => {
  // Accented letters go through UTF-8 fine, which is what made this look
  // solved. These do not: `\u00b7` compiled to `\u00fb` and a curly apostrophe
  // silently vanished from the middle of a word.
  assert.equal(escapeLatexText('un \u00b7 dos'), 'un \\textperiodcentered{} dos');
  assert.equal(escapeLatexText('the article\u2019s author'), "the article's author");
  assert.equal(escapeLatexText('a \u2014 b \u2013 c'), 'a --- b -- c');
  assert.equal(escapeLatexText('\u201cquoted\u201d'), "``quoted''");
  assert.equal(escapeLatexText('and so on\u2026'), 'and so on\\ldots{}');
  assert.equal(escapeLatexText('7\u00d78'), '7\\texttimes{}8');
  // A non-breaking space is invisible in the source and would be dropped.
  assert.equal(escapeLatexText('5\u00a0km'), '5~km');
  // Escaping still runs first: the mapping must not re-open an escape hatch.
  assert.equal(escapeLatexText('\u2014$x$'), '---\\$x\\$');
});

// ---------------------------------------------------------------------------
// The three the first round of tests did not catch
// ---------------------------------------------------------------------------

test('an environment keeps its own delimiters instead of being wrapped again', () => {
  // `splitLatexText` sets `value === raw` for a `\begin{...}` block, delimiters
  // included. Wrapping that in `$...$` produced `$\begin{equation}...$`, which
  // does not compile and takes the rest of the paragraph with it.
  const out = renderParagraph('La ecuacion \\begin{equation} E = mc^2 \\end{equation} lo dice.', []);
  assert.match(out, /\\begin\{equation\} E = mc\^2 \\end\{equation\}/);
  assert.doesNotMatch(out, /\$\\begin/);
});

test('inline maths keeps the delimiter the model actually wrote', () => {
  assert.match(renderParagraph('vale $x^2$ hoy', []), /\$x\^2\$/);
  assert.match(renderParagraph('vale \\(x^2\\) hoy', []), /\\\(x\^2\\\)/);
});

test('angle brackets do not come out as inverted punctuation', () => {
  assert.equal(escapeLatexText('a < b > c'), 'a \\textless{} b \\textgreater{} c');
});

test('an annotation made at another level is not exported into this one', () => {
  // The rail holds every annotation for the paper regardless of level; the marks
  // in the text are filtered. Exporting the rail's list put notes written on
  // other words into a document that no longer contains them.
  const annotations = [
    { id: 'here', sectionId: 's1', paragraphIndex: 0, kind: 'user', level: 'university', language: 'es', quote: 'Los autores calculan', note: 'de este nivel' },
    { id: 'other', sectionId: 's1', paragraphIndex: 0, kind: 'user', level: 'beginner', language: 'es', quote: 'Los autores calculan', note: 'de otro nivel' },
    { id: 'english', sectionId: 's1', paragraphIndex: 0, kind: 'user', level: 'university', language: 'en', quote: 'Los autores calculan', note: 'de otro idioma' },
  ];
  const { source } = build({ annotations });
  assert.match(source, /de este nivel/);
  assert.doesNotMatch(source, /de otro nivel/);
  assert.doesNotMatch(source, /de otro idioma/);
});

test('an annotation whose section this rewrite does not have is dropped', () => {
  const { source } = build({
    annotations: [
      { id: 'orphan', sectionId: 'gone', paragraphIndex: 0, kind: 'user', quote: 'algo', note: 'huerfana' },
    ],
  });
  assert.doesNotMatch(source, /huerfana/);
});

test('an annotation with no level recorded is kept, not guessed at', () => {
  // Older highlights predate the field. Dropping them would delete history.
  const { source } = build({
    annotations: [
      { id: 'legacy', sectionId: 's1', paragraphIndex: 0, kind: 'user', quote: 'Los autores calculan', note: 'antigua' },
    ],
  });
  assert.match(source, /antigua/);
});

// ---------------------------------------------------------------------------
// The preamble and the page styles (the separata)
// ---------------------------------------------------------------------------

test('el preámbulo declara los paquetes que la separata necesita', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.match(source, /\\usepackage\{titlesec\}/);
  assert.match(source, /\\usepackage\[normalem\]\{ulem\}/);
  assert.match(source, /\\usepackage\{fancyhdr\}/);
  assert.match(source, /headheight=14pt/);
});

test('ulem se carga normalem o se lleva por delante toda la cursiva', () => {
  // Sin [normalem], ulem redefine \emph como subrayado. Compilado y mirado.
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.doesNotMatch(source, /\\usepackage\{ulem\}/);
});

test('el amarillo del documento es el lavado, no el de la marca en pantalla', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [MARK],
  });
  assert.match(source, /\\definecolor\{ptWash\}\{HTML\}\{FFE066\}/);
  assert.doesNotMatch(source, /FFD21E/);
});

test('la primera página lleva cabecera de identidad y las demás titulillo', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [], originalUrl: 'https://arxiv.org/abs/2405.04331',
  });
  assert.match(source, /\\fancypagestyle\{ptfirst\}/);
  assert.match(source, /\\renewcommand\{\\sectionmark\}/);
  assert.match(source, /\\leftmark/);
});

// ---------------------------------------------------------------------------
// El cuerpo del documento (la separata): portada, aviso y secciones
// ---------------------------------------------------------------------------

test('la portada va en bandera: ni maketitle ni abstract', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  // `\thispagestyle{ptfirst}` se emite aquí, en el cuerpo — la Task 3 solo
  // DEFINE el estilo; quien lo aplica a la página 1 es esta portada.
  assert.match(source, /\\begin\{document\}\n\\thispagestyle\{ptfirst\}/);
  assert.doesNotMatch(source, /\\maketitle/);
  assert.doesNotMatch(source, /begin\{abstract\}/);
  assert.match(source, /\\begin\{flushleft\}/);
});

test('el aviso lleva su etiqueta al margen y no es un resumen', () => {
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  assert.match(source, /\\begin\{minipage\}\[t\]\{58pt\}\\ptmono\\scriptsize Aviso/);
});

test('el encabezado original del paper se imprime bajo el título de sección', () => {
  const { source } = buildLatexDocument({
    paper: PAPER,
    sections: [{ ...SECTIONS[0], originalHeading: '2. Methods & results' }],
    annotations: [],
  });
  assert.match(source, /\\ptorig\{2\. Methods \\& results\}/);
});

test('una sección sin encabezado original no deja un ptorig vacío', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: [{ ...SECTIONS[0], originalHeading: '' }], annotations: [],
  });
  // El preámbulo define `\ptorig` sin condición (`\newcommand{\ptorig}[1]{...}`,
  // que ya termina en `}`, no en `{`), así que un `doesNotMatch` de `\ptorig` a
  // secas se dispara contra esa definición y no contra ningún uso. Lo que
  // importa es que no se invoque: `\ptorig{` con la llave de apertura.
  assert.doesNotMatch(source, /\\ptorig\{/);
});

test('el byline es una línea de texto, no una caja centrada', () => {
  assert.equal(authorLine({ authors: [{ name: 'A. Perez' }, { name: 'B. Ruiz' }] }), 'A. Perez, B. Ruiz');
  assert.doesNotMatch(authorLine({ authors: [{ name: 'A' }] }), /parbox/);
});

// ---------------------------------------------------------------------------
// La sangría del primer párrafo (con y sin encabezado original)
// ---------------------------------------------------------------------------

test('una sección sin encabezado original abre a bandera igual que una que sí lo tiene', () => {
  // `\ptorig` era lo único que apagaba la sangría que babel español reactiva
  // tras `\titlespacing*{\section}` (su asterisco debería bastar y no basta
  // con babel de por medio): una sección sin encabezado original no lo
  // invocaba, y compilado con pdflatex y mirada la página, su primer párrafo
  // salía sangrado mientras el de una sección con encabezado salía a
  // bandera — el mismo documento inconsistente consigo mismo. Un documento
  // con las dos clases de sección es el único caso que distingue los dos
  // caminos: comprobar solo la sección con encabezado (como hacía el test de
  // arriba) es justo lo que dejó pasar el fallo.
  const { source } = buildLatexDocument({
    paper: PAPER,
    sections: [
      { ...SECTIONS[0], id: 's1', heading: 'Con encabezado', originalHeading: '2. Methods & results' },
      { ...SECTIONS[0], id: 's2', heading: 'Sin encabezado', originalHeading: '' },
    ],
    annotations: [],
  });
  assert.match(source, /\\section\{Con encabezado\}\n\\ptorig\{2\. Methods \\& results\}\n/);
  assert.match(source, /\\section\{Sin encabezado\}\n\\ptnoorig\n/);
});

test('el tramo que apaga la sangría es el mismo con o sin encabezado original', () => {
  // No basta con apagar la sangría: si el camino sin encabezado deja un
  // espacio distinto encima del primer párrafo, es un defecto peor que el
  // que se corrige. `\ptnoorig` tiene que cancelar el mismo after-sep de
  // `\titlespacing*` (-5pt) y sustituirlo por el mismo hueco (3pt) que usa
  // el tramo final de `\ptorig`, no un valor reinventado — así que los dos
  // números se leen de la fuente en vez de repetirlos a mano en el test.
  const { source } = buildLatexDocument({ paper: PAPER, sections: SECTIONS, annotations: [] });
  const withOrigin = source.match(
    /\\newcommand\{\\ptorig\}\[1\]\{\\vspace\{(-?[\d.]+pt)\}\\par\\noindent\{[\s\S]*?\\par\\vspace\{(-?[\d.]+pt)\}\\noindent\\ignorespaces\}/,
  );
  const withoutOrigin = source.match(
    /\\newcommand\{\\ptnoorig\}\{\\vspace\{(-?[\d.]+pt)\}\\par\\vspace\{(-?[\d.]+pt)\}\\noindent\\ignorespaces\}/,
  );
  assert.ok(withOrigin, '\\ptorig debe seguir definido con el mismo tramo final');
  assert.ok(withoutOrigin, '\\ptnoorig debe estar definido');
  assert.equal(withoutOrigin[1], withOrigin[1], 'el after-sep cancelado debe ser el mismo número');
  assert.equal(withoutOrigin[2], withOrigin[2], 'el hueco antes del párrafo debe ser el mismo número');
});
