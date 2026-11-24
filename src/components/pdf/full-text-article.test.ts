import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { loadFullTextArticle } from '../../../tests/dom/component-modules.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import type { FullText } from '../../utils/full-text.ts';

test('offscreen display equations keep their source and convert only when visible, releasing observation on unmount', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver');
  const visible = new Map<Element, () => void>();
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    notify: (entries: { target: Element; isIntersecting: boolean }[]) => void;
    constructor(notify: (entries: { target: Element; isIntersecting: boolean }[]) => void) { this.notify = notify; }
    observe(target: Element) { visible.set(target, () => this.notify([{ target, isIntersecting: true }])); }
    unobserve(target: Element) { visible.delete(target); }
    disconnect() { visible.clear(); }
  } });
  const { Article, LanguageContext, loadKatex, close } = await loadFullTextArticle();
  try {
    const doc: FullText = {
      source: 'arxiv', sourceUrl: 'https://arxiv.org/html/2610.21620', abstract: [], notes: [], references: [], conversionErrors: 0,
      body: [
        { t: 'equation', id: 'native', tex: 'x^2', mathml: '<math><msup><mi>x</mi><mn>2</mn></msup></math>' },
        { t: 'equation', id: 'source', tex: 'y^2' },
        { t: 'equation', id: 'image', tex: 'z^2', image: 'https://arxiv.org/formula.png' },
        { t: 'equation', id: 'unread', tex: 'w^2', mathml: '<math><msup><mi>w</mi><mn>2</mn></msup></math>' },
        { t: 'p', children: [{ t: 'math', tex: 'a^2', mathml: '<math><msup><mi>a</mi><mn>2</mn></msup></math>' }] },
      ],
    };
    await loadKatex();
    const paper = paperLegacyAdapter({ id: '2610.21620', title: 'Formula test', abstract: '' });
    const view = render(createElement(LanguageContext.Provider, { value: { language: 'en', locale: 'en-US' } }, createElement(Article, { doc, paper })));
    assert.equal(view.container.querySelector('#ft-native .katex'), null);
    assert.ok(view.container.querySelector('#ft-source .katex'), 'TeX-only equations are typeset eagerly when there is no visual source');
    assert.ok(view.container.querySelector('[data-passage] .katex'), 'annotatable prose uses stable typeset text even offscreen');
    assert.equal(view.container.querySelector('#ft-native math')?.textContent, 'x2');
    assert.equal(view.container.querySelector('#ft-image img')?.getAttribute('alt'), 'z^2');
    for (const id of ['native', 'image']) {
      const root = view.container.querySelector(`#ft-${id}`);
      assert.ok(root);
      const entry = [...visible].find(([element]) => root.contains(element));
      assert.ok(entry, `${id} can enter the viewport`);
      act(() => entry[1]());
      assert.ok(root.querySelector('.katex'), `${id} is typeset on entry`);
    }
    assert.equal(visible.size, 1, 'the unread formula still waits for visibility');
    view.unmount();
    assert.equal(visible.size, 0);
  } finally {
    cleanup();
    if (original) Object.defineProperty(globalThis, 'IntersectionObserver', original);
    await close();
  }
});
