import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import katex from 'katex';
import ScientificText from './ScientificText.ts';
import { loadKatex } from '../utils/katexLoader.ts';

/**
 * A card re-renders many times while it arrives on screen and again whenever
 * the queue behind it is re-ranked. None of those renders change its words,
 * so none of them should run KaTeX again (measured 2026-09-22: every formula
 * on every re-rendered card, in the middle of the snap).
 */
test('a formula is rendered by KaTeX once per session, however many times its text is rendered', async () => {
  await loadKatex();
  const original = katex.renderToString;
  const calls = [];
  katex.renderToString = (source, options) => { calls.push(source); return original.call(katex, source, options); };
  try {
    // Formulas no other test renders, so the module cache starts cold for them.
    const text = 'The bound $\\alpha_{4242} \\le \\beta_{4242}$ holds when $\\gamma_{4242} > 0$.';
    const first = renderToStaticMarkup(React.createElement(ScientificText, null, text));
    assert.equal((first.match(/class="katex"/g) || []).length, 2);
    assert.equal(calls.length, 2, 'the first render pays for each formula once');
    const second = renderToStaticMarkup(React.createElement(ScientificText, null, text));
    assert.equal(second, first, 'the same words paint the same markup');
    assert.equal(calls.length, 2, 'a second render of the same text does not render the formulas again');
  } finally {
    katex.renderToString = original;
  }
});

test('a formula KaTeX rejects stays visible as its source, and is not retried on every render', async () => {
  await loadKatex();
  const original = katex.renderToString;
  let calls = 0;
  katex.renderToString = (source, options) => { calls += 1; return original.call(katex, source, options); };
  try {
    const text = 'Broken: $\\notARealCommand_{4242}$ here.';
    const first = renderToStaticMarkup(React.createElement(ScientificText, null, text));
    assert.match(first, /\$\\notARealCommand_\{4242\}\$/, 'the raw source stays on the page');
    assert.equal(calls, 1);
    renderToStaticMarkup(React.createElement(ScientificText, null, text));
    assert.equal(calls, 1, 'the failure is remembered too');
  } finally {
    katex.renderToString = original;
  }
});

test('ScientificText is memoised', () => {
  assert.equal(ScientificText.$$typeof, Symbol.for('react.memo'), 'a card re-rendering for its own reasons must not re-walk the text');
});
