import test from 'node:test';
import assert from 'node:assert/strict';
import { plainScientificText } from './plainScientificText.js';

// Where these strings go: a share preview's title, a `<title>`, the text a
// share sheet sends. None of them renders KaTeX, so a title that reached them
// raw read «pro-$\mathcal{C}$ groups» (OpenAlex W7208794446, 2026-09-24).

test('a font command keeps its letter and loses the markup', () => {
  assert.equal(plainScientificText('On commensurations of pro-$\\mathcal{C}$ groups'), 'On commensurations of pro-C groups');
  assert.equal(plainScientificText('Maps on \\(\\mathbb{R}^n\\)'), 'Maps on Rⁿ');
  assert.equal(plainScientificText('An $\\mathrm{O}(n \\log n)$ algorithm'), 'An O(n log n) algorithm');
});

test('Greek letters and common symbols become their characters', () => {
  assert.equal(plainScientificText('The $\\alpha$-decay of $\\Lambda$ hyperons'), 'The α-decay of Λ hyperons');
  assert.equal(plainScientificText('A $\\sqrt{2}$ bound at $T \\leq 3$ K'), 'A √2 bound at T ≤ 3 K');
  assert.equal(plainScientificText('Graphene at \\ensuremath{\\sim}3 K'), 'Graphene at ~3 K');
});

test('digit scripts become Unicode scripts, other scripts stay readable', () => {
  assert.equal(plainScientificText('$^{212}$Po and H$_2$O'), '²¹²Po and H₂O');
  assert.equal(plainScientificText('The $x^{ab}$ term'), 'The x^ab term');
});

test('prose escapes and inline HTML come out as text', () => {
  assert.equal(plainScientificText('Accuracy at 5\\% error'), 'Accuracy at 5% error');
  assert.equal(plainScientificText('Cells &lt;i&gt;in vitro&lt;/i&gt; and <sub>2</sub>'), 'Cells in vitro and 2');
  assert.equal(plainScientificText('Salt \\& pepper noise'), 'Salt & pepper noise');
});

test('whitespace collapses and nothing becomes the string "undefined"', () => {
  assert.equal(plainScientificText('  Two\n  lines\tof title  '), 'Two lines of title');
  assert.equal(plainScientificText(''), '');
  assert.equal(plainScientificText(null), '');
  assert.equal(plainScientificText(undefined), '');
});

test('text without markup is returned as it came', () => {
  const title = 'Attention Is All You Need';
  assert.equal(plainScientificText(title), title);
});
