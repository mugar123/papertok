import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * 2026-10-17: the loading skeleton was a white bordered box of its own width,
 * left of where the card lands and without the rail, so the swap jumped. It is
 * now built on the card's frame, which carries the card's widths and
 * breakpoints, and draws only the rows.
 */
test('SOURCE: the skeleton stands in the card frame, rail included, and draws no box of its own', async () => {
  const jsx = await read('./SkeletonCard.jsx');
  // The card's own frame, nested as the card nests it, so the card's widths,
  // centring and breakpoints apply.
  const frame = ['"pc ', '"pc-sheet"', '"pc-body"', '"pc-action-bar"', '"pc-side-actions'];
  const at = frame.map((name) => jsx.indexOf(`className=${name}`));
  assert.ok(at.every((i) => i > 0), 'every piece of the card frame is there');
  assert.deepEqual([...at].sort((x, y) => x - y), at, 'in the card\'s order');
  assert.match(jsx, /aria-hidden="true"/, 'decoration: the page announces the loading');
  const css = await read('./SkeletonCard.css');
  assert.doesNotMatch(css, /\.sk-body|border-radius: var\(--radius-2xl\)/, 'no card box: the real card has none');
  assert.match(css, /\.sk \.pc-sheet,\s*\.sk \.pc-side-actions \{\s*animation: none;/, 'a placeholder arrives at rest');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sk-block::after \{\s*animation: none;/);
});
