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
test('on ink the highlight is a rule below the baseline, not a band: the glyphs keep their own contrast', () => {
  const rule = css.match(/\[data-theme="dark"\] \.lp-hl, \.lp-close \.lp-hl \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /box-shadow: none/);
  assert.match(rule, /text-decoration: underline/);
  assert.match(rule, /text-decoration-thickness: 0\.08em/);
  assert.match(rule, /text-decoration-skip-ink: auto/);
  assert.ok(ratio(token(dark, '--text-primary'), token(dark, '--bg-primary')) >= 4.5);
});
