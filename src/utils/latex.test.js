import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ScientificText from '../components/ScientificText.js';
import { loadKatex } from './katexLoader.js';
import { displayProse, normalizeLatexText, normalizeScientificMarkup, proseSourceOffset, splitLatexText } from './latex.js';

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
