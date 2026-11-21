import '../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import ScientificText from './scientific-text.ts';
import { getKatex, loadKatex } from '../utils/katex-loader.ts';
import { renderErrors, translatePage } from '../../tests/dom/browser-translation.ts';

// A reader who translates the page with the browser before KaTeX has arrived:
// the formulas still show their LaTeX source, and the translator has replaced
// the text nodes around them. When KaTeX lands the formulas are drawn, and that
// must not take the card down (facebook/react#11538).
test('a translated card draws its formulas when KaTeX arrives, keeping the translated words and leaving the formulas untranslated', async () => {
  assert.equal(getKatex(), null, 'KaTeX has not loaded yet in this test file');
  const { container } = render(createElement(ScientificText, null, 'The bound $\\alpha \\le \\beta$ holds for every $n > 0$ in the limit.'));
  assert.ok(translatePage(container) > 0, 'the translator replaced some text');

  assert.deepEqual(await renderErrors(() => loadKatex()), [], 'nothing is thrown while the formulas are drawn');

  assert.equal(container.querySelectorAll('.katex').length, 2, 'both formulas are drawn');
  for (const formula of container.querySelectorAll('.katex')) {
    assert.ok(formula.closest('[translate="no"]'), 'a formula is marked for the translator to leave alone');
  }
  const words = container.textContent ?? '';
  assert.match(words, /\[es\] The bound /, 'the prose before the formulas stays translated');
  assert.match(words, /\[es\] {2}in the limit\./, 'the prose after them stays translated');
});
