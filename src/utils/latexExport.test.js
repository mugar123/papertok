import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorLine,
  buildLatexDocument,
  escapeLatexText,
  escapeUrlForLatex,
  isNumberedFormula,
  isSafeMath,
  paragraphChunks,
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
  assert.equal(escapeLatexText('and so on\u2026'), 'and so on\\ldots{}');
  assert.equal(escapeLatexText('7\u00d78'), '7\\texttimes{}8');
  // A non-breaking space is invisible in the source and would be dropped.
  assert.equal(escapeLatexText('5\u00a0km'), '5~km');
});

test('dashes and curly quotes become commands, not ligature sequences', () => {
  // `---`/`--` and `` ` ``/`''` are what an em dash and curly quotes look
  // like as LaTeX SOURCE, and that is what this map used to emit — but a
  // ligature is a font behaviour, not a character, and Latin Modern
  // Typewriter (`\ptmono`, latexExport.js's `\ttfamily`) deliberately does
  // not have it: compiled and rasterized, `a---b` printed as two visibly
  // separate hyphens, not one em dash, with no compiler warning either time.
  // `\textemdash{}` and friends name the character instead of hoping a
  // ligature table catches the source spelling, so they render correctly
  // regardless of font or engine — confirmed by compiling both shapes under
  // both pdfLaTeX and XeLaTeX (task-7-fix-report.md).
  assert.equal(escapeLatexText('the article\u2019s author'), 'the article\\textquoteright{}s author');
  assert.equal(escapeLatexText('a \u2014 b \u2013 c'), 'a \\textemdash{} b \\textendash{} c');
  assert.equal(escapeLatexText('\u201cquoted\u201d'), '\\textquotedblleft{}quoted\\textquotedblright{}');
  assert.equal(escapeLatexText('\u2018single\u2019'), '\\textquoteleft{}single\\textquoteright{}');
  // Escaping still runs first: the mapping must not re-open an escape hatch.
  assert.equal(escapeLatexText('\u2014$x$'), '\\textemdash{}\\$x\\$');
});

test('a section sign becomes \\S{}, not the raw character', () => {
  // XeLaTeX only, same `\ptmono` call sites as the dashes and quotes above:
  // a raw `§` resolved to a Turkish dotted-g (`ğ`) — `exit=0`, nothing in the
  // log, wrong on the rasterized page. `\S{}` is a plain LaTeX command, so it
  // does not depend on the engine's own glyph resolution for that character.
  assert.equal(escapeLatexText('\u00a71 Introduction'), '\\S{}1 Introduction');
});

test('greek letters and maths relations become \\ensuremath commands, one spot check per category', () => {
  // The final review probed 62 plausible characters and found 6 in the map;
  // 25 of the rest made pdflatex refuse a PDF outright, and the other 39
  // vanished under xelatex with exit 0 and nothing in the log — reachable
  // end to end, not hypothetical: latex.js's HTML_ENTITIES decodes &le; to ≤
  // from any OpenAlex title carrying &#8804;. Each assertion below is one
  // representative of a whole category the systematic test further down
  // covers exhaustively; compiled and rendered under both engines, both the
  // roman and \ptmono (\ttfamily) shapes.
  assert.equal(escapeLatexText('α'), '\\ensuremath{\\alpha}'); // Greek lowercase
  assert.equal(escapeLatexText('Δ'), '\\ensuremath{\\Delta}'); // Greek uppercase, distinct glyph
  assert.equal(escapeLatexText('Α'), 'A'); // Greek uppercase, Latin look-alike
  assert.equal(escapeLatexText('≤'), '\\ensuremath{\\leq}'); // relation (the &le; entity)
  assert.equal(escapeLatexText('∞'), '\\ensuremath{\\infty}'); // calculus symbol
  assert.equal(escapeLatexText('→a'), '\\textrightarrow{}a'); // arrow (already shipped, guarded here)
  // `\ensuremath{\prime}` alone compiles but sets the mark at full baseline
  // size, a big slash rather than a tick — `ts1enc.def` declares no
  // `\textprime` either. `{}^\prime` (superscript prime on an empty base) is
  // the form confirmed to render as a small raised prime.
  assert.equal(escapeLatexText('T′'), 'T\\ensuremath{{}^\\prime}');
  assert.equal(escapeLatexText('x⁵'), 'x\\ensuremath{^5}'); // superscript digit
  assert.equal(escapeLatexText('€5'), '\\texteuro{}5'); // currency
  // The sharpest catch of this pass: these four compile and print CORRECTLY
  // as raw UTF-8 under pdfLaTeX, which is exactly what made them look safe —
  // but under XeLaTeX, this exact preamble (babel spanish + Latin Modern, no
  // fontspec) prints a silently WRONG character for each: confirmed
  // rendering both engines side by side, never by reasoning about which
  // characters "should" be fine.
  assert.equal(escapeLatexText('¡Hola!'), '\\textexclamdown{}Hola!');
  assert.equal(escapeLatexText('¿Qué?'), '\\textquestiondown{}Qué?');
  assert.equal(escapeLatexText('3ª'), '3\\textordfeminine{}');
  assert.equal(escapeLatexText('4º'), '4\\textordmasculine{}');
  assert.equal(escapeLatexText('ß'), '\\ss{}');
  // Invisible: a zero-width space has no LICR entry under pdfLaTeX's default
  // UTF-8 handling, which is a hard compile error entirely on its own.
  assert.equal(escapeLatexText('a​b'), 'ab');
});

test('escapeLatexText leaves no codepoint above U+00FF outside a known-safe set', () => {
  // Every positive test above (and the ones before it) proves that a
  // character ALREADY in the map survives. None of them can find the NEXT
  // hole, because a test built from the map can only ever check the map
  // against itself — which is exactly how 56 of 62 characters stayed
  // unmapped for as long as they did. This test does not trust any specific
  // character to be handled: it scans whole Unicode ranges and demands that
  // NOTHING in them survives unescaped except a small, explicit allowlist.
  //
  // The ranges are the ones this fix closes completely, gaps in Unicode's
  // own assignment excluded (verified with `\p{Assigned}`, not guessed):
  // Latin-1 Supplement in full, the Greek alphabet's 24 letters in each
  // case, and the digit/sign superscripts and subscripts. Three further
  // blocks — the rest of Mathematical Operators, Arrows and General
  // Punctuation — carry dozens of set-theory and lattice symbols, hooked and
  // harpoon arrow variants, and spacing marks no plain-language rewrite of a
  // paper has ever been observed to emit; only the members this fix actually
  // added are asserted for those, listed explicitly below rather than
  // implied by a full scan. Letter superscripts/subscripts (U+2071, U+207F,
  // U+2090-U+209C) are the one documented, deliberate gap within an
  // otherwise-closed block: real Unicode assignments, plausible in physics
  // notation (a subscripted "x" for a velocity component), left unmapped
  // because they are rarer than the digit form and each needs its own
  // base-letter command decided empirically — a follow-up, not a hole this
  // fix hides.
  const SAFE_LATIN1_LETTERS = new Set([...(
    'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ'
    + 'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ'
  )]);
  // Verified with \p{Assigned}, not guessed: every codepoint Unicode itself
  // leaves empty inside the two ranges below, plus three more the split at
  // 0x207E/0x2080 in an earlier draft of this test hid (0x208F between the
  // digit and letter subscript runs, 0x209D-0x209F after the letter run
  // ends) -- found by widening the scanned range, which is the whole point
  // of scanning instead of asserting a hand-picked list.
  const DOCUMENTED_GAPS = new Set([
    0x3a2, // Greek uppercase: no capital final sigma
    0x2071, 0x207f, // letter superscripts outside the digit/sign run
    0x2072, 0x2073, // unassigned, inside the digit/sign superscript run
    0x208f, // unassigned, between the subscript digit and letter runs
    0x209d, 0x209e, 0x209f, // unassigned, after the subscript letter run
  ]);
  for (let cp = 0x2090; cp <= 0x209c; cp += 1) DOCUMENTED_GAPS.add(cp);

  const ranges = [
    [0x00a0, 0x00ff], // Latin-1 Supplement, in full
    [0x0391, 0x03a9], // Greek uppercase (0x3a2 is unassigned -- no capital final sigma)
    [0x03b1, 0x03c9], // Greek lowercase
    [0x2070, 0x209f], // Superscripts and Subscripts (0x2072/0x2073 unassigned)
  ];
  const named = [ // the specific Mathematical Operators / Arrows / General
    // Punctuation members this fix adds -- not the whole block, see above.
    0x2264, 0x2265, 0x2248, 0x2260, 0x2261, 0x223c, 0x2243, 0x2245, 0x221d,
    0x226a, 0x226b, 0x2208, 0x2209, 0x2200, 0x2203, 0x2207, 0x221e, 0x221a,
    0x2211, 0x220f, 0x222b, 0x2202, 0x2190, 0x2194, 0x21d2, 0x21d0, 0x21d4,
    0x21a6, 0x2192, 0x2032, 0x2033, 0x200b,
  ];

  const offenders = [];
  const check = cp => {
    if (DOCUMENTED_GAPS.has(cp)) return;
    const char = String.fromCodePoint(cp);
    if (SAFE_LATIN1_LETTERS.has(char)) return;
    const escaped = escapeLatexText(char);
    if (escaped === char) offenders.push(`U+${cp.toString(16).toUpperCase()} (${char})`);
  };
  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp += 1) check(cp);
  }
  named.forEach(check);

  assert.deepEqual(offenders, []);
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

// ---------------------------------------------------------------------------
// El colofón de procedencia
// ---------------------------------------------------------------------------

test('el documento cierra con un colofón de procedencia', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, sections: SECTIONS, annotations: [MARK],
    originalUrl: 'https://arxiv.org/abs/2405.04331',
    generatedAt: new Date(Date.UTC(2026, 8, 4)),
  });
  assert.match(source, /Procedencia/);
  assert.match(source, /Artículo original/);
  assert.match(source, /4 de septiembre de 2026/);
  // Va al final, después de la última sección y antes de cerrar el documento.
  assert.ok(source.indexOf('Procedencia') > source.lastIndexOf('\\section{'));
});

test('el colofón no imprime filas sin dato', () => {
  const { source } = buildLatexDocument({
    paper: { title: 'T', authors: [] }, sections: SECTIONS, annotations: [], originalUrl: '',
  });
  assert.doesNotMatch(source, /Autoría/);
  assert.doesNotMatch(source, /Fuente/);
});

test('la fila de fuente lleva la URL como \\url{} clicable, no como texto escapado', () => {
  // Es el único enlace que le queda al documento: la Task 3 se llevó el
  // \url{} que vivía en el pie de página, y desde entonces hyperref se
  // cargaba sin que nada lo usara. Esta fila es la única que trae la URL
  // cruda (`meta.source`, en la portada, ya la lleva compuesta dentro de una
  // frase), así que es aquí donde el enlace clicable vuelve.
  const { source } = build({ originalUrl: 'https://arxiv.org/abs/2405.04331' });
  assert.match(source, /\\url\{https:\/\/arxiv\.org\/abs\/2405\.04331\}/);
});

test('sin URL original no queda ningún \\url{ suelto ni fila de fuente', () => {
  const { source } = build({ originalUrl: '' });
  assert.doesNotMatch(source, /\\url\{/);
  assert.doesNotMatch(source, /Fuente/);
});

test('la URL del colofón se escapa con las reglas de \\url, no con las de la prosa', () => {
  // `escapeLatexText` convertiría una `~` en `\textasciitilde{}`, que dentro
  // de `\url{}` imprimiría el comando en vez de una tilde. El regex que
  // escapa esta fila es el que traía el pie de página que la Task 3 quitó:
  // solo `%#&_{}$`, la `~` se queda tal cual. La portada compone la misma URL
  // dentro de una frase (`meta.source`) y esa sí pasa por `escapeLatexText`
  // legítimamente — por eso la comprobación de ausencia se acota al colofón,
  // que empieza después de la última sección.
  const { source } = build({ originalUrl: 'https://example.org/~user' });
  const colophonBlock = source.slice(source.lastIndexOf('\\section{'));
  assert.match(colophonBlock, /\\url\{https:\/\/example\.org\/~user\}/);
  assert.doesNotMatch(colophonBlock, /textasciitilde/);
});

test('en inglés la fila de fuente se identifica por clave, no por el texto "Fuente"', () => {
  // `colophonKeys.source` es "Source" en inglés. Si el código comparase
  // contra la cadena española "Fuente" a pelo, este documento no tendría
  // nunca un \url{} clicable.
  const { source } = build({ language: 'en', originalUrl: 'https://arxiv.org/abs/2405.04331' });
  assert.match(source, /Source/);
  assert.match(source, /\\url\{https:\/\/arxiv\.org\/abs\/2405\.04331\}/);
});

// ---------------------------------------------------------------------------
// Dos hallazgos que solo compilar reveló — ningún test de regex los había visto
// ---------------------------------------------------------------------------

test('escapeUrlForLatex: los cuatro que \\url sí entiende con una contrabarra delante', () => {
  // Compilado un documento por carácter y mirada la página: `%`, `#`, `&` y
  // `_` se leen bien con la contrabarra que trae url.sty. Es la única parte
  // de la regla heredada del pie de página que la Task 3 quitó (y que este
  // colofón resucitó en la Task 6) que seguía siendo cierta.
  assert.equal(escapeUrlForLatex('a%b#c&d_e'), 'a\\%b\\#c\\&d\\_e');
});

test('escapeUrlForLatex: llaves y dólar se codifican en porcentaje, no se escapan', () => {
  // Compilado un documento por carácter: con la contrabarra heredada, `{` y
  // `}` imprimían una contrabarra suelta y visible en la página («\{», «\}»
  // tal cual, dos caracteres) y `$` imprimía `\protect\T1\textdollar` — el
  // mecanismo interno de hyperref para las cadenas del PDF, filtrado a la
  // página como si fuera texto del lector. Ninguno de los tres avisaba al
  // compilar. `%7B`/`%7D`/`%24` es la forma canónica de escribir esos tres
  // caracteres en una URL: el enlace resuelve exactamente igual y ahora se
  // ve bien. El `%` que la propia codificación introduce se escapa después
  // con la misma regla que cualquier otro `%` de la URL — de ahí la
  // contrabarra delante de cada `%7B`/`%7D`/`%24`.
  assert.equal(escapeUrlForLatex('a{b}c$d'), 'a\\%7Bb\\%7Dc\\%24d');
});

test('escapeUrlForLatex: los siete caracteres del conjunto original a la vez', () => {
  assert.equal(
    escapeUrlForLatex('a%b#c&d_e{f}g$h'),
    'a\\%b\\#c\\&d\\_e\\%7Bf\\%7Dg\\%24h',
  );
});

test('la fila de fuente conserva % # & _ escapados con contrabarra, en un documento real', () => {
  const { source } = build({ originalUrl: 'https://example.org/a%b#c&d_e' });
  const colophonBlock = source.slice(source.lastIndexOf('\\section{'));
  assert.ok(colophonBlock.includes('\\url{https://example.org/a\\%b\\#c\\&d\\_e}'));
});

test('la fila de fuente codifica en porcentaje las llaves y el dólar de una URL real', () => {
  const { source } = build({ originalUrl: 'https://example.org/{a}$b' });
  const colophonBlock = source.slice(source.lastIndexOf('\\section{'));
  assert.ok(
    colophonBlock.includes('\\url{https://example.org/\\%7Ba\\%7D\\%24b}'),
    'la fila de fuente debe llevar la URL codificada en porcentaje dentro de \\url{}',
  );
});

test('el dólar de la URL nunca filtra el mecanismo interno de hyperref a la página', () => {
  // El hallazgo más grave de los tres: con la contrabarra heredada, un `$`
  // en la URL no imprimía un carácter equivocado, imprimía la maquinaria
  // interna de hyperref como si fuera texto del documento, sin ningún aviso
  // de compilación. Comprobado compilando y mirando la página rasterizada.
  const { source } = build({ originalUrl: 'https://example.org/a$b' });
  assert.doesNotMatch(source, /textdollar/);
  assert.doesNotMatch(source, /\\protect/);
});

test('un título desmesurado se recorta solo en el colofón; la portada conserva el título entero', () => {
  // Compilado: sin tope, este título puede crecer tanto que el \minipage del
  // colofón (Task 6, no puede partirse entre páginas) deja de caber en
  // NINGUNA página — ni siquiera una en blanco — y la página sale con texto
  // solapado e ilegible: peor que el encabezado huérfano que el propio
  // \minipage vino a arreglar. La portada es un campo aparte y sigue sin
  // tope a propósito (`colophonTitleText`, exportDocument.js): es un párrafo
  // corriente y una página corriente sí se parte donde haga falta.
  const long = 'palabra '.repeat(90).trim();
  assert.ok(long.length > 500, 'la prueba necesita un título más largo que el tope de 500');
  const { source } = buildLatexDocument({
    paper: { title: long, authors: [] }, sections: SECTIONS, annotations: [], originalUrl: '',
  });
  assert.ok(source.includes(`{\\LARGE ${long}\\par}`), 'la portada debe conservar el título entero, sin recortar');
  const colophonBlock = source.slice(source.lastIndexOf('\\section{'));
  assert.ok(!colophonBlock.includes(long), 'el colofón no debe llevar el título entero');
  // La fila del título (a diferencia de la de fuente) pasa por
  // `escapeLatexText` como cualquier otra: la elipsis que añade
  // `colophonTitleText` es el mismo carácter Unicode `…` que ya usa el resto
  // del documento, así que llega aquí convertida en `\ldots{}` — la misma
  // regla que ya vale para una elipsis escrita por el modelo en cualquier
  // párrafo, no un mecanismo nuevo.
  assert.ok(
    colophonBlock.includes(`${long.slice(0, 500)}\\ldots{}`),
    'el colofón debe llevar el título recortado a 500 caracteres con una elipsis visible',
  );
});

test('un título corriente no lleva elipsis en ningún sitio del documento', () => {
  assert.doesNotMatch(build().source, /…/);
});

// ---------------------------------------------------------------------------
// La cabecera de las páginas de continuación no puede chocar consigo misma
// (hallazgo de compilar: `\fancyhead[L]` y `\fancyhead[R]` — pageStyles(),
// arriba — no tienen ajuste de línea ni control de colisión propio; con un
// título de portada de 102 caracteres, ni siquiera especialmente largo, se
// imprimieron uno encima del otro, ilegibles, sin un solo aviso de
// compilación. Un caso más suave —el título envolviendo a dos líneas— sí
// avisa, con `fancyhdr Warning: \headheight is too small`, pero tampoco es
// el resultado que se quiere. `runningTitleText` y `sectionMarkText` —
// las dos en exportDocument.js, no aquí — acotan cada zona por separado;
// ver sus propios comentarios para de dónde salen 45 y 30)
// ---------------------------------------------------------------------------

test('un título largo llega recortado a \\fancyhead[L], no entero', () => {
  const long = 'x'.repeat(90);
  const { source } = buildLatexDocument({
    paper: { title: long, authors: [] }, sections: SECTIONS, annotations: [],
  });
  assert.ok(source.includes(`\\fancyhead[L]{\\ptmono\\scriptsize ${'x'.repeat(45)}\\ldots{}}`));
  // Ni un carácter más allá del tope: si el recorte fallara y dejara pasar
  // el título entero (u otro recorte distinto), esta cadena de 46 x's no
  // aparecería en la línea de \fancyhead[L].
  assert.ok(!source.includes(`\\fancyhead[L]{\\ptmono\\scriptsize ${'x'.repeat(46)}`));
});

test('un encabezado de sección largo llega recortado al argumento corto de \\section; el completo se queda intacto en el cuerpo', () => {
  const longHeading = 'x'.repeat(60);
  const { source } = buildLatexDocument({
    paper: PAPER,
    sections: [{ ...SECTIONS[0], heading: longHeading }],
    annotations: [],
  });
  // El argumento CORTO (entre corchetes) es el que alimenta \sectionmark y,
  // de ahí, \leftmark en \fancyhead[R] — el completo (entre llaves) es el
  // título tal cual lo escribió el modelo, y sigue imprimiéndose entero en
  // el cuerpo del documento: nada en el hallazgo pide acortar ESE.
  assert.ok(source.includes(`\\section[${'x'.repeat(30)}\\ldots{}]{${longHeading}}`));
});

test('un encabezado de sección corriente sigue usando \\section{...}, sin el argumento corto', () => {
  // Por debajo del tope, el argumento corto sería idéntico al completo, así
  // que `buildLatexDocument` no lo añade: el documento común (la inmensa
  // mayoría) no cambia de forma por este arreglo.
  const { source } = build();
  assert.doesNotMatch(source, /\\section\[/);
  assert.match(source, /\\section\{De qué va\}/);
});

// ---------------------------------------------------------------------------
// Fórmulas destacadas numeradas (Task 12)
//
// Comprobado contra `paragraphChunks` antes de escribir `emitMath`:
// `splitLatexText` (latex.js) deja `value` sin delimitadores para `$$…$$` y
// `\[…\]` (`value !== raw`), y para un `\begin{...}` propio pone
// `value === raw`, delimitadores incluidos — exactamente lo que el brief
// pedía verificar. El `if` de la Task 12 usa esa distinción tal cual.
// ---------------------------------------------------------------------------

test('una fórmula en bloque sale numerada y una en línea no', () => {
  const display = paragraphChunks('Queda $$a = b$$ demostrado.').find(item => item.display);
  assert.ok(display, 'el fixture tiene que traer una fórmula en bloque');
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{ id: 's1', kind: 'other', heading: 'H', paragraphs: ['Queda $$a = b$$ demostrado.'] }],
  });
  assert.match(source, /\\begin\{equation\}/);
  assert.doesNotMatch(source, /\$\$/);
  // El cuerpo es el interior desnudo (`value`), no el `raw` con delimitadores.
  assert.match(source, /\\begin\{equation\}\na = b\n\\end\{equation\}/);
  const inline = renderParagraph('vale $x^2$ hoy', []);
  assert.doesNotMatch(inline, /\\begin\{equation\}/);
  assert.match(inline, /\$x\^2\$/);
});

test('\\[…\\] se numera igual que $$…$$', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{ id: 's1', kind: 'other', heading: 'H', paragraphs: ['Queda \\[a = b\\] demostrado.'] }],
  });
  assert.match(source, /\\begin\{equation\}\na = b\n\\end\{equation\}/);
  // Comprobación exacta, no una regex de `\[` suelta: el colofón lleva sus
  // propias `\\[3pt]` (el argumento de espaciado de \\, nada que ver con el
  // delimitador de fórmula) y un `doesNotMatch` genérico las confundiría.
  assert.ok(!source.includes('\\[a = b\\]'), 'el delimitador original no debe sobrevivir sin envolver');
});

test('una fórmula en bloque que no es segura no se envuelve en equation', () => {
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{ id: 's1', kind: 'other', heading: 'H', paragraphs: ['Queda $$\\input{/etc/passwd}$$ ahi.'] }],
  });
  assert.doesNotMatch(source, /\\begin\{equation\}/);
  assert.match(source, /textbackslash/);
});

test('un entorno que el modelo ya escribió no se envuelve otra vez, y sigue numerándose solo (LaTeX lo hace)', () => {
  // Ya cubierto por el test de más arriba ("an environment keeps its own
  // delimiters..."), repetido aquí con el vocabulario de esta tarea: el
  // guard es `item.display && item.value !== item.raw`, así que un
  // `\begin{equation}` propio (`value === raw`) cae al último `return
  // item.raw` sin pasar por el wrap — y sigue siendo un entorno `equation`
  // real, que LaTeX numera por su cuenta al compilar.
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [{
      id: 's1', kind: 'other', heading: 'H',
      paragraphs: ['La ecuacion \\begin{equation} E = mc^2 \\end{equation} lo dice.'],
    }],
  });
  assert.match(source, /\\begin\{equation\} E = mc\^2 \\end\{equation\}/);
  assert.doesNotMatch(source, /\\begin\{equation\}\n\\begin\{equation\}/);
});

test('varias fórmulas en varias secciones producen varios \\begin{equation}, uno por fórmula', () => {
  // La numeración correlativa (1), (2), (3)… la da LaTeX al compilar el
  // contador nativo de `equation`; lo que este test comprueba a nivel de
  // fuente es que cada fórmula segura en bloque abre su propio entorno, en
  // el orden del documento, sin fusionarse ni perderse ninguna.
  const { source } = buildLatexDocument({
    paper: PAPER, annotations: [],
    sections: [
      { id: 's1', kind: 'other', heading: 'Uno', paragraphs: ['Primero: $$a = 1$$ y ya.'] },
      { id: 's2', kind: 'other', heading: 'Dos', paragraphs: ['Segundo: $$b = 2$$.', 'Tercero: \\[c = 3\\].'] },
    ],
  });
  const matches = [...source.matchAll(/\\begin\{equation\}\n(.*?)\n\\end\{equation\}/g)].map(m => m[1]);
  assert.deepEqual(matches, ['a = 1', 'b = 2', 'c = 3']);
});

test('una fórmula en bloque cubierta por un subrayado del lector no se envuelve en equation', () => {
  // Hallazgo de compilar, no de razonar: `\hl{\begin{equation}...\end{equation}}`
  // (soul) da "LaTeX Error: Environment {equation} undefined" — fatal, y se
  // lleva el documento por delante — mientras que `\hl{$$a = b$$}`, lo que
  // el código emitía antes de esta tarea, compila limpio. `soul` encaja su
  // argumento en una caja para dibujar el resaltado detrás; `equation` no
  // cabe en una caja así. Una fórmula marcada se queda sin número, tal cual
  // estaba antes de esta tarea, en vez de romper el documento entero.
  const out = renderParagraph('Antes. $$a = b$$ Despues.', [
    { id: 'm1', kind: 'user', quote: '$$a = b$$' },
  ], LABELS);
  assert.doesNotMatch(out, /\\begin\{equation\}/);
  assert.match(out, /\\hl\{\$\$a = b\$\$\}/);
});

test('una fórmula en bloque cubierta por una marca de IA tampoco se envuelve', () => {
  // La misma comprobación con `\dotuline` (ulem, la marca de la IA):
  // compilado, `\dotuline{\begin{equation}...\end{equation}}` da "Missing $
  // inserted" — también fatal, con un mensaje distinto al de `\hl` pero el
  // mismo resultado: el documento no compila.
  const out = renderParagraph('Antes. $$a = b$$ Despues.', [
    { id: 'm1', kind: 'ai', quote: '$$a = b$$' },
  ], LABELS);
  assert.doesNotMatch(out, /\\begin\{equation\}/);
  assert.match(out, /\\dotuline\{\$\$a = b\$\$\}/);
});

// ---------------------------------------------------------------------------
// El .tex y el PDF no pueden numerar distinto la misma fórmula
// ---------------------------------------------------------------------------

test('isNumberedFormula da la misma respuesta en cada forma de fórmula, tabla por tabla', () => {
  // Antes de `isNumberedFormula` los dos formatos deletreaban esta puerta de
  // dos formas distintas -- `.tex` con `item.value !== item.raw`, el PDF sin
  // esa condición -- y solo coincidían por suerte; así fue como la deriva de
  // `eqnarray` entró sin que ningún test la viera. Esta tabla recorre cada
  // forma que `splitLatexText` (latex.js) produce para una fórmula y pasa
  // cada una por el MISMO predicado que hoy llaman los dos emisores
  // (`emitMath` aquí, `numberedEquation` en pdfExport.js): si algún día
  // vuelven a deletrearlo distinto, esta prueba dejará de tener sentido
  // antes de dejar de pasar, que es la señal de que el invariante se rompió.
  const cases = [
    ['$...$ en línea (no es de bloque)', 'vale $x=1$ hoy', false],
    ['$$...$$ de bloque', 'vale $$x=1$$ hoy', true],
    ['\\[...\\] de bloque', 'vale \\[x=1\\] hoy', true],
    ['\\begin{equation} que ya trae el modelo', 'vale \\begin{equation}x=1\\end{equation} hoy', true],
    ['\\begin{eqnarray} que ya trae el modelo', 'vale \\begin{eqnarray}x&=&1\\end{eqnarray} hoy', true],
    ['fórmula insegura', 'vale $$\\input{x}$$ hoy', false],
  ];
  for (const [label, text, numbered] of cases) {
    const chunk = paragraphChunks(text).find(item => item.type === 'math');
    assert.equal(isNumberedFormula(chunk), numbered, label);
  }
  // La sexta fila de la tabla, marcada: ni un subrayado del lector ni una
  // marca de la IA dejan pasar el número, en ninguno de los dos formatos.
  const bare = paragraphChunks('vale $$x=1$$ hoy').find(item => item.type === 'math');
  for (const kind of ['user', 'ai']) {
    assert.equal(isNumberedFormula({ ...bare, kind }), false, `marcada (${kind})`);
  }
});
