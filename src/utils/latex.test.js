import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { normalizeLatexText } from './latex.js';

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
