import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorLine,
  buildLatexDocument,
  documentCopy,
  escapeLatexText,
  exportFileName,
  isSafeMath,
  numberAnnotations,
  renderParagraph,
  summarizeExport,
} from './latexExport.js';

/**
 * Every expectation here was established by compiling the output with pdfLaTeX
 * and looking at the page, not by reasoning about LaTeX. Three of them exist
 * because the reasoning had been wrong.
 */

const LABELS = { mine: 'Tuya', ai: 'IA' };

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

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

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
  assert.match(source, /\\title\{Correladores \\& el 100\\% del ruido\\_medido\}/);
  assert.match(source, /\\author\{\\parbox\{0\.9\\textwidth\}\{\\centering Allic Sivaramakrishnan, M\. Ángeles Pérez\}\}/);
  assert.match(source, /nivel universitario/);
});

test('provenance is a page footer, not one of the notes', () => {
  const { source } = build();
  assert.match(source, /\\fancyfoot\[L\]/);
  assert.match(source, /No es obra de sus autores/);
  assert.match(source, /\\url\{https:\/\/arxiv\.org\/abs\/2405\.04331\}/);
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

test('a long byline is cut with et al. rather than run on for a page', () => {
  const many = { authors: Array.from({ length: 30 }, (_, i) => ({ name: `Autor ${i}` })) };
  assert.match(authorLine(many), /Autor 11 et al\.\}$/);
  assert.equal(authorLine({ authors: [] }), '');
  assert.equal(authorLine({}), '');
  // Authors sometimes arrive as bare strings rather than objects.
  assert.match(authorLine({ authors: ['Ada Lovelace'] }), /Ada Lovelace/);
});

test('the byline wraps instead of running off the page', () => {
  // Nine authors is an ordinary paper. Compiled and looked at: bare `\\author`
  // set them on one line and the last two names were off the paper.
  const nine = { authors: Array.from({ length: 9 }, (_, i) => `Autor Apellido ${i}`) };
  assert.match(authorLine(nine), /^\\parbox\{0\.9\\textwidth\}\{\\centering /);
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

test('the card can count what it is about to export without building it', () => {
  assert.deepEqual(summarizeExport([
    { quote: 'a', kind: 'user' },
    { quote: 'b', kind: 'user', note: 'x' },
    { quote: 'c', kind: 'ai', note: 'y' },
    { quote: '', kind: 'user' },
  ]), { marks: 1, mine: 1, ai: 1 });
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

test('the file name can carry another extension for the other formats', () => {
  assert.equal(
    exportFileName({ title: 'Ñandú en Ávila' }, 'en', 'pdf'),
    'nandu-en-avila-plain-words.pdf',
  );
  assert.equal(exportFileName({}, 'es', 'pdf'), 'paper-en-simple.pdf');
});

test('documentCopy hands each language its own strings, and defaults to Spanish', () => {
  assert.match(documentCopy('en').provenance, /Rewritten by PaperTok/);
  assert.match(documentCopy('es').provenance, /Reescrito por PaperTok/);
  assert.match(documentCopy('fr').provenance, /Reescrito por PaperTok/);
  assert.equal(documentCopy('es').levels.university, 'universitario');
});
