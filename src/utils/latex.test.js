import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ScientificText from '../components/ScientificText.js';
import { loadKatex } from './katexLoader.js';
import { displayProse, katexSource, normalizeLatexText, normalizeScientificMarkup, proseSourceOffset, splitLatexText } from './latex.js';

const PHOTINO_ABSTRACT = 'A lower bound for the photino mass ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}}$ as a function of the spin-0 fermion superpartner mass ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}$ is derived as an extension of the calculation of Lee and Weinberg. The Majorana nature of the photino induces a $p$-wave threshold for annihilation $\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}\\ensuremath{\\rightarrow}f\\overline{f}$ into light fermions, and leads to a rather unexpected form for the bound: for $25 \\mathrm{GeV}\\ensuremath{\\lesssim}{m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}\\ensuremath{\\lesssim}45 \\mathrm{GeV}$, ${({m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}})}_{min}\\ensuremath{\\simeq}{m}_{\\ensuremath{\\tau}}=1.8$ GeV; for ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}&gt;45$ GeV, ${({m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}})}_{min}$ increases approximately linearly with ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}$ to a value of 20 GeV when ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}=100$ GeV.';

test('normalizes legacy OpenAlex math macros into KaTeX-compatible LaTeX', () => {
  const abstract = 'A lower bound for the photino mass ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}}}$ as a function of ${m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}$ and $25 \\mathrm{GeV}\\ensuremath{\\lesssim}{m}_{\\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{f}}&gt;45 \\mathrm{GeV}$.';
  const normalized = normalizeLatexText(abstract);

  assert.match(normalized, /\$\{m\}_\{\\tilde\{\\gamma\}\}\$/);
  assert.match(normalized, /\$\{m\}_\{\\tilde\{f\}\}\$/);
  assert.match(normalized, /\\mathrm\{GeV\}\\lesssim/);
  assert.match(normalized, />45/);
  assert.doesNotMatch(normalized, /\\(?:ifmmode|ensuremath|stackrel)/);

  const formulas = [...normalized.matchAll(/\$([^$]+)\$/g)].map(match => match[1]);
  assert.ok(formulas.length >= 3);
  for (const formula of formulas) {
    assert.doesNotThrow(() => katex.renderToString(formula, { throwOnError: true }));
  }
});

test('preserves ordinary text while escaping LaTeX comment characters', () => {
  assert.equal(normalizeLatexText('Accuracy improved by 5%\nNext line.'), 'Accuracy improved by 5\\% Next line.');
});

test('displayProse undoes the comment escape so screens show the percent sign', () => {
  assert.equal(displayProse('el 100\\% de los casos'), 'el 100% de los casos');
  assert.equal(displayProse('sin porcentajes'), 'sin porcentajes');
});

test('proseSourceOffset maps a display offset back into the escaped run', () => {
  const run = 'up to 12.2\\% and 24.2\\%, respectively';
  // display: 'up to 12.2% and 24.2%, respectively'
  assert.equal(proseSourceOffset(run, 0), 0);
  assert.equal(proseSourceOffset(run, 10), 10);
  assert.equal(proseSourceOffset(run, 12), 13);
  assert.equal(proseSourceOffset(run, 22), 24);
  assert.equal(proseSourceOffset(run, 999), run.length);
});

test('ScientificText paints prose percent signs without the LaTeX escape', () => {
  const rendered = renderToStaticMarkup(
    React.createElement(ScientificText, null, 'Accuracy reached 100% of cases.'),
  );
  assert.match(rendered, /100% of cases\./);
  assert.doesNotMatch(rendered, /\\%/);
});

test('removes embedded HTML and MathML tags while preserving scientific content', () => {
  const raw = '<i>Planck</i> output is <mml:math><mml:mrow><mml:mn>300</mml:mn><mml:mo>−</mml:mo><mml:mn>500</mml:mn><mml:mtext>MWe</mml:mtext></mml:mrow></mml:math> and x < 5.';
  const normalized = normalizeScientificMarkup(raw);

  assert.equal(normalized, 'Planck output is 300−500MWe and x < 5.');
  assert.doesNotMatch(normalized, /<\/?(?:i|mml:)/);
});

test('renders every formula in the complete OpenAlex photino abstract', async () => {
  // KaTeX loads on demand in the browser; rendering synchronously here needs
  // the module preloaded, which is exactly what the idle prefetch gives users.
  await loadKatex();
  const normalized = normalizeLatexText(PHOTINO_ABSTRACT);
  const formulas = [...normalized.matchAll(/\$([^$]+)\$/g)].map(match => match[1]);

  assert.equal(formulas.length, 10);
  assert.match(normalized, /\\rightarrow f/);
  assert.doesNotMatch(normalized, /\\rightarrowf/);
  for (const formula of formulas) {
    assert.doesNotThrow(() => katex.renderToString(formula, { throwOnError: true }));
  }

  const rendered = renderToStaticMarkup(
    React.createElement(ScientificText, null, PHOTINO_ABSTRACT),
  );
  assert.equal((rendered.match(/class="katex"/g) || []).length, formulas.length);
});

test('keeps malformed or incomplete math visible instead of dropping its delimiters', async () => {
  assert.deepEqual(splitLatexText('Result: $x + 1'), [
    { type: 'text', value: 'Result: ' },
    { type: 'text', value: '$x + 1' },
  ]);

  // Preloaded so the assertion exercises KaTeX's real error path, not the
  // not-yet-loaded fallback (which shows the same raw text).
  await loadKatex();
  const rendered = renderToStaticMarkup(
    React.createElement(ScientificText, null, 'Result: $\\notARealCommand$'),
  );
  assert.match(rendered, /\$\\notARealCommand\$/);
});

/* --- Macros that OpenAlex leaves OUTSIDE the maths delimiters ------------- */

// Verbatim from OpenAlex (W2029887339, Phys. Rev. B 42, 892). APS abstracts
// arrive with `\ensuremath{…}` and `\ifmmode…\else…\fi{}` in TEXT mode: the
// macro is the whole formula, there is no `$` around it.
const QUASIPARTICLE_ABSTRACT = 'The coherent mass ${\\mathit{m}}^{\\mathrm{*}}$ of the quasiparticle and the frequency-dependent conductivity \\ensuremath{\\sigma}(\\ensuremath{\\omega}) are calculated for clusters with 4\\ifmmode\\times\\else\\texttimes\\fi{}4 and 8\\ifmmode\\times\\else\\texttimes\\fi{}4 sites. In particular, \\ensuremath{\\sigma}(\\ensuremath{\\omega}) shows an isolated quasiparticle peak at small \\ensuremath{\\omega}.';

test('a text-mode \\ensuremath becomes its own inline formula', () => {
  assert.equal(
    normalizeLatexText('conductivity \\ensuremath{\\sigma}(\\ensuremath{\\omega}) are'),
    'conductivity \\(\\sigma\\)(\\(\\omega\\)) are',
  );
});

test('a text-mode \\ifmmode picks the maths branch as an inline formula', () => {
  assert.equal(
    normalizeLatexText('clusters with 4\\ifmmode\\times\\else\\texttimes\\fi{}4 sites'),
    'clusters with 4\\(\\times\\)4 sites',
  );
});

test('an \\ifmmode inside a formula keeps the maths branch bare', () => {
  assert.equal(
    normalizeLatexText('$L=4\\ifmmode\\times\\else\\texttimes\\fi{}4$'),
    '$L=4\\times4$',
  );
});

test('an \\ensuremath inside a formula is still unwrapped, not nested', () => {
  assert.equal(normalizeLatexText('$25 \\mathrm{GeV}\\ensuremath{\\lesssim}m$'), '$25 \\mathrm{GeV}\\lesssim m$');
});

test('text-only symbol macros paint as their character', () => {
  assert.equal(normalizeLatexText('a 3.2 \\AA{} bond, \\textcopyright 2020'), 'a 3.2 Å bond, © 2020');
});

test('renders the quasiparticle abstract with no raw macro left on screen', async () => {
  await loadKatex();
  const normalized = normalizeLatexText(QUASIPARTICLE_ABSTRACT);
  assert.doesNotMatch(normalized, /\\(?:ifmmode|ensuremath|texttimes|else|fi)\b/);
  const formulas = splitLatexText(QUASIPARTICLE_ABSTRACT).filter(chunk => chunk.type === 'math');
  assert.equal(formulas.length, 8);
  for (const formula of formulas) {
    assert.doesNotThrow(() => katex.renderToString(formula.value, { throwOnError: true }));
  }

  const rendered = renderToStaticMarkup(
    React.createElement(ScientificText, null, QUASIPARTICLE_ABSTRACT),
  );
  // KaTeX keeps the TeX source in a MathML annotation, so the raw-macro check
  // is on the prose only: every formula must have become a KaTeX span.
  assert.doesNotMatch(rendered, /\\(?:ifmmode|ensuremath|texttimes)/);
  assert.equal((rendered.match(/class="katex"/g) || []).length, 8);
});

test('a text-mode \\stackrel tilde becomes one formula, not a stackrel around two', () => {
  assert.equal(
    normalizeLatexText('the photino \\stackrel{\\ifmmode \\tilde{}\\else \\~{}\\fi{}}{\\ensuremath{\\gamma}} decays'),
    'the photino \\(\\tilde{\\gamma}\\) decays',
  );
});

test('an \\ifmmode without an \\else branch still yields its maths spelling', () => {
  assert.equal(normalizeLatexText('4\\ifmmode\\times\\fi{}4 sites'), '4\\(\\times\\)4 sites');
  assert.equal(normalizeLatexText('$L=4\\ifmmode\\times\\fi{}4$'), '$L=4\\times4$');
});

/* --- Environments the delimiter list knows and KaTeX does not ------------- */

// `\begin{eqnarray}` and `\begin{math}` joined LATEX_DELIMITERS in f43ac59,
// "Fix legacy LaTeX rendering in paper abstracts": they are what older papers
// carry, so the splitter has to recognize them. KaTeX implements NEITHER — it
// answers "No such environment" for both — and every render path (this file's
// ScientificText, the reader's HighlightedScientificText, pdfExport's
// renderMath) catches that throw and prints the chunk's raw source as prose.
// So a recognized formula was painted as literal LaTeX, on screen and in the
// exported PDF, with no error anywhere. `katexSource` is the single place that
// translates such a chunk into an environment the renderer does implement.

function renders(source, display) {
  try {
    katex.renderToString(source, {
      displayMode: display, throwOnError: true, strict: 'ignore', trust: false,
    });
    return true;
  } catch {
    return false;
  }
}

const mathChunk = text => splitLatexText(text).find(chunk => chunk.type === 'math');

test('KaTeX renders every delimiter the splitter recognizes, one row per row', () => {
  // One line per LATEX_DELIMITERS entry, bodies as each is idiomatically
  // written. Before `katexSource` the last two threw and were painted as
  // source; if a delimiter is ever added without a renderer that knows it,
  // this table fails instead of the page quietly printing LaTeX at a reader.
  const cases = [
    ['$…$ inline', 'vale $E = mc^2$ hoy'],
    ['$$…$$ de bloque', 'vale $$E = mc^2$$ hoy'],
    ['\\(…\\) inline', 'vale \\(E = mc^2\\) hoy'],
    ['\\[…\\] de bloque', 'vale \\[E = mc^2\\] hoy'],
    ['\\begin{equation}', 'vale \\begin{equation}E = mc^2\\end{equation} hoy'],
    ['\\begin{align}', 'vale \\begin{align}E &= mc^2 \\\\ p &= mv\\end{align} hoy'],
    ['\\begin{eqnarray}', 'vale \\begin{eqnarray}E & = & mc^2 \\\\ p & = & mv\\end{eqnarray} hoy'],
    ['\\begin{math}', 'vale \\begin{math}E = mc^2\\end{math} hoy'],
  ];
  for (const [label, text] of cases) {
    const chunk = mathChunk(text);
    assert.ok(renders(katexSource(chunk), chunk.display), label);
  }
});

test('an eqnarray is numbered by the row, the way the .tex numbers it', () => {
  // pdfExport's `numberedEquation` counts KaTeX's own `.eqn-num` elements to
  // keep the badge in step with the .tex. Unrendered, an eqnarray produced
  // none and every formula after it drifted one number short per extra row.
  const chunk = mathChunk('\\begin{eqnarray}E & = & mc^2 \\\\ p & = & mv \\\\ F & = & ma\\end{eqnarray}');
  const html = katex.renderToString(katexSource(chunk), {
    displayMode: chunk.display, throwOnError: true, strict: 'ignore', trust: false,
  });
  assert.equal((html.match(/class="eqn-num"/g) || []).length, 3);

  // `\nonumber` still takes a row out of the count, exactly as LaTeX does.
  const skipped = mathChunk('\\begin{eqnarray}E & = & mc^2 \\nonumber \\\\ p & = & mv\\end{eqnarray}');
  const skippedHtml = katex.renderToString(katexSource(skipped), {
    displayMode: skipped.display, throwOnError: true, strict: 'ignore', trust: false,
  });
  assert.equal((skippedHtml.match(/class="eqn-num"/g) || []).length, 1);
});

test('eqnarray keeps one alignment point per row, not its three columns', () => {
  // eqnarray is {rcl}: left, the relation centred, right. `align` is pairs of
  // {rl}, and KaTeX puts a \quad before every column it starts after the
  // first pair — so relabelling and keeping all three tabs sets the relation
  // against the left side and throws the right side a quad away (measured
  // against pdflatex's own eqnarray, which centres it). Dropping the second
  // tab puts relation and right side in one column, which is what the row
  // reads as.
  const source = katexSource(mathChunk('\\begin{eqnarray}E & = & mc^2 \\\\ p & = & mv\\end{eqnarray}'));
  assert.match(source, /^\\begin\{align\}/);
  assert.match(source, /\\end\{align\}$/);
  assert.equal((source.match(/&/g) || []).length, 2);
});

test('a tab that is not the row\'s own is left where it is', () => {
  // Only a tab at the top level of the eqnarray is a column of the eqnarray.
  // A nested environment brings its own, and `\&` is a printed ampersand.
  const nested = katexSource(mathChunk(
    '\\begin{eqnarray}M & = & \\begin{array}{cc} a & b \\\\ c & d \\end{array}\\end{eqnarray}',
  ));
  assert.match(nested, /\{cc\} a & b \\\\ c & d /);
  assert.ok(renders(nested, true), 'the nested array still renders');

  const escaped = katexSource(mathChunk('\\begin{eqnarray}A \\& B & = & C\\end{eqnarray}'));
  assert.match(escaped, /A \\& B &/);
});

test('translating for the renderer leaves the chunk the .tex reads untouched', () => {
  // `emitMath` (latexExport.js) asks `item.value !== item.raw` to decide
  // whether a chunk still needs wrapping in `\begin{equation}`, and
  // `buildHighlightPlan` measures its offsets in `value.length`. A translation
  // written into `value` would have wrapped the align in an equation and slid
  // every highlight after it, so this one stays outside the chunk.
  const chunk = mathChunk('\\begin{eqnarray}E & = & mc^2\\end{eqnarray}');
  const before = { ...chunk };
  katexSource(chunk);
  assert.deepEqual(chunk, before);
  assert.equal(chunk.value, chunk.raw);
  assert.match(chunk.raw, /^\\begin\{eqnarray\}/);
});

// Springer Nature deposits each abstract formula as a COMPLETE compilable
// `.tex` — preamble and all — inside the `<tex-math>` of a JATS
// `<alternatives>`, next to a MathML spelling of the same formula. Verified
// against PMC12824388 (`fullTextXML`) for 10.1038/s41467-025-67503-z, which is
// the paper whose card printed the preamble as prose.
const JATS_ALTERNATIVES = '<!--Abstract rendered from JATS-->The mechanism controlling the transition temperature '
  + '<inline-formula id="IEq1"><alternatives>'
  + '<tex-math id="d33e242"><?equation-image-name d33e242.gif?><?equation-image-status READY?>'
  + '<![CDATA[\\documentclass[12pt]{minimal} \\usepackage{amsmath} \\usepackage{upgreek} '
  + '\\setlength{\\oddsidemargin}{-69pt} \\begin{document}$${T}_{{{{\\rm{c}}}}}^{0}$$\\end{document}]]>'
  + '</tex-math>'
  + '<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML"><mml:msubsup><mml:mrow><mml:mi>T</mml:mi></mml:mrow> '
  + '<mml:mrow><mml:mi>c</mml:mi></mml:mrow> <mml:mrow><mml:mn>0</mml:mn></mml:mrow></mml:msubsup></mml:math>'
  + '</alternatives></inline-formula> as a function of doping.';

// The same abstract as Semantic Scholar relays it: the tags are already gone,
// so there is no `<alternatives>` left to choose from — the MathML spelling
// arrives flattened and GLUED to the preamble that follows it.
const RELAYED_FULL = 'The mechanism controlling the transition temperature Tc0\\documentclass[12pt]{minimal} '
  + '\\usepackage{amsmath} \\usepackage{wasysym} \\setlength{\\oddsidemargin}{-69pt} '
  + '\\begin{document}$${T}_{{{{\\rm{c}}}}}^{0}$$\\end{document} as a function of doping.';

// Same relay, but the glued run is only PART duplicate: `mg` is real prose and
// `NH3` is the flattened formula. Real abstract, 10.1038/s41467-024-45534-2.
const RELAYED_TAIL = 'The catalyst exhibits a yield rate for NH3 of 114.0 mgNH3\\documentclass[12pt]{minimal} '
  + '\\usepackage{amsmath} \\setlength{\\oddsidemargin}{-69pt} '
  + '\\begin{document}$${}_{{{{{{\\rm{NH}}}}}}_3}$$\\end{document} h−1 cm−2, which exceeds previous values.';

test('unwraps the standalone LaTeX document JATS wraps around every formula', () => {
  const normalized = normalizeScientificMarkup(JATS_ALTERNATIVES);

  assert.equal(
    normalized,
    'The mechanism controlling the transition temperature \\({T}_{{{{\\rm{c}}}}}^{0}\\) as a function of doping.',
  );
});

test('drops the markup the tag stripper cannot see', () => {
  // `SCIENTIFIC_MARKUP_TAG` requires a letter after the `<`, so everything
  // opening with `<!` or `<?` used to survive it: the CDATA markers were left
  // orphaned mid-sentence once their `<tex-math>` wrapper was stripped.
  const normalized = normalizeScientificMarkup(JATS_ALTERNATIVES);

  assert.doesNotMatch(normalized, /<!\[CDATA\[|\]\]>/);
  assert.doesNotMatch(normalized, /<\?|\?>|equation-image/);
  assert.doesNotMatch(normalized, /\\(?:documentclass|usepackage|setlength)/);
  assert.doesNotMatch(normalized, /\\(?:begin|end)\{document\}/);
});

test('keeps one spelling of a formula that arrives twice', () => {
  // `<alternatives>` carries the same formula as LaTeX and as MathML. Keeping
  // both printed it twice — once flattened to `T c 0`, once rendered.
  const normalized = normalizeScientificMarkup(JATS_ALTERNATIVES);

  assert.equal(normalized.match(/\\\(/g).length, 1, 'exactly one formula survives');
  assert.doesNotMatch(normalized, /T\s+c\s+0/, 'the flattened MathML twin is gone');
});

test('drops the flattened twin a relay glues to the preamble', () => {
  assert.equal(
    normalizeScientificMarkup(RELAYED_FULL),
    'The mechanism controlling the transition temperature \\({T}_{{{{\\rm{c}}}}}^{0}\\) as a function of doping.',
  );
});

test('strips only the twin from a glued run, never the prose in front of it', () => {
  // `mgNH3` is `mg` (prose) + `NH3` (the flattened formula). Dropping the whole
  // run would eat the unit and leave a yield rate of 114.0 of nothing.
  const normalized = normalizeScientificMarkup(RELAYED_TAIL);

  assert.equal(
    normalized,
    'The catalyst exhibits a yield rate for NH3 of 114.0 mg\\({}_{{{{{{\\rm{NH}}}}}}_3}\\) h−1 cm−2, '
    + 'which exceeds previous values.',
  );
  assert.match(normalized, /114\.0 mg\\\(/);
  assert.match(normalized, /rate for NH3 of/, 'the NH3 that is prose stays');
});

test('the unwrapped formula reaches the renderer as one math chunk', async () => {
  await loadKatex();

  for (const raw of [JATS_ALTERNATIVES, RELAYED_FULL, RELAYED_TAIL]) {
    const chunks = splitLatexText(raw);
    const math = chunks.filter(chunk => chunk.type === 'math');
    assert.equal(math.length, 1, 'one formula, not one per alternative');
    assert.doesNotThrow(() => katex.renderToString(math[0].value, { throwOnError: true }));

    for (const chunk of chunks.filter(chunk => chunk.type === 'text')) {
      // `isSafeMath` (latexExport.js) rejects `\documentclass`, so a preamble
      // that got this far fell back to plain text and PRINTED in the .tex.
      assert.doesNotMatch(chunk.value, /\\(?:documentclass|usepackage)/);
    }
  }
});
