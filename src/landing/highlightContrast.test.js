// The highlight, both themes, both forms — decision (F): a background-size
// band on paper, a text-decoration rule below the baseline on ink (the
// closing screen, and the whole dark theme), because a 42%-tall band under
// white glyphs eats half of every letter and text-decoration cannot be
// animated. This file pins the STATIC shape both forms rest on (the base
// .lp-hl rule and its dark/close override in landing.css) and the contrast
// each one actually clears; the ANIMATED arrival (background-size 0% → 100%
// under [data-motion="on"], motion.css) is driver behaviour with no source
// of its own to read a contrast ratio from, so it is left to the deck
// probe's own capture step rather than asserted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const vars = readFileSync(fileURLToPath(new URL('../styles/variables.css', import.meta.url)), 'utf8');
const css = readFileSync(fileURLToPath(new URL('./landing.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
// The shared sheet, for the one number this file refuses to repeat: the
// wordmark's band, which the closing screen has to match.
const staticCss = readFileSync(fileURLToPath(new URL('../legal/static-page.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const token = (block, name) => block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const light = vars.split('[data-theme')[0];
// variables.css itself writes this selector with SINGLE quotes
// (`:root[data-theme='dark']`) — landing.css's own dark-theme selectors use
// double quotes, but this file is not that one. The brief's snippet
// searched for the double-quoted form, which never occurs in variables.css,
// so `dark` sliced to the last byte of the file and every lookup inside it
// silently returned undefined. Fixed to the string variables.css actually
// contains.
const dark = vars.slice(vars.indexOf("[data-theme='dark']"));

test('on paper the band sits under ink: ink on yellow clears 4.5:1 by a mile', () => {
  assert.ok(ratio(token(light, '--text-primary'), token(light, '--brand-yellow')) >= 4.5);
  assert.match(css, /\.lp-hl \{[^}]*box-shadow: inset 0 -0\.42em 0 var\(--brand-yellow\)/);
});
test('on ink the band is the wordmark\'s, and it sits under the baseline where the glyphs keep their own contrast', () => {
  const rule = css.match(/\[data-theme="dark"\] \.lp-hl, \.lp-close \.lp-hl \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /box-shadow: inset 0 -0\.32em 0 var\(--brand-yellow\)/);
  assert.match(rule, /text-decoration: none/);
  assert.ok(ratio(token(dark, '--text-primary'), token(dark, '--bg-primary')) >= 4.5);

  // 0.32em, and the number is not free: it is the wordmark's, read out of the
  // shared sheet rather than repeated here, so the day one moves the other
  // fails. Above ~0.36em the band starts climbing into the x-height of white
  // letters, which is the defect this whole rule exists to avoid.
  const wordmark = staticCss.match(/\.lp-wordmark span \{([^}]*)\}/)?.[1] || '';
  const band = (decl) => decl.match(/inset 0 -([\d.]+)em/)?.[1];
  assert.equal(band(rule), band(wordmark), 'the closing screen no longer draws the wordmark\'s own band');
  assert.ok(Number(band(rule)) <= 0.36, `a ${band(rule)}em band reaches into the letters`);

  // The glyphs were the only thing measured here until the whole-branch
  // review noticed the filete itself was unasserted. It is the highlight —
  // take the yellow away and nothing marks the phrase — so on this side it is
  // a non-text graphical object carrying meaning next to text: WCAG 1.4.11,
  // 3:1 against what it is drawn on, not the 4.5:1 the glyphs answer to.
  //
  // Pinned first, because the ratios below are worth nothing if the rule
  // stops drawing the band in this token: a recolour to, say,
  // `--brand-yellow-soft` (#35290b on this side — a dark amber wash, 1.35:1
  // on the page) would leave every assertion in this file green while the
  // mark vanished into the background.
  assert.match(rule, /inset 0 -[\d.]+em 0 var\(--brand-yellow\)/);

  // Read out of `light`, not `dark`, and that is not a slip. variables.css
  // deliberately does NOT redefine `--brand-yellow` in the dark block ("Brand
  // yellow, brand orange and `--text-on-brand` are not redefined: they are
  // the same mark on both sides") — only `--brand-yellow-soft` flips. So
  // `token(dark, '--brand-yellow')` is `undefined`, and an assertion written
  // the obvious way would not fail loudly; it would throw inside lum() on a
  // slice of undefined, which reads as a broken test rather than a contrast
  // finding. `:root`'s own declaration is the value the dark page actually
  // resolves.
  const yellow = token(light, '--brand-yellow');

  // One comma-separated rule, two grounds, because `.lp-close` overrides the
  // page: `[data-theme="dark"] .lp-hl` sits on the body (static-page.css:16,
  // `background: var(--bg-primary)`) wherever `.lp-problem` and `.lp-reader`
  // put a highlight, while `[data-theme="dark"] .lp-close` repaints the
  // closing screen `--bg-secondary` (landing.css:723). The second is the
  // LIGHTER of the two on this side (#1a1d24 against #111318), so it is the
  // one that gates — measured 11.64:1 there and 12.82:1 on the page. Both
  // assertions are kept rather than only the worst: if a future task
  // repaints either surface, the failure should name which screen moved.
  assert.ok(ratio(yellow, token(dark, '--bg-primary')) >= 3);
  assert.ok(ratio(yellow, token(dark, '--bg-secondary')) >= 3);
});
