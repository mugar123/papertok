import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The paper page framed the card over the whole viewport while a fixed bar
 * covered its top.
 *
 * `.public-paper-page` is `100dvh` from the top of the window, and a bar is
 * fixed over it: the app navbar (`--nav-total`) signed in, the page's own
 * `.public-paper-nav` (`--nav-height` plus the inset) signed out. Nothing
 * subtracted that bar from the card's frame; only the floating back button
 * placed itself below it. The sheet is anchored to the bottom of its frame, so
 * a short abstract left the gap at the top and hid the fault; a long one
 * filled the sheet upwards and its first rows — the accent rule, the kicker,
 * the chips — ended under the bar. Measured at 1440×800, signed out, on an
 * abstract of 1920 characters: bar 0–56, sheet from 24 (32px under the bar),
 * body from 56. The feed at the same size frames its card from 56 to 800,
 * because `.feed-wrapper` starts below `--nav-total`; with the bar padded off
 * this page, the sheet started at 80 and the body at 112, the same frame.
 *
 * Held here as a stylesheet contract, the way `paperCardOverflowStyles.test.js`
 * holds the sheet's overflow chain: a page that forgets the bar renders, builds
 * and lints, and only a reader with a long abstract notices.
 */

const CSS = new URL('./PublicPaperPage.css', import.meta.url);
const JSX = new URL('./PublicPaperPage.jsx', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/** The declarations of one rule, by exact selector. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[};])\\s*${escaped}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in the stylesheet`);
  return match[1];
}

const css = readFile(CSS, 'utf8').then(stripComments);
const jsx = readFile(JSX, 'utf8').then(stripComments);

test('the page starts its frame under the bar it draws for a visitor', async () => {
  const page = ruleBody(await css, '.public-paper-page');

  // The visitor bar keeps `--nav-height` at every width (it has no 768px
  // breakpoint of its own), so the offset is spelled out rather than taken
  // from `--nav-total`, which shrinks on phones for the app navbar only.
  assert.match(
    page,
    /--public-paper-bar:\s*calc\(\s*var\(--nav-height\)\s*\+\s*var\(--inset-top\)\s*\)/,
    'the page must name the height of the bar fixed over it',
  );
  assert.match(page, /padding-top:\s*var\(--public-paper-bar\)/, 'the frame must begin below the bar');
});

test('signed in, the frame tracks the app navbar instead', async () => {
  const app = ruleBody(await css, '.public-paper-page--app');
  assert.match(app, /--public-paper-bar:\s*var\(--nav-total\)/);

  // The modifier is the page's only knowledge of which bar is above it, and it
  // has to follow the same branch that swaps the chrome.
  assert.match(
    await jsx,
    /isAuthenticated[^\n]*public-paper-page--app/,
    'the app modifier must be set on the page when the session decides the chrome',
  );
});

test('the skeleton covers the frame the card will take, not the bar', async () => {
  const skeleton = ruleBody(await css, '.public-paper-skeleton');
  assert.match(skeleton, /top:\s*var\(--public-paper-bar\)/, 'a skeleton centred on the whole viewport sits higher than the card that replaces it');
  assert.doesNotMatch(skeleton, /inset:\s*0\b/, '`inset: 0` would put the skeleton back under the bar');
});
