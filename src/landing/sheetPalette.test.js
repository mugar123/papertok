import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The hero's ground (the yellow) and its sheet (--bg-figure-plate) do not
 * flip with the theme: variables.css says so directly for the plate, and
 * `SHARED_ON_PURPOSE` in darkTheme.test.js says so for the yellow and its
 * ink. But everything ELSE the hero's subtree names — paper()'s text and
 * borders, chip()'s tints, .lp-btn, .lp-iconbtn, .lp-deck__skip,
 * .lp-avatar — still flips at :root, same as it does everywhere else in the
 * app. Left alone, the sheet stays white while its own contents repaint for
 * a dark page they are not sitting on.
 *
 * landing.css's fix is a `[data-theme="dark"] .lp-hero { … }` block that
 * redeclares each of those tokens once, copied from :root. What this file
 * holds is that the copy stays a copy: every token the reset redeclares
 * must have the SAME value :root gives it (so a future retune of one side
 * cannot drift from the other), and every token it redeclares must be one
 * that actually flips in `:root[data-theme='dark']` in the first place (so
 * the block cannot grow tokens that were never at risk).
 */

const VARIABLES_CSS = new URL('../styles/variables.css', import.meta.url);
const LANDING_CSS = new URL('./landing.css', import.meta.url);

/** Comments name selectors and values in prose; matching them would invent both sides. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of a `selector {` block, from its own `{` to its own closing `\n}`. */
function block(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `expected to find \`${selector}\``);
  const open = css.indexOf('{', start);
  const end = css.indexOf('\n}', open);
  assert.ok(end > open, `expected \`${selector}\` to close`);
  return css.slice(open + 1, end);
}

/** Every `--token: value;` pair declared directly in a block's body. */
function tokensIn(body) {
  const tokens = new Map();
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

const sources = Promise.all([
  readFile(VARIABLES_CSS, 'utf8').then(stripComments),
  readFile(LANDING_CSS, 'utf8').then(stripComments),
]);

const RESET_SELECTOR = '[data-theme="dark"] .lp-hero {';

test('the hero reset redeclares at least one token', async () => {
  const [, landing] = await sources;
  const reset = tokensIn(block(landing, RESET_SELECTOR));
  assert.ok(reset.size > 0, 'expected the hero to pin at least one token against the theme');
});

test('every token the hero reset redeclares matches its :root value exactly', async () => {
  const [variables, landing] = await sources;
  const root = tokensIn(block(variables, ':root {'));
  const reset = tokensIn(block(landing, RESET_SELECTOR));

  const mismatches = [];
  for (const [name, value] of reset) {
    if (!root.has(name)) { mismatches.push(`${name}: not declared in :root at all`); continue; }
    if (root.get(name) !== value) mismatches.push(`${name}: hero reset has \`${value}\`, :root has \`${root.get(name)}\``);
  }
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the hero reset only pins tokens that actually flip in the dark theme', async () => {
  const [variables, landing] = await sources;
  const dark = tokensIn(block(variables, ":root[data-theme='dark'] {"));
  const reset = tokensIn(block(landing, RESET_SELECTOR));

  const unnecessary = [...reset.keys()].filter((name) => !dark.has(name));
  assert.deepEqual(unnecessary, [], `these do not flip in the dark theme, so pinning them is noise: ${unnecessary.join(', ')}`);
});
