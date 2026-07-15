import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Latex from 'react-latex-next';
import { LATEX_DELIMITERS, normalizeLatexText } from './latex.js';

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

test('renders every formula in the complete OpenAlex photino abstract', () => {
  const normalized = normalizeLatexText(PHOTINO_ABSTRACT);
  const formulas = [...normalized.matchAll(/\$([^$]+)\$/g)].map(match => match[1]);

  assert.equal(formulas.length, 10);
  assert.match(normalized, /\\rightarrow f/);
  assert.doesNotMatch(normalized, /\\rightarrowf/);
  for (const formula of formulas) {
    assert.doesNotThrow(() => katex.renderToString(formula, { throwOnError: true }));
  }

  const rendered = renderToStaticMarkup(
    React.createElement(Latex, { strict: false, delimiters: LATEX_DELIMITERS }, normalized),
  );
  assert.equal((rendered.match(/class="katex"/g) || []).length, formulas.length);
});
