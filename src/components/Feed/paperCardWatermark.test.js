import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * SOURCE test for when the field glyph steps back, and where.
 *
 * `.pc-watermark` is the branch-of-science mark on the sheet -- the orbit for
 * physics, the helix for biology -- and it has two weights: 0.14 at rest, 0.1
 * behind the clippings a paper brings, so the two do not compete for the same
 * corner. The receding is right. Keying it on the mere EXISTENCE of
 * `.pc-figures` was not, for two reasons measured on 2026-09-07:
 *
 * 1. The clippings are fetched behind `isCardSettled` (PaperCard.jsx), 240ms
 *    after the card is reported visible, so `.pc-figures` can only ever mount
 *    with the card already on screen. And `.pc-figure:not(.is-loaded)` holds
 *    every clipping at `opacity: 0` until its picture arrives. So the glyph
 *    dropped 29% of its ink in a single frame -- no transition anywhere on it
 *    -- 130ms BEFORE the first clipping was visible. Measured on the guest
 *    feed: 0.140 at t=1095ms as the card arrived, 0.100 at t=1455ms with four
 *    clippings mounted and zero loaded, first clipping painted at t=1585ms.
 *    The reader watched ink leave with nothing arriving to take its place,
 *    which is what a momentary glow that then goes away actually is.
 *
 * 2. `~` is structural: it ignores `display`. Below 1080px the clippings are
 *    hidden outright, and React mounts `.pc-figures` all the same, so the glyph
 *    stepped aside on a phone for pictures that are never drawn. Verified
 *    against the shipped stylesheet at 390px: figures `display: none`,
 *    watermark `0.1`.
 *
 * What this test pins is the shape of the answer: the glyph recedes only for a
 * clipping that HAS its picture, only where clippings are drawn at all, and it
 * eases rather than steps -- so the two read as one arrival.
 */

const CSS = new URL('./PaperCard.css', import.meta.url);

/** Comments name selectors and properties in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one rule, by exact selector. */
function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in the stylesheet`);
  return match[1];
}

/** Every rule whose selector mentions `.pc-watermark`, as `[selector, body]`. */
function watermarkRules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim(), body])
    .filter(([selector]) => selector.includes('.pc-watermark'));
}

const sheet = readFile(CSS, 'utf8').then(stripComments);

test('the glyph recedes for a clipping that has its picture, not for a mounted wrapper', async () => {
  const css = await sheet;
  const receding = watermarkRules(css).filter(([, body]) => /opacity:\s*0?\.1(?![0-9])/.test(body));

  assert.equal(receding.length, 1, 'exactly one rule should take the glyph down to its receded weight');
  const [selector] = receding[0];

  assert.match(
    selector,
    /\.pc-figures:has\(\s*\.pc-figure\.is-loaded\s*\)\s*~/,
    'the receded weight must wait for a clipping that has actually loaded its picture',
  );

  // The mutation guard. The rule this replaces -- `.pc-figures ~ .pc-sheet
  // .pc-watermark` with no `:has()` -- passes every other assertion here, so
  // without this the test is green against the bug it exists to hold shut.
  assert.ok(
    !watermarkRules(css).some(([sel]) => /\.pc-figures\s*~/.test(sel) && !sel.includes(':has(')),
    'no rule may dim the glyph on the mere existence of `.pc-figures`',
  );
});

test('the glyph only steps back where the clippings are drawn', async () => {
  const css = await sheet;

  // The clippings step aside below this width; the glyph has nothing to make
  // room for there.
  const hidden = css.match(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{\s*\.pc-figures\s*\{\s*display:\s*none/);
  assert.ok(hidden, 'expected the breakpoint that hides the clippings');
  const breakpoint = hidden[1];

  // The condition of every `@media` block that takes the glyph down, so a
  // failure reports the query rather than the stylesheet.
  const conditions = [...css.matchAll(/@media([^{]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
    .filter(([, , body]) => /\.pc-watermark[^{}]*\{[^{}]*opacity:\s*0?\.1(?![0-9])/.test(body))
    .map(([, condition]) => condition.trim());

  assert.deepEqual(
    conditions,
    [`not all and (max-width: ${breakpoint}px)`],
    // The exact complement of the query that hides the clippings, so no
    // viewport falls between the two the way a `min-width: 1081px` would
    // leave 1080.5 answering neither.
    `the receding rule must be scoped to the viewports wider than ${breakpoint}px, where the clippings are drawn`,
  );
});

test('the glyph settles into its receded weight instead of stepping', async () => {
  const body = ruleBody(await sheet, '.pc-watermark');

  assert.match(body, /opacity:\s*0?\.14(?![0-9])/, 'the resting weight of the glyph');
  // Read off the card rather than written twice: the glyph and the clipping
  // are one event, and a literal here is how they come apart. Retuned together
  // with the image fade, including its linear progression.
  const jsx = await readFile(new URL('./PaperCard.jsx', import.meta.url), 'utf8');
  const entranceMs = Number(/const FIGURE_ENTRANCE_MS = (\d+);/.exec(jsx)[1]);
  assert.match(
    body,
    new RegExp(`transition:\\s*opacity\\s+${entranceMs}ms`),
    `the glyph gives way over the clipping entrance it is giving way to (FIGURE_ENTRANCE_MS, ${entranceMs}ms)`,
  );
  assert.match(
    body,
    /transition:\s*opacity\s+[^;]*linear/,
    'and on the image fade curve, independent of its movement',
  );
});

test('with movement refused the glyph gives way in the same frame as the clipping', async () => {
  const css = await sheet;

  // `.pc-figure` is already in the block that zeroes animation and transition,
  // so a clipping appears at once under the preference. A 620ms cross-fade
  // beside an instant arrival would be the two coming apart again.
  const reduced = css.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g) || [];
  const holding = reduced.find(block => /\.pc-figure\s*,/.test(block) && /transition:\s*none/.test(block));
  assert.ok(holding, 'expected the reduced-motion block that stills the clippings');
  assert.match(holding, /\.pc-watermark\s*,/, 'the glyph belongs in it too');
});

/**
 * And on a phone too (asked 2026-10-16). It used to leave below 900px; now the
 * phone keeps the field's mark in the corner like the desktop sheet does.
 */
test('the glyph is drawn at every width', async () => {
  const css = await sheet;

  assert.ok(
    !watermarkRules(css).some(([, body]) => /display:\s*none|opacity:\s*0(?![.0-9])/.test(body)),
    'no rule may take the glyph off the card',
  );
});

test('the glyph keeps its place on a desktop card', async () => {
  const css = await sheet;

  // Nothing outside a media query may hide it: the desktop sheet is where the
  // mark was designed to live, and `paperCardWatermark`'s other tests describe
  // how it behaves there.
  assert.ok(
    !/display:\s*none/.test(ruleBody(css, '.pc-watermark')),
    'the resting rule must leave the glyph drawn',
  );
});
