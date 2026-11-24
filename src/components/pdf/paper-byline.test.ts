import '../../../tests/dom/dom-environment.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { loadPaperByline } from '../../../tests/dom/component-modules.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';

test('name-only reader authors link to profiles with the source paper for disambiguation', async () => {
  const { PaperByline, close } = await loadPaperByline();
  try {
    const paper = paperLegacyAdapter({
      id: '2611.27611',
      title: 'Cosmological Correlators with Triple Massive Exchanges',
      authors: ['Shuntaro Aoki', 'Lucas Pinol', 'Zhehan Qin', 'Fumiya Sano', 'Masahide Yamaguchi', 'Yuhang Zhu'],
    });
    const view = render(createElement(PaperByline, { paper }));
    assert.equal(view.getAllByRole('link').length, 6);
    const lucas = view.getByRole('link', { name: /Lucas Pinol/ });
    assert.equal(lucas.getAttribute('href'), '/explorer/author/Lucas%20Pinol?arxivId=2611.27611');
    assert.equal(lucas.getAttribute('target'), '_blank');
    lucas.focus();
    assert.equal(document.activeElement, lucas);
  } finally {
    cleanup();
    await close();
  }
});

test('an ORCID author keeps their identity and the DOI of the paper in their profile link', async () => {
  const { PaperByline, close } = await loadPaperByline();
  try {
    const paper = paperLegacyAdapter({
      id: 'doi:10.1234/example', doi: '10.1234/example', title: 'A paper',
      authors: [{ name: 'Lucas Pinol', orcid: 'https://orcid.org/0000-0002-2218-5929' }],
    });
    const view = render(createElement(PaperByline, { paper }));
    assert.equal(view.getByRole('link', { name: /Lucas Pinol/ }).getAttribute('href'),
      '/explorer/author/0000-0002-2218-5929?name=Lucas%20Pinol&paper=doi%3A10.1234%2Fexample');
  } finally {
    cleanup();
    await close();
  }
});
