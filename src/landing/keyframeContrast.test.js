/**
 * A keyframe may not move the ground out from under its own text.
 *
 * `lpInvite` lit the AI button's plate from `--brand-yellow-soft` to
 * `--brand-yellow` and left `color` alone. In the light theme that is harmless
 * — `--text-on-brand-soft` is #111318 at both ends. In the dark theme
 * `--text-on-brand-soft` IS `--brand-yellow`, so at the peak the label and the
 * plate were the identical hex and the text disappeared, five times per visit.
 *
 * The reason this needs a test rather than a careful reviewer is that the bug
 * is INVISIBLE in the theme most people develop in. Nothing looks wrong until
 * someone switches to dark, and by then the keyframe reads as finished work.
 *
 * The rule this enforces is deliberately narrow: if a keyframe block moves
 * `background-color` between two different brand tokens, the whole keyframe
 * must also take a position on `color`. It does not try to compute contrast —
 * that is what scripts/diagnostics/landing-invite-contrast.mjs does against a
 * real browser, where the tokens actually resolve.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./motion.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');        /* a comment is not a declaration */

/** Every `@keyframes name { ... }` in the file, as {name, body}. */
function keyframes(source) {
  const out = [];
  const re = /@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g;
  let m;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ name: m[1], body: source.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const FRAMES = keyframes(css);

test('motion.css has keyframes to check at all', () => {
  assert.ok(FRAMES.length >= 5, `only found ${FRAMES.length} keyframes; the parser is wrong`);
});

test('no keyframe repaints its background without taking a position on its text', () => {
  const offenders = [];
  for (const { name, body } of FRAMES) {
    const backgrounds = [...body.matchAll(/background-color:\s*([^;\n}]+)/g)].map((m) => m[1].trim());
    if (backgrounds.length < 2) continue;                 /* not a colour move */
    if (new Set(backgrounds).size < 2) continue;          /* same value throughout */
    const hasColor = /(^|[;{\s])color:\s*[^;\n}]+/.test(body);
    if (!hasColor) offenders.push({ name, backgrounds: [...new Set(backgrounds)] });
  }
  assert.deepEqual(offenders, [],
    'these keyframes move background-color between values and never set color, '
    + 'so the text keeps whatever it had and can land on its own background: '
    + JSON.stringify(offenders));
});

test('the dark theme does not light the AI button behind its own label', () => {
  /* The specific pair that collided. `--text-on-brand-soft` resolves to
     `--brand-yellow` in the dark theme (variables.css:377 against :54), so any
     keyframe that takes a background to `--brand-yellow` while the label is on
     `--text-on-brand-soft` is painting the two the same colour.

     The fix is not to animate the text through the collision — measured, that
     only moved 1.00:1 to 1.50:1, because the two crossfades pass through each
     other. It is for the dark theme to breathe without lighting the plate. */
  const dark = FRAMES.find((f) => f.name === 'lpInviteDark');
  assert.ok(dark, 'lpInviteDark is gone; the dark theme is back on the light keyframe');
  assert.ok(!/background-color/.test(dark.body),
    'lpInviteDark moves the plate again, which is the collision it exists to avoid');
  assert.match(dark.body, /scale:\s*1\.05/, 'the dark invitation no longer swells at all');

  const rule = css.match(/html\[data-theme='dark'\][^{]*\.lp-btn--ai\s*\{([^}]*)\}/);
  assert.ok(rule, 'nothing points the dark theme at lpInviteDark');
  assert.match(rule[1], /animation-name:\s*lpInviteDark/);
});
