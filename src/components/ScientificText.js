import { createElement, Fragment, useEffect, useMemo, useReducer } from 'react';
import { splitLatexText } from '../utils/latex.js';
import { getKatex, loadKatex } from '../utils/katexLoader.js';

// Math renders through the on-demand KaTeX chunk (see utils/katexLoader.js).
// Until it lands, the raw LaTeX source shows — readable, and replaced as soon
// as the chunk arrives, which the idle prefetch usually makes immediate.
export default function ScientificText({ children }) {
  const text = Array.isArray(children) ? children.join('') : children;
  // The title and the abstract both route through here, and the abstract can
  // run to a couple thousand characters -- re-walking it on every render (a
  // keystroke elsewhere on the card, a sibling re-rendering) bought nothing,
  // since `text` itself does not change between those renders. Both call
  // sites (`paper.title`, and `abstractText` which is `paper.abstract`
  // passed straight through) hand this a field read, not a value rebuilt
  // inline each render, so the memo actually has a stable key to test.
  const parts = useMemo(() => splitLatexText(text), [text]);
  const hasMath = parts.some(chunk => chunk.type !== 'text');
  const [, rerender] = useReducer(count => count + 1, 0);

  useEffect(() => {
    if (!hasMath || getKatex()) return undefined;
    let active = true;
    loadKatex().then(loaded => {
      if (active && loaded) rerender();
    });
    return () => { active = false; };
  }, [hasMath]);

  const katex = getKatex();
  const renderedChunks = parts.map((chunk, index) => {
    if (chunk.type === 'text') {
      return createElement(Fragment, { key: `text-${index}` }, chunk.value);
    }

    if (!katex) {
      return createElement(Fragment, { key: `pending-${index}` }, chunk.raw);
    }

    try {
      const html = katex.renderToString(chunk.value, {
        displayMode: chunk.display,
        throwOnError: true,
        strict: 'ignore',
        trust: false,
      });

      return createElement('span', {
        key: `${chunk.raw}-${index}`,
        dangerouslySetInnerHTML: { __html: html },
      });
    } catch {
      return createElement(Fragment, { key: `fallback-${index}` }, chunk.raw);
    }
  });

  return createElement('span', { className: 'scientific-text' }, renderedChunks);
}
