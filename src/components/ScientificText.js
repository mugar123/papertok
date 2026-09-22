import { createElement, Fragment, memo, useEffect, useMemo, useReducer } from 'react';
import { displayProse, katexSource, splitLatexText } from '../utils/latex.js';
import { getKatex, loadKatex } from '../utils/katexLoader.js';

// Rendered formulas, by source. A card re-renders many times while it is
// arriving on screen (visibility, figures, settle, idle, comment count, the
// active flag) and again whenever the queue behind it is re-ranked, and each
// of those renders used to run `katex.renderToString` for every formula on
// the card. Measured 2026-09-22 on the production bundle: a physics abstract
// paid it 5-7 times per snap, on the main thread, in the middle of the scroll
// animation. The markup for a given source never changes, so it is rendered
// once per session and read back after that. Bounded so a long session on a
// math-heavy feed cannot grow it without limit; clearing it only costs the
// next render what it used to cost every render.
const MAX_CACHED_FORMULAS = 2000;
const renderedFormulas = new Map();

function renderFormula(katex, chunk) {
  const key = `${chunk.display ? 'D' : 'I'}\u0000${katexSource(chunk)}`;
  if (renderedFormulas.has(key)) return renderedFormulas.get(key);
  let html;
  try {
    html = katex.renderToString(katexSource(chunk), {
      displayMode: chunk.display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
    });
  } catch {
    html = null;
  }
  if (renderedFormulas.size >= MAX_CACHED_FORMULAS) renderedFormulas.clear();
  renderedFormulas.set(key, html);
  return html;
}

// Math renders through the on-demand KaTeX chunk (see utils/katexLoader.js).
// Until it lands, the raw LaTeX source shows — readable, and replaced as soon
// as the chunk arrives, which the idle prefetch usually makes immediate.
function ScientificText({ children }) {
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
  // Memoised as elements, not just as strings. React 19 compares
  // `dangerouslySetInnerHTML` by the identity of the `{ __html }` object and
  // re-assigns `innerHTML` whenever it sees a new one, even for the same
  // markup — so a fresh object per render meant the browser re-parsed and
  // rebuilt every formula's DOM on every render of the card, and the feed
  // re-laid out a card whose words had not changed. Keeping the same element
  // tree across renders is what makes those renders a no-op for the DOM.
  const renderedChunks = useMemo(() => parts.map((chunk, index) => {
    if (chunk.type === 'text') {
      return createElement(Fragment, { key: `text-${index}` }, displayProse(chunk.value));
    }

    if (!katex) {
      return createElement(Fragment, { key: `pending-${index}` }, chunk.raw);
    }

    const html = renderFormula(katex, chunk);
    if (html === null) {
      return createElement(Fragment, { key: `fallback-${index}` }, chunk.raw);
    }

    return createElement('span', {
      key: `${chunk.raw}-${index}`,
      dangerouslySetInnerHTML: { __html: html },
    });
  }), [parts, katex]);

  return createElement('span', { className: 'scientific-text' }, renderedChunks);
}

// A card re-renders for many reasons that do not touch its words; none of
// them should walk the text again or touch its DOM.
export default memo(ScientificText);
