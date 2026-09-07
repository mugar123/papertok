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
  assert.match(css, /\n\.explorer--app \{[^}]*padding-top: var\(--nav-total\);/);
  assert.match(css, /\.explorer--app \.explorer-hero \{[^}]*padding-top: var\(--space-5\);/);
  assert.match(css, /\.explorer--app \.explorer-toolbar-wrapper \{[^}]*top: var\(--nav-total\);/);
  const mobile = css.match(/@media \(max-width: 768px\) \{\s*\.explorer-hero \{[\s\S]*?\n\}/);
  assert.ok(mobile, 'the 768px block that re-pads the hero');
  assert.match(mobile[0], /\.explorer--app \.explorer-hero \{[^}]*padding-top: var\(--space-4\);/);
  // The standalone page keeps its own top edge: the base rules are untouched.
  assert.match(css, /\.explorer-hero \{[^}]*padding-top: max\(var\(--space-5\), env\(safe-area-inset-top\)\);/);
  assert.match(css, /\.explorer-toolbar-wrapper \{\s*position: sticky;\s*top: 0;/);
});

/**
 * The band OPENS; it does not appear.
 *
 * `appChrome` does not arrive with the page: /explorer/:type/:id is
 * deliberately outside ProtectedRoute, so it is the one page that paints real
 * content while the auth gate is still open, and the class lands mid-flight.
 * Measured 2026-09-07 over CDP against a real signed-in session, production
 * build, cold, 1280x900: the class arrived at t=909 and this padding went
 * 0 -> 56px in ONE frame, 217ms into the hero body's own 360ms height settle —
 * two vertical movements of the same rows on the same frames, one eased and one
 * cut. The settle cannot absorb it: it animates the height of
 * `.explorer-hero-content`, which owns a BOTTOM edge, and this is a top edge on
 * an ancestor.
 */
test('the band opens on the bar’s own clock instead of appearing in one frame', async () => {
  const css = await read('./EntityExplorer.css');
  const navbar = await read('../Layout/Navbar.css');

  // Read from the bar rather than repeated, so the two cannot drift.
  const arrive = navbar.match(/\.navbar--arriving \{\s*animation: navbarArrive ([\d.]+s) (ease-out) both;/);
  assert.ok(arrive, 'the bar still arrives on an animation of its own');
  const [, duration, easing] = arrive;

  const offsets = [
    ['\\n\\.explorer--app', 'padding-top'],
    ['\\.explorer--app \\.explorer-hero', 'padding-top'],
    ['\\.explorer--app \\.explorer-toolbar-wrapper', 'top'],
  ];
  for (const [selector, property] of offsets) {
    const rule = css.match(new RegExp(`${selector} \\{([^}]*)\\}`));
    assert.ok(rule, `${selector} must still exist`);
    assert.match(
      rule[1],
      new RegExp(`transition: ${property} ${duration} ${easing};`),
      `${selector} must open on the bar's clock, not cut`,
    );
  }

  // Declared only inside the .explorer--app rules, which is what makes the
  // transition run when the class LANDS and not when it leaves (a transition is
  // read from the after-change style) — and leaves the standalone page's own
  // top edge instant through rotations and the mobile URL bar.
  const heroBase = css.match(/\n\.explorer-hero \{([^}]*)\}/);
  assert.ok(heroBase, 'the hero base rule');
  assert.doesNotMatch(heroBase[1], /transition:/, 'a signed-out page must not animate its own top edge');
  const toolbarBase = css.match(/\n\.explorer-toolbar-wrapper \{([^}]*)\}/);
  assert.ok(toolbarBase, 'the toolbar base rule');
  assert.doesNotMatch(toolbarBase[1], /transition: top/, 'nor its dock point');

  // And a reader who asked for no movement gets the offset instantly, the way
  // the bar itself opts out (Navbar.css).
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/);
  assert.ok(reduced, 'the reduced-motion block');
  for (const selector of ['\\.explorer--app,', '\\.explorer--app \\.explorer-hero,', '\\.explorer--app \\.explorer-toolbar-wrapper,']) {
    assert.match(reduced[0], new RegExp(selector), 'the band lands instantly under reduced motion');
  }
});
