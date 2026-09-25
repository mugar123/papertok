import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A quote in the margin is set the way the paper sets it.
 *
 * Quotes are stored as the paragraph's source text (`buildRangeAnchor`), so a
 * highlight across a formula keeps its `$…$`, and `displayProse` printed it raw
 * in the card: "the total rate is $\Gamma = \Gamma_1 + \Gamma_2 + …$" (seen
 * 2026-09-25, on the margin and on the narrow-window sheet). The quote now goes
 * through `ScientificText`, the renderer the paper's own title uses — KaTeX on
 * demand, with its MathML copy left for assistive technology — and it carries
 * the language it was written in, because the margin also shows notes made
 * while the reader was in the other language.
 *
 * A source test, the shape the reader already uses next door: the rail is JSX
 * and does not load under node.
 */

const RAIL_JSX = new URL('./AnnotationRail.jsx', import.meta.url);

const stripScript = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const rail = readFile(RAIL_JSX, 'utf8').then(stripScript);

/** The one element with this class, whole: opening tag and children. */
function element(jsx, className) {
  const matches = [...jsx.matchAll(new RegExp(`<p\\s+className="${className}"([^>]*)>([\\s\\S]*?)</p>`, 'g'))];
  assert.equal(matches.length, 1, `expected exactly one .${className} paragraph`);
  const [, attributes, children] = matches[0];
  return { attributes, children };
}

test('a quote renders its formulas through the paper\'s own renderer, not as LaTeX source', async () => {
  const jsx = await rail;
  assert.match(jsx, /import ScientificText from '\.\.\/ScientificText\.js';/);
  const quote = element(jsx, 'rd-note-quote');
  assert.match(quote.children, /^\s*<ScientificText>\{annotation\.quote\}<\/ScientificText>\s*$/);
});

test('a quote, and the model\'s answer about it, say which language they are in', async () => {
  const jsx = await rail;
  assert.match(element(jsx, 'rd-note-quote').attributes, /\slang=\{annotation\.language\}/);
  // Only the model's answer: your own note is in whatever language you typed.
  assert.match(
    element(jsx, 'rd-note-body').attributes,
    /\slang=\{annotation\.kind === 'ai' \? annotation\.language : undefined\}/,
  );
});
