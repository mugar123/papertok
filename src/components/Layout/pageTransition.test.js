import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests for the route transition.
 */
test('a page arrives and leaves on opacity and a slide, with no scale to re-raster at the end', async () => {
  const jsx = await read('./PageTransition.jsx');
  const variants = jsx.slice(jsx.indexOf('const routeVariants = {'), jsx.indexOf('const reducedMotionVariants'));
  assert.doesNotMatch(variants, /scale:/, 'no scale in the route variants');
  assert.match(variants, /x: direction \* TRAVEL_PX/);
  assert.match(variants, /x: direction \* -TRAVEL_PX \* 0\.6/);
  assert.doesNotMatch(jsx, /transformOrigin/, 'nothing left for an origin to anchor');
  assert.doesNotMatch(jsx, /isProject/, 'a project page rides the same transition as the rest');
});

/**
 * SOURCE test for the tab bar.
 *
 * The three navbar tabs are siblings, and history cannot say which way a move
 * between them goes: every tab press is a push, so the index only ever grows.
 * Measured before this, signed in: `data-nav-direction` was 1 going to
 * Following AND 1 coming back, so the page entered from the right both times
 * and returning to a tab looked like arriving somewhere new. The order of the
 * bar is what knows, and it wins over history when it has an answer.
 */
test('a move between navbar tabs takes its direction from the bar, not from history', async () => {
  const jsx = await read('./PageTransition.jsx');
  const hook = await read('../../hooks/usePageTransitionCustom.js');
  assert.match(hook, /import \{ lateralTabDirection \} from '\.\.\/utils\/tabDirection\.js';/);
  // The lateral answer wins; history is the fallback, not the other way round.
  assert.match(hook, /const lateral = lateralTabDirection\(useLocation\(\)\.pathname\);/);
  assert.match(hook, /return \{ direction: lateral \?\? historyDirection, lateral: lateral !== null \};/);
  // A component file that also exports a function breaks Fast Refresh for the
  // whole module, which is why the hook does not live beside the component.
  assert.doesNotMatch(jsx, /export function/, 'PageTransition.jsx exports only its component');
});

/**
 * SOURCE test for the page on its way OUT.
 *
 * `AnimatePresence` keeps the previous `<Routes>` element itself while it
 * exits — the same React element, never re-rendered — so the outgoing
 * `PageTransition` cannot learn that a navigation happened and resolves its
 * `exit` against the `custom` it mounted with. Measured before `App` passed
 * one down: the first tab switch after arriving at the bar left on the 200ms
 * hierarchy clock and in the direction it had arrived with, while the incoming
 * page correctly used the lateral one — the two halves of one handover
 * disagreeing. Every switch after that was right, which is exactly what makes
 * it easy to miss.
 */
test('the leaving page is told about the navigation it is leaving for', async () => {
  const transition = await read('./PageTransition.jsx');
  // The component READS the answer; it must never compute one. `<Routes
  // location={…}>` gives its subtree a location context of its own, so the
  // outgoing page — kept mounted by AnimatePresence — sees the tab it is
  // LEAVING. Measured with the component calling the hook itself: the leaving
  // page asked about "/" while the memory had already moved to "/following",
  // got -1, and dragged the shared memory back with it.
  assert.match(transition, /const custom = usePageTransitionCustomValue\(\);/);
  assert.match(transition, /custom=\{custom\}/);
  assert.doesNotMatch(transition, /usePageTransitionCustom\(\)/, 'the component never computes the direction itself');
  const app = await read('../../App.jsx');
  assert.match(app, /const pageTransitionCustom = usePageTransitionCustom\(\)/);
  assert.match(app, /<PageTransitionCustomProvider value=\{pageTransitionCustom\}>/);
  assert.match(app, /<AnimatePresence mode="wait" initial=\{false\} custom=\{pageTransitionCustom\}>/);
  // Exactly one caller, or the memory goes backwards.
  assert.equal((app.match(/usePageTransitionCustom\(\)/g) || []).length, 1);
});

/**
 * A step sideways is shorter than a step down. Measured before this: the
 * outgoing page was gone at 250ms and the incoming one did not reach full
 * opacity until ~549ms, with `mode="wait"` holding them strictly sequential.
 */
test('a lateral move is quicker than a descent, on the same curves', async () => {
  const jsx = await read('./PageTransition.jsx');
  const enter = Number(jsx.match(/const ENTER_MS = ([\d.]+);/)?.[1]);
  const exit = Number(jsx.match(/const EXIT_MS = ([\d.]+);/)?.[1]);
  const lateralEnter = Number(jsx.match(/const LATERAL_ENTER_MS = ([\d.]+);/)?.[1]);
  const lateralExit = Number(jsx.match(/const LATERAL_EXIT_MS = ([\d.]+);/)?.[1]);
  for (const [name, value] of Object.entries({ enter, exit, lateralEnter, lateralExit })) {
    assert.ok(Number.isFinite(value), `${name} is declared as a number`);
  }
  assert.ok(lateralEnter < enter, 'a tab arrives quicker than a page entered from a card');
  assert.ok(lateralExit < exit, 'and it leaves quicker too');
  // Under half of what the pair used to cost end to end.
  assert.ok(lateralEnter + lateralExit <= 0.36, 'the pair stays inside a third of a second');
  const variants = jsx.slice(jsx.indexOf('const routeVariants = {'), jsx.indexOf('const reducedMotionVariants'));
  assert.match(variants, /duration: lateral \? LATERAL_ENTER_MS : ENTER_MS, ease: EASE \}/);
  assert.match(variants, /duration: lateral \? LATERAL_EXIT_MS : EXIT_MS, ease: EASE_LEAVING \}/);
});
