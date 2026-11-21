import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { startAppModules } from '../../../tests/dom/app-modules.ts';
import { renderErrors, translatePage } from '../../../tests/dom/browser-translation.ts';

// A reader who translates the page with the browser: the paper's words are
// translated, its formulas are not, before KaTeX arrives (the LaTeX source)
// and after (the drawn formula).
test('in the reader a browser translation rewrites the prose and leaves every formula as it is', async () => {
  const app = await startAppModules();
  try {
    const { default: HighlightedScientificText } = await app.load<{ default: (props: { children: string }) => ReactNode }>('/src/components/reader/highlighted-scientific-text.tsx');
    const { getKatex, loadKatex } = await app.load<{ getKatex: () => unknown; loadKatex: () => Promise<unknown> }>('/src/utils/katex-loader.ts');
    assert.equal(getKatex(), null, 'KaTeX has not loaded yet in this test file');
    const { container } = render(createElement('p', null, createElement(HighlightedScientificText, null, 'The bound $\\alpha \\le \\beta$ holds in the limit.')));
    translatePage(container);
    assert.equal(container.querySelector('[data-math]')?.textContent, '$\\alpha \\le \\beta$', 'the LaTeX source is not translated');

    assert.deepEqual(await renderErrors(() => loadKatex()), [], 'nothing is thrown while the formula is drawn');

    const formula = container.querySelector('.katex');
    assert.ok(formula, 'the formula is drawn');
    assert.ok(formula.closest('[translate="no"]'), 'the drawn formula is marked for the translator to leave alone');
    assert.match(container.textContent ?? '', /\[es\] The bound /, 'the prose stays translated');
  } finally {
    cleanup();
    await app.close();
  }
});
