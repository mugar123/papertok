import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/**
 * SOURCE tests: the entity pages keep the app bar for a signed-in reader,
 * and sit below it (spec §4 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 * Measured before this (signed in, feed → author): the bar unmounted in the
 * frame after the tap — `/explorer/*` was not a navbar route — and left an
 * empty band over the card while it dissolved.
 */
test('the bar stays up on an entity page, and the page is told by the one place that decides', async () => {
  const app = await read('../../App.jsx');
  const rule = app.match(/const showNavbar = \(navbarRoutes\.includes\(normalizedPathname\)([\s\S]*?)\)\s*&& Boolean\(user\)/);
  assert.ok(rule, 'showNavbar is the one place that decides');
  assert.match(rule[1], /\|\| normalizedPathname\.startsWith\('\/explorer\/'\)/);
  const route = app.match(/path="\/explorer\/:type\/:id"[\s\S]*?<\/PageTransition>/);
  assert.ok(route, 'the explorer route');
  assert.match(route[0], /<EntityExplorer\s+appChrome=\{showNavbar\}\s+publicMode=\{!user\}/);
  const publicRoute = app.match(/path="\/public\/entity\/:type\/:id"[\s\S]*?<\/PageTransition>/);
  assert.ok(publicRoute, 'the public entity route');
  assert.doesNotMatch(publicRoute[0], /appChrome/, 'the shared-link page keeps its standalone top edge');
});

test('every root the explorer can return carries the modifier, from one prop', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /export default function EntityExplorer\(\{[\s\S]*?appChrome = false,[\s\S]*?\}\) \{/);
  assert.match(jsx, /const appChromeClass = appChrome \? ' explorer--app' : '';/);
  assert.equal((jsx.match(/\$\{appChromeClass\}/g) || []).length, 3, 'skeleton, error and live page');
  assert.match(jsx, /className=\{`explorer-container explorer-skeleton explorer-skeleton--\$\{type \|\| 'entity'\}\$\{appChromeClass\}`\}/);
  assert.match(jsx, /className=\{`explorer-error\$\{appChromeClass\}`\}/);
  assert.match(jsx, /className=\{`explorer-container\$\{appChromeClass\}`\} style=\{\{ '--area-accent': entityAccent \}\}/);
});

test('below the bar: the page starts under it, the toolbar docks under it, the hero stops reserving the notch', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer--app \{\s*padding-top: var\(--nav-total\);\s*\}/);
  assert.match(css, /\.explorer--app \.explorer-hero \{\s*padding-top: var\(--space-5\);\s*\}/);
  assert.match(css, /\.explorer--app \.explorer-toolbar-wrapper \{\s*top: var\(--nav-total\);\s*\}/);
  const mobile = css.match(/@media \(max-width: 768px\) \{\s*\.explorer-hero \{[\s\S]*?\n\}/);
  assert.ok(mobile, 'the 768px block that re-pads the hero');
  assert.match(mobile[0], /\.explorer--app \.explorer-hero \{\s*padding-top: var\(--space-4\);\s*\}/);
  // The standalone page keeps its own top edge: the base rules are untouched.
  assert.match(css, /\.explorer-hero \{[^}]*padding-top: max\(var\(--space-5\), env\(safe-area-inset-top\)\);/);
  assert.match(css, /\.explorer-toolbar-wrapper \{\s*position: sticky;\s*top: 0;/);
});
