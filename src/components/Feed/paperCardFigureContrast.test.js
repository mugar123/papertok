import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A clipping is printed on paper, so its plate does not follow the theme.
 *
 * The figures come from ar5iv and arXiv's own HTML, and a large share of them
 * carry no background of their own: matplotlib SVGs ship without a background
 * rect at all, and the PDF→PNG conversions ship an alpha channel (`tRNS` on the
 * palette ones, RGBA on the rest). Their ink is black because it was drawn for
 * white paper. `.pc-figure` used to paint `var(--bg-card)`, which is `#ffffff`
 * on one side and `#16191f` on the other — so in the dark the ink landed on
 * near-black at 1.12:1 and the figure was, for practical purposes, not there.
 *
 * What that costs cannot be read off a single declaration: the clipping is held
 * back with `opacity`, which composites BOTH the plate and the ink towards the
 * page behind them, and the page is itself a theme token. So this test does the
 * compositing the browser would do and asserts the result, rather than pinning
 * the spelling of a colour. A future edit is free to move the plate or the
 * opacity as long as the ink stays legible on both sides.
 *
 * That the plate has no dark counterpart AT ALL is the other half of this, and
 * it is held where the codebase already records that kind of decision:
 * `--bg-figure-plate` is on the `SHARED_ON_PURPOSE` list in
 * `src/styles/darkTheme.test.js`, whose tests refuse both a colour that forgot
 * its dark value and a listed one that quietly grew it back.
 */

const VARIABLES_CSS = new URL('../../styles/variables.css', import.meta.url);
const FEED_CSS = new URL('./PaperCard.css', import.meta.url);

/** Comments name selectors, properties and colours in prose; matching them would invent both sides. */
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of one rule, by exact selector. */
function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in the stylesheet`);
  return match[1];
}

/**
 * The body of a theme block. `:root` is the light side and the base for both;
 * `:root[data-theme='dark']` only overrides, so a token declared once in
 * `:root` and never again is deliberately shared by the two.
 */
function themeBlock(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `expected a \`${selector}\` block in variables.css`);
  const open = css.indexOf('{', start);
  const end = css.indexOf('\n}', open);
  assert.ok(end > open, `expected \`${selector}\` to close`);
  return css.slice(open + 1, end);
}

function declaration(body, property) {
  const match = body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : null;
}

/** `#rgb` / `#rrggbb` to sRGB bytes. The palette is hex throughout. */
function parseHex(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  assert.ok(hex, `expected a hex colour, got \`${value}\``);
  const digits = hex[1].length === 3 ? [...hex[1]].map(d => d + d).join('') : hex[1];
  return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
}

/**
 * Resolve a token to its value on one side, falling back to the light block —
 * which is what the cascade does for anything the dark block leaves alone.
 */
function token(name, side, light) {
  const value = declaration(side, name) ?? declaration(light, name);
  assert.ok(value, `expected \`${name}\` to be defined`);
  return value;
}

/** `opacity` composites in sRGB space, over whatever is behind. */
const over = (top, bottom, alpha) => top.map((c, i) => alpha * c + (1 - alpha) * bottom[i]);

function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map(c => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const sources = Promise.all([
  readFile(VARIABLES_CSS, 'utf8').then(stripComments),
  readFile(FEED_CSS, 'utf8').then(stripComments),
]);

/** What the reader actually sees: the plate and the ink, each composited over the page. */
async function inkOnPlate(themeSelector) {
  const [variables, feed] = await sources;
  const light = themeBlock(variables, ':root');
  const side = themeSelector === ':root' ? light : themeBlock(variables, themeSelector);

  const figure = ruleBody(feed, '.pc-figure');
  const plateToken = declaration(figure, 'background');
  assert.ok(plateToken, 'expected `.pc-figure` to declare a background');
  const name = /^var\(\s*(--[\w-]+)\s*\)$/.exec(plateToken);
  assert.ok(name, `expected the plate to come from a token, got \`${plateToken}\``);

  // The clipping may be held back harder on one side than the other; whichever
  // opacity applies there is the one that decides what the reader sees.
  const override = themeSelector === ':root'
    ? null
    : (() => {
      const scoped = feed.match(new RegExp(`${themeSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\.pc-figure\\s*\\{([^}]*)\\}`));
      return scoped ? declaration(scoped[1], 'opacity') : null;
    })();
  const alpha = Number(override ?? declaration(figure, 'opacity'));
  assert.ok(Number.isFinite(alpha) && alpha > 0 && alpha <= 1, `expected a usable opacity, got \`${alpha}\``);

  const page = parseHex(token('--bg-primary', side, light));
  const plate = over(parseHex(token(name[1], side, light)), page, alpha);
  const ink = over([0, 0, 0], page, alpha);
  return { ratio: contrast(plate, ink), plate, ink, page, alpha };
}

for (const [label, selector] of [['light', ':root'], ['dark', ":root[data-theme='dark']"]]) {
  test(`black ink on a feed clipping stays legible in ${label}`, async () => {
    const { ratio } = await inkOnPlate(selector);
    assert.ok(
      ratio >= 4.5,
      `a transparent figure's black ink sits at ${ratio.toFixed(2)}:1 on the ${label} plate; 4.5:1 is the floor`,
    );
  });
}

test('the clipping stays a clipping and does not become a lit panel', async () => {
  // The floor above is satisfied by anything legible — including the one thing
  // that would be worse than the bug it replaces. Paper cannot be given back to
  // the ink without the plate itself becoming visible against a dark page, and
  // `opacity` is all that decides how brightly: on the white side it hides the
  // plate entirely (1.00:1, the clipping is only its hairline and its shadow),
  // on the dark side it is a lamp. The ink floor cannot see this, because
  // turning the plate up lifts ink and plate together — at `opacity: 1` both
  // sides read 21:1 and every other assertion here is happy while the margin
  // holds a white slab louder than the sheet it belongs to. So this one looks
  // the other way: plate against page, which is prominence rather than
  // legibility. 7.57:1 as it stands.
  const { plate, page } = await inkOnPlate(":root[data-theme='dark']");
  const loudness = contrast(plate, page);
  assert.ok(
    loudness <= 10,
    `the dark plate stands ${loudness.toFixed(2)}:1 off the page behind it; `
    + 'a clipping in the margin should not outshine the sheet',
  );
});
