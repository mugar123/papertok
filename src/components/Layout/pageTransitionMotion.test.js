import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXIT_SAFETY_MS, PAGE_MOTIONS } from './pageMotion.js';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/** Every `--page-<name>-ms: <n>ms` declared in the file, by name. */
function durations(css) {
  const out = {};
  for (const [, name, ms] of css.matchAll(/--page-([a-z-]+)-ms: (\d+)ms;/g)) out[name] = Number(ms);
  return out;
}

/** The body of one `@keyframes <name> { … }` block. */
function keyframes(css, name) {
  const match = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `@keyframes ${name} is declared`);
  return match[1];
}

/** selector → keyframe name, for every rule in `css` that declares an animation. */
function animationsBySelector(css) {
  const map = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const name = body.match(/animation: (\S+) /)?.[1];
    if (!name) continue;
    for (const selector of selectors.split(',')) map[selector.trim()] = name;
  }
  return map;
}

/**
 * SOURCE tests for the route transition's stylesheet (spec §5–§6 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 *
 * The first cut — a 10px rise over 220ms on an expo-out, the held page
 * still — measured clean and felt like a cut. A page has to be seen
 * travelling: 24px over 300ms on a quad-out, the page underneath giving way.
 */
test('seven durations, every one inside the 300ms UI band, and the hold outlasts both entrances', async () => {
  const css = await read('./PageTransition.css');
  const ms = durations(css);
  assert.deepEqual(Object.keys(ms).sort(), ['enter', 'fade', 'hold', 'lateral', 'leave', 'reduced', 'reveal']);
  assert.deepEqual(ms, { enter: 300, leave: 260, lateral: 180, fade: 150, hold: 300, reveal: 260, reduced: 120 }, 'the durations, exactly');
  for (const [name, value] of Object.entries(ms)) assert.ok(value > 0 && value <= 300, `${name}: ${value}ms`);
  assert.ok(ms.hold >= ms.enter && ms.hold >= ms.lateral, 'the held page is not removed under a page still arriving');
  assert.ok(ms.reduced < ms.enter, 'reduced motion is shorter, not just flatter');
  // Declared once, on the root, and nowhere else as a literal.
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/);
  assert.ok(root, 'the root rule');
  assert.equal(root[1].match(/--page-[a-z-]+-ms:/g).length, 7);
  assert.equal(css.replace(root[1], '').match(/\b\d+ms\b/g), null, 'durations are named, never repeated as literals');
});

test('the leaving page hands itself back before the safety clock, never after', async () => {
  const ms = durations(await read('./PageTransition.css'));
  assert.ok(EXIT_SAFETY_MS > Math.max(...Object.values(ms)), `${EXIT_SAFETY_MS}ms outlasts every duration`);
});

test('every motion has a rule, and everything rides a curve that can be seen travelling', async () => {
  const css = await read('./PageTransition.css');
  for (const motion of PAGE_MOTIONS) {
    if (motion === 'rest') {
      assert.doesNotMatch(css, /data-page-motion="rest"/, 'rest is the absence of a rule');
      continue;
    }
    assert.match(css, new RegExp(`\\[data-page-motion="${motion}"\\]`), `${motion} has a rule`);
  }
  assert.doesNotMatch(css, /ease-in(?!-out)/);
  assert.doesNotMatch(css, /cubic-bezier\(/, 'the curve is the token, not a literal');
  assert.doesNotMatch(css, /--ease-out-expo/, 'the expo-out did 80% of its change in the first 60ms: a cut, not a movement');
  const animations = [...css.matchAll(/animation: (\S+) var\(--page-[a-z-]+-ms\) (\S+) both;/g)];
  assert.equal(animations.length, 11, 'seven motions and four reduced-motion rewrites, each named, timed and filled both ways');
  for (const [, name, easing] of animations) {
    assert.equal(easing, 'var(--ease-out-quad)', `${name} runs on ${easing}`);
  }
  assert.equal(css.match(/animation:/g).length, animations.length, 'no animation escapes the form above');
});

test('each motion runs the keyframes named for it, and reduced motion swaps only the movement', async () => {
  const css = await read('./PageTransition.css');
  const [base, reduced] = css.split('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduced, 'the reduced-motion block is there to split on');
  assert.deepEqual(animationsBySelector(base), {
    '.page-transition[data-page-motion="enter"]': 'pageEnter',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"]': 'pageEnterFromRight',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"]': 'pageEnterFromLeft',
    '.page-transition[data-page-motion="hold"]': 'pageHold',
    '.page-transition[data-page-motion="reveal"]': 'pageReveal',
    '.page-transition[data-page-motion="leave"]': 'pageLeave',
    '.page-transition[data-page-motion="fade"]': 'pageFadeOut',
  });
  assert.deepEqual(animationsBySelector(reduced), {
    '.page-transition[data-page-motion="enter"]': 'pageFadeIn',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"]': 'pageFadeIn',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"]': 'pageFadeIn',
    '.page-transition[data-page-motion="hold"]': 'pageDim',
    '.page-transition[data-page-motion="reveal"]': 'pageBrighten',
    '.page-transition[data-page-motion="leave"]': 'pageFadeOut',
    '.page-transition[data-page-motion="fade"]': 'pageFadeOut',
  });
});

test('the tokens are declared, and the one this file rides on decelerates for its whole run', async () => {
  const variables = await read('../../styles/variables.css');
  assert.match(variables, /--ease-out-expo: cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
  assert.match(variables, /--ease-out-quad: cubic-bezier\(0\.25, 0\.46, 0\.45, 0\.94\);/);
});

test('pages move on opacity and transform only, travel far enough to be seen, and land with no transform', async () => {
  const css = await read('./PageTransition.css');
  const names = [...css.matchAll(/@keyframes ([a-zA-Z]+) \{/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), ['pageBrighten', 'pageDim', 'pageEnter', 'pageEnterFromLeft', 'pageEnterFromRight', 'pageFadeIn', 'pageFadeOut', 'pageHold', 'pageLeave', 'pageReveal']);
  for (const name of names) {
    const body = keyframes(css, name);
    assert.doesNotMatch(body, /\b(width|height|top|left|right|bottom|margin|padding)\s*:/, `${name} stays on the compositor`);
    assert.match(body, /opacity:/);
  }
  for (const name of ['pageEnter', 'pageEnterFromRight', 'pageEnterFromLeft', 'pageReveal']) {
    assert.match(keyframes(css, name), /to \{ opacity: 1; transform: none; \}/, `${name} lands with no transform`);
  }
  assert.match(keyframes(css, 'pageEnter'), /from \{ opacity: 0; transform: translateY\(24px\); \}/, 'far enough to be seen');
  assert.match(keyframes(css, 'pageEnterFromRight'), /from \{ opacity: 0; transform: translateX\(10px\); \}/);
  assert.match(keyframes(css, 'pageEnterFromLeft'), /from \{ opacity: 0; transform: translateX\(-10px\); \}/);
  assert.match(keyframes(css, 'pageLeave'), /to \{ opacity: 0; transform: translateY\(24px\); \}/, 'leaves the way it came');
  // The page underneath gives way, and comes back: never to 0, never to nothing.
  assert.match(keyframes(css, 'pageHold'), /from \{ opacity: 1; transform: none; \}\s*to \{ opacity: 0\.6; transform: scale\(0\.98\); \}/);
  assert.match(keyframes(css, 'pageReveal'), /from \{ opacity: 0\.6; transform: scale\(0\.98\); \}\s*to \{ opacity: 1; transform: none; \}/);
});

test('the leaving page is out of flow and under the bar; an arriving page covers it only while animating', async () => {
  const css = await read('./PageTransition.css');
  const leaving = css.match(/\.page-transition\[data-page-motion="hold"\],\s*\.page-transition\[data-page-motion="leave"\],\s*\.page-transition\[data-page-motion="fade"\] \{([\s\S]*?)\n\}/);
  assert.ok(leaving, 'the three leaving motions share one geometry rule');
  assert.match(leaving[1], /position: fixed;/);
  assert.match(leaving[1], /left: 0;\s*right: 0;/);
  assert.match(leaving[1], /height: auto;/, 'a fixed flex column must not squeeze a 1300px page into the viewport');
  assert.match(leaving[1], /z-index: 1;/);
  assert.match(leaving[1], /pointer-events: none;/);
  assert.doesNotMatch(leaving[1], /\btop:/, '`top` is the page\'s own scroll, set inline by the component');
  const entering = css.match(/\.page-transition\[data-page-motion="enter"\],\s*\.page-transition\[data-page-motion="enter-lateral"\] \{([\s\S]*?)\n\}/);
  assert.ok(entering, 'the two animated arrivals share one stacking rule');
  assert.match(entering[1], /position: relative;/);
  assert.match(entering[1], /z-index: 2;/);
  // A revealed page stays UNDER the page leaving on top of it.
  assert.doesNotMatch(css, /data-page-motion="reveal"\]\s*\{\s*position/);
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/)[1];
  assert.match(root, /width: 100%;\s*height: 100%;\s*display: flex;\s*flex-direction: column;/, 'the route root keeps the box the motion.div had');
});

test('reduced motion keeps the fades and drops the movement, for all six animated motions', async () => {
  const css = await read('./PageTransition.css');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}\s*$/);
  assert.ok(block, 'one reduced-motion block closes the file');
  const reduced = block[1];
  for (const motion of ['enter', 'enter-lateral', 'hold', 'reveal', 'leave', 'fade']) {
    assert.match(reduced, new RegExp(`\\[data-page-motion="${motion}"\\]`), `${motion} is redefined`);
  }
  const names = [...reduced.matchAll(/animation: (\S+) var\(--page-reduced-ms\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ['pageBrighten', 'pageDim', 'pageFadeIn', 'pageFadeOut']);
  assert.doesNotMatch(reduced, /translate|scale/);
  assert.equal(reduced.match(/animation:/g).length, names.length, 'every reduced animation rides the reduced clock');
});
