import { createElement, Fragment, useEffect, useReducer } from 'react';
import { splitLatexText } from '../utils/latex.js';
import { getKatex, loadKatex } from '../utils/katexLoader.js';

// Math renders through the on-demand KaTeX chunk (see utils/katexLoader.js).
// Until it lands, the raw LaTeX source shows — readable, and replaced as soon
// as the chunk arrives, which the idle prefetch usually makes immediate.
export default function ScientificText({ children }) {
  const text = Array.isArray(children) ? children.join('') : children;
  const chunks = splitLatexText(text);
  const hasMath = chunks.some(chunk => chunk.type !== 'text');
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
  const renderedChunks = chunks.map((chunk, index) => {
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
