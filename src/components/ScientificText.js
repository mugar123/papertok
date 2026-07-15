import { createElement, Fragment } from 'react';
import katex from 'katex';
import { splitLatexText } from '../utils/latex.js';

export default function ScientificText({ children }) {
  const text = Array.isArray(children) ? children.join('') : children;
  const chunks = splitLatexText(text);
  const renderedChunks = chunks.map((chunk, index) => {
    if (chunk.type === 'text') {
      return createElement(Fragment, { key: `text-${index}` }, chunk.value);
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
