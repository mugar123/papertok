import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXIT_SAFETY_MS, PAGE_MOTIONS, isArrivalMotion, pageMotionFor } from './pageMotion.js';

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

/**
 * selector → the keyframe names it runs, for every rule in `css` that declares
 * an animation. A rule may run TWO: the travel, which owns the clock, and a
 * shorter fade that covers or uncovers early.
 */
function animationsBySelector(css) {
  const map = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declaration = body.match(/animation:([\s\S]*?);/)?.[1];
    if (!declaration) continue;
    const names = declaration.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
    for (const selector of selectors.split(',')) map[selector.trim()] = names.join(' + ');
  }
  return map;
}

/**
 * SOURCE tests for the route transition's stylesheet (spec §5–§6 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 *
 * The first cut — a 10px rise over 220ms on an expo-out, the held page
 * still — measured clean and felt like a cut. A page has to be seen
 * travelling: 32px over 300ms on a quad-out, the page underneath giving way.
 */
test('six durations, every one inside the 300ms UI band, and a held page rides the clock of the page on top of it', async () => {
  const css = await read('./PageTransition.css');
  const ms = durations(css);
  assert.deepEqual(Object.keys(ms).sort(), ['enter', 'fade', 'lateral', 'leave', 'reduced', 'reveal']);
  assert.deepEqual(ms, { enter: 300, leave: 280, lateral: 240, fade: 150, reveal: 280, reduced: 120 }, 'the durations, exactly');
  for (const [name, value] of Object.entries(ms)) assert.ok(value > 0 && value <= 300, `${name}: ${value}ms`);
  assert.ok(ms.reduced < ms.enter, 'reduced motion is shorter, not just flatter');
  // A held page has no clock of its own. It must end in the very frame the
  // page on top settles: earlier, and the arriving page is translucent over
  // nothing; later, and it paints OVER a page that has already dropped its
  // stacking. Measured 2026-09-06, from a 300ms hold under a 180ms lateral
  // entrance: eight frames of the For you card at 60% over a Research page
  // already at rest, on every tab switch.
  assert.doesNotMatch(css, /--page-hold/, 'the held page is timed by the entrance above it, never by itself');
  assert.match(css, /\[data-page-motion="hold"\] \{\s*animation: pageHold var\(--page-enter-ms\)/, 'under a deeper page, the enter clock');
  assert.match(css, /\[data-page-motion="hold-lateral"\] \{\s*animation: pageHold var\(--page-lateral-ms\)/, 'under a tab, the lateral clock');
  // Declared once, on the root, and nowhere else as a literal.
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/);
  assert.ok(root, 'the root rule');
  assert.equal(root[1].match(/--page-[a-z-]+-ms:/g).length, 6);
  assert.equal(css.replace(root[1], '').match(/\b\d+ms\b/g), null, 'durations are named, never repeated as literals');
});

test('a page is an opaque sheet, so the one underneath never shows through it', async () => {
  const css = await read('./PageTransition.css');
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/);
  assert.ok(root, 'the root rule');
  assert.match(
    root[1],
    /background: var\(--bg-primary\);/,
    'the token `body` paints: a page at rest has to look exactly as it did',
  );
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
  // Each animation is `<name> <duration> <easing> both`, where the duration is
  // a token or a fraction of one — the cover fade is a fraction of the travel
  // it rides with, so the two can never drift apart when a duration changes.
  const animations = [...css.matchAll(/(\w+) (?:var\(--page-[a-z-]+-ms\)|calc\(var\(--page-[a-z-]+-ms\) \* 0\.\d+\)) (\S+) both[,;]/g)];
  assert.equal(animations.length, 18, 'ten motion rules (three of them a travel plus a fade) and five reduced-motion rewrites');
  for (const [, name, easing] of animations) {
    assert.equal(easing, 'var(--ease-out-quad)', `${name} runs on ${easing}`);
  }
  assert.equal(css.match(/animation:/g).length, 15, 'fifteen rules, no animation escaping the form above');
});

test('each motion runs the keyframes named for it, and reduced motion swaps only the movement', async () => {
  const css = await read('./PageTransition.css');
  const [base, reduced] = css.split('@media (prefers-reduced-motion: reduce)');
  assert.ok(reduced, 'the reduced-motion block is there to split on');
  assert.deepEqual(animationsBySelector(base), {
    '.page-transition[data-page-motion="enter"]': 'pageEnterTravel + pageCover',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"]': 'pageEnterFromRight',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"]': 'pageEnterFromLeft',
    '.page-transition[data-page-motion="hold"]': 'pageHold',
    '.page-transition[data-page-motion="hold-lateral"]': 'pageHold',
    '.page-transition[data-page-motion="hold-lateral"][data-leave-direction="1"]': 'pageHoldToLeft',
    '.page-transition[data-page-motion="hold-lateral"][data-leave-direction="-1"]': 'pageHoldToRight',
    '.page-transition[data-page-motion="reveal"]': 'pageRevealTravel + pageUncover',
    '.page-transition[data-page-motion="leave"]': 'pageLeaveTravel + pageLeaveFade',
    '.page-transition[data-page-motion="fade"]': 'pageFadeOut',
  });
  assert.deepEqual(animationsBySelector(reduced), {
    '.page-transition[data-page-motion="enter"]': 'pageFadeIn',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"]': 'pageFadeIn',
    '.page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"]': 'pageFadeIn',
    '.page-transition[data-page-motion="hold"]': 'pageDim',
    '.page-transition[data-page-motion="hold-lateral"]': 'pageDim',
    '.page-transition[data-page-motion="hold-lateral"][data-leave-direction="1"]': 'pageDim',
    '.page-transition[data-page-motion="hold-lateral"][data-leave-direction="-1"]': 'pageDim',
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
  assert.deepEqual([...names].sort(), ['pageBrighten', 'pageCover', 'pageDim', 'pageEnterFromLeft', 'pageEnterFromRight', 'pageEnterTravel', 'pageFadeIn', 'pageFadeOut', 'pageHold', 'pageHoldToLeft', 'pageHoldToRight', 'pageLeaveFade', 'pageLeaveTravel', 'pageRevealTravel', 'pageUncover']);
  for (const name of names) {
    const body = keyframes(css, name);
    assert.doesNotMatch(body, /\b(width|height|top|left|right|bottom|margin|padding)\s*:/, `${name} stays on the compositor`);
    assert.match(body, /opacity:|transform:/, `${name} moves on the compositor's two properties`);
  }
  // The vertical push is split in two: the travel keeps the curve and the
  // duration that were tuned per frame, and the fade rides alongside it over a
  // fraction of the same clock, so the page arriving reaches full opacity while
  // it is still moving and COVERS the one underneath instead of blending with
  // it. Measured 2026-09-11 before the split (production, real session): for
  // ~200ms both pages were legible at once, in both directions.
  for (const name of ['pageEnterTravel', 'pageEnterFromRight', 'pageEnterFromLeft', 'pageRevealTravel']) {
    assert.match(keyframes(css, name), /to \{ (?:opacity: 1; )?transform: none; \}/, `${name} lands with no transform`);
  }
  assert.match(keyframes(css, 'pageEnterTravel'), /from \{ transform: translateY\(32px\); \}/, 'far enough to be seen');
  assert.match(keyframes(css, 'pageCover'), /from \{ opacity: 0; \}\s*to \{ opacity: 1; \}/);
  assert.match(keyframes(css, 'pageEnterFromRight'), /from \{ opacity: 0; transform: translateX\(28px\); \}/);
  assert.match(keyframes(css, 'pageEnterFromLeft'), /from \{ opacity: 0; transform: translateX\(-28px\); \}/);
  assert.match(keyframes(css, 'pageLeaveTravel'), /to \{ transform: translateY\(32px\); \}/, 'leaves the way it came');
  assert.match(keyframes(css, 'pageLeaveFade'), /from \{ opacity: 1; \}\s*to \{ opacity: 0; \}/);
  // The fade always ends BEFORE the travel it rides with: that is the whole
  // point, and a fraction of 1 or more would put the double exposure back.
  for (const [, fraction] of css.matchAll(/calc\(var\(--page-[a-z-]+-ms\) \* (0\.\d+)\)/g)) {
    assert.ok(Number(fraction) > 0 && Number(fraction) < 1, `a cover fade runs for ${fraction} of its travel`);
  }
  assert.match(css, /pageCover calc\(var\(--page-enter-ms\) \* 0\.32\)/, 'la entidad cubre pronto, sin doble exposición');
  assert.match(css, /pageLeaveFade calc\(var\(--page-leave-ms\) \* 0\.38\)/, 'al volver, la entidad se despeja antes de terminar el viaje');
  // The page underneath gives way, and comes back: never to 0, never to nothing.
  assert.match(keyframes(css, 'pageHold'), /from \{ opacity: 1; transform: none; \}\s*to \{ opacity: 0\.55; transform: scale\(0\.96\); \}/);
  assert.match(keyframes(css, 'pageRevealTravel'), /from \{ transform: scale\(0\.96\); \}\s*to \{ transform: none; \}/);
  assert.match(keyframes(css, 'pageUncover'), /from \{ opacity: 0\.55; \}\s*to \{ opacity: 1; \}/, 'the page revealed comes back from the same 0.55 it gave way to');
  for (const name of ['pageHoldToLeft', 'pageHoldToRight']) {
    assert.match(keyframes(css, name), /to \{ opacity: 0\.7; transform: translateX\(-?12px\); \}/, `${name} yields without disappearing`);
  }
});

test('the leaving page is out of flow and under the bar; an arriving page covers it only while animating', async () => {
  const css = await read('./PageTransition.css');
  const leaving = css.match(/\.page-transition\[data-page-motion="hold"\],\s*\.page-transition\[data-page-motion="hold-lateral"\],\s*\.page-transition\[data-page-motion="leave"\],\s*\.page-transition\[data-page-motion="fade"\] \{([\s\S]*?)\n\}/);
  assert.ok(leaving, 'the four leaving motions share one geometry rule');
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

test('reduced motion keeps the fades and drops the movement, for all seven animated motions', async () => {
  const css = await read('./PageTransition.css');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}\s*$/);
  assert.ok(block, 'one reduced-motion block closes the file');
  const reduced = block[1];
  for (const motion of ['enter', 'enter-lateral', 'hold', 'hold-lateral', 'reveal', 'leave', 'fade']) {
    assert.match(reduced, new RegExp(`\\[data-page-motion="${motion}"\\]`), `${motion} is redefined`);
  }
  const names = [...reduced.matchAll(/animation: (\S+) var\(--page-reduced-ms\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ['pageBrighten', 'pageDim', 'pageFadeIn', 'pageFadeOut']);
  assert.doesNotMatch(reduced, /translate|scale/);
  assert.equal(reduced.match(/animation:/g).length, names.length, 'every reduced animation rides the reduced clock');
});

/** Comments too: these assert on code, and prose must not be able to satisfy them. */
const stripAll = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

/**
 * A height settle inside a page carries a datum that lands LATE on a page the
 * reader is already looking at. While the page itself travels there is no wait
 * to smooth over, and a settle there is a second owner of the same
 * displacement on a different clock.
 */
test('every motion is classified as arriving or not, and exactly the three that travel INTO place are', () => {
  const arriving = PAGE_MOTIONS.filter(isArrivalMotion);
  assert.deepEqual(arriving, ['enter', 'enter-lateral', 'reveal']);
  // Nothing outside the table, and nothing in it left unclassified.
  for (const motion of PAGE_MOTIONS) assert.equal(typeof isArrivalMotion(motion), 'boolean');
  assert.equal(isArrivalMotion(undefined), false, 'a page with no motion is not arriving');
});

/**
 * Coming back is a fresh mount — AnimatePresence keys on the pathname, so the
 * page stepped back to was unmounted when it was left — and its data returns
 * from cache in bursts. Measured 2026-09-07 stepping back from an author to the
 * institution it was opened from: four settles inside 76ms, each restarting a
 * full 360ms clock, under a reveal still running.
 */
test('the page revealed on the way back counts as arriving, because it is a fresh mount', () => {
  const revealed = pageMotionFor({ direction: -1, lateral: false, present: true });
  assert.equal(revealed, 'reveal');
  assert.ok(isArrivalMotion(revealed));
});

/**
 * The other half of the rule. A settle still running on the page being ejected
 * finishes: it is `position: fixed` and cannot push anything, it was measured at
 * 10.4px of remaining travel, and cancelling it snapped to opacity 0.9 in one
 * frame instead.
 */
test('no motion of a page on its way out is an arrival', () => {
  for (const direction of [1, -1, 0]) {
    for (const lateral of [true, false]) {
      const motion = pageMotionFor({ direction, lateral, present: false });
      assert.equal(isArrivalMotion(motion), false, `${motion} is a leaving motion`);
    }
  }
});

/**
 * The gate is asked at the moment of a commit, and must answer from the DOM.
 * Measured 2026-09-07 with it derived from the `settled` state instead: the page
 * was visually at rest (opacity 1, translate 0) at 302ms, `animationend` had
 * fired but its setState had not been committed, and the skeleton-to-hero
 * handover landing at 329ms inside that 38ms window was snapped 115.8px in one
 * frame — a worse defect than the one the gate exists for.
 */
test('SOURCE: the arrival is a predicate read from the DOM, not a flag one commit behind', async () => {
  const code = stripAll(await readFile(new URL('./PageTransition.jsx', import.meta.url), 'utf8'));
  const gate = code.match(/const isArriving = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\);/);
  assert.ok(gate, 'the gate is a stable callback, so a consumer can ask it whenever it needs to');

  assert.match(gate[1], /isArrivalMotion\(root\.dataset\.pageMotion\)/,
    'a page on its way out must never report itself as arriving');
  assert.match(gate[1], /getAnimations\(\)\.some\(\(animation\) => animation\.playState === 'running'\)/,
    'and a page whose animation has finished is not arriving, whatever React has committed');

  assert.match(code, /<PageArrivalProvider value=\{isArriving\}>/,
    'the page subtree is handed the predicate itself');
});

/**
 * A tab change has to be seen as a PASS, not as a dissolve.
 *
 * Measured 2026-09-11 (production build, real session, For you -> Research):
 * the entrance moved 10px over 180ms and the page underneath only shrank to
 * 0.98 and dimmed — the vertical push's language, on a move that has no depth
 * in it. At 78ms both pages were legible on top of each other and nothing had
 * travelled anywhere. Per frame at 60Hz on `--ease-out-quad`:
 *
 *                     1st frame   frames with visible movement
 *   10px / 180ms         1.7px          7 of 11
 *   28px / 240ms         3.6px         13 of 14
 *   12px / 240ms         1.6px          9 of 14   (the page underneath)
 *
 * So the page arriving travels 28px and the one it replaces cedes 12px THE
 * OTHER WAY, on one clock. The page leaving cannot read its direction from
 * `data-nav-direction` — that attribute deliberately keeps the direction the
 * page ARRIVED with, so its own cards do not take the eject for a fresh
 * arrival — hence `data-leave-direction`, written only while it leaves.
 */
test('the page leaving declares the direction that is ejecting it', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(
    jsx,
    /data-leave-direction=\{present \? undefined : direction\}/,
    'only while leaving, and it is the ejecting navigation, not `arrivedWith`',
  );
  assert.match(
    jsx,
    /data-nav-direction=\{present \? direction : arrivedWith\}/,
    'the arrival attribute is untouched: the held feed must not replay pcArrive',
  );
});

test('both pages of a tab change travel, on the same axis and in opposite directions', async () => {
  const css = await read('./PageTransition.css');

  assert.match(keyframes(css, 'pageEnterFromRight'), /transform: translateX\(28px\)/);
  assert.match(keyframes(css, 'pageEnterFromLeft'), /transform: translateX\(-28px\)/);

  // The page arriving from the right pushes the one below it to the LEFT.
  assert.match(keyframes(css, 'pageHoldToLeft'), /to \{ opacity: 0\.7; transform: translateX\(-12px\); \}/);
  assert.match(keyframes(css, 'pageHoldToRight'), /to \{ opacity: 0\.7; transform: translateX\(12px\); \}/);

  for (const name of ['pageHoldToLeft', 'pageHoldToRight']) {
    assert.doesNotMatch(keyframes(css, name), /scale/, `${name} is a lateral move; a scale is the push's language`);
    assert.match(keyframes(css, name), /from \{ opacity: 1; transform: none; \}/, `${name} starts where the page is`);
  }

  // `pageHold` stays as the fallback for a lateral hold with no direction,
  // and keeps its scale: that is the vertical push's held page.
  assert.match(keyframes(css, 'pageHold'), /scale\(0\.96\)/);
});
