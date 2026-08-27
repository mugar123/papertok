import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A colour token that exists on one side of the theme and not on the other
 * fails the way every other token bug in this codebase fails: silently. The
 * light value simply keeps applying, and a chip stays white on a black page
 * until somebody happens to open that screen at night.
 *
 * So the rule is mechanical: every token in `:root` whose value is a colour is
 * redefined under `[data-theme='dark']`, unless it is on the short list below
 * of marks that deliberately do not change value. Adding a colour token to the
 * light palette and nothing else fails here, which is the whole point — the
 * dark block is not a thing you remember to update.
 */

/**
 * The three values that are the same on both sides, and why.
 *
 * They are not "colours we forgot": a brand mark that changes value stops being
 * a mark, and the ink that sits on the yellow cannot flip when the yellow does
 * not. Anything else added here needs a reason written next to it.
 */
const SHARED_ON_PURPOSE = new Map([
  ['--brand-yellow', 'the mark itself: it reads the same on paper and on ink'],
  ['--brand-orange', 'the focus ring, which must not depend on the theme'],
  ['--text-on-brand', 'ink, by definition — it exists to sit on the yellow'],
]);

const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/i;

function tokensIn(css, blockStart) {
  const start = css.indexOf(blockStart);
  assert.notEqual(start, -1, `expected to find the ${blockStart} block`);
  const end = css.indexOf('\n}', start);
  assert.notEqual(end, -1, `expected ${blockStart} to be closed`);
  const body = css.slice(start, end);

  const tokens = new Map();
  for (const [, name, value] of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

test('every colour the light palette defines has a dark value', async () => {
  const css = await readFile(new URL('./variables.css', import.meta.url), 'utf8');
  const light = tokensIn(css, ':root {');
  const dark = tokensIn(css, ":root[data-theme='dark'] {");

  assert.ok(light.size > 60, 'expected to have parsed the light palette');
  assert.ok(dark.size > 40, 'expected to have parsed the dark palette');

  const missing = [];
  for (const [name, value] of light) {
    // A value built out of other tokens follows them; only literals need a
    // second definition.
    if (value.includes('var(') && !COLOUR.test(value.replace(/var\([^)]*\)/g, ''))) continue;
    if (!COLOUR.test(value)) continue;
    if (SHARED_ON_PURPOSE.has(name) || dark.has(name)) continue;
    missing.push(name);
  }

  assert.deepEqual(missing.sort(), [], 'colour tokens with no dark value stay light on an ink page');
});

test('the dark palette invents no token the light one does not have', async () => {
  const css = await readFile(new URL('./variables.css', import.meta.url), 'utf8');
  const light = tokensIn(css, ':root {');
  const dark = tokensIn(css, ":root[data-theme='dark'] {");

  // `color-scheme` is a property, not a token, and is set on both sides.
  const orphans = [...dark.keys()].filter(name => !light.has(name)).sort();
  assert.deepEqual(orphans, [], 'a token only the dark block defines is undefined in the light theme');
});

test('the marks that must not flip are not redefined in the dark block', async () => {
  // Otherwise the allowlist above becomes a way to silence the first test
  // rather than a record of a decision.
  const css = await readFile(new URL('./variables.css', import.meta.url), 'utf8');
  const dark = tokensIn(css, ":root[data-theme='dark'] {");

  for (const [name, reason] of SHARED_ON_PURPOSE) {
    assert.ok(!dark.has(name), `${name} is listed as shared (${reason}) but the dark block redefines it`);
  }
});
