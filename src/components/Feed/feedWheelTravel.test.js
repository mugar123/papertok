import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WHEEL_GESTURE_IDLE_MS, WHEEL_STEP_MIN_DELTA_PX } from '../../utils/feedWheelStep.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function block(code, from, to, label) {
  const start = code.indexOf(from);
  assert.ok(start >= 0, `expected to have found ${label}`);
  const end = code.indexOf(to, start + from.length);
  assert.ok(end > start, `expected to have found the end of ${label}`);
  return code.slice(start, end);
}

/**
 * The line this change must not cross. A finger keeps the native scroll, its
 * inertia, its mandatory snap and the pull-to-refresh built on all three: the
 * reason there is a custom travel at all is a mouse wheel that cannot move a
 * 757px card and a snap landing whose curve CSS cannot reach, and neither is
 * a problem touch has.
 */
test('SOURCE: touch never comes through the wheel travel', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const effect = block(code, "container.addEventListener('wheel'", '}, [feedNode', 'the wheel effect');
  const whole = code.slice(code.indexOf('const onWheel = (event) =>') - 600, code.indexOf("container.addEventListener('wheel'"));

  assert.match(whole, /matchMedia\('\(pointer: fine\)'\)\.matches/,
    'the listener is only attached on a fine pointer');
  assert.match(whole, /if \(!window\.matchMedia\('\(pointer: fine\)'\)\.matches\) return undefined;/,
    'and a coarse pointer leaves before anything is attached');
  assert.equal(effect.includes('touch'), false, 'no touch event goes near this');
});

/**
 * Owning a gesture means preventing it, which a passive listener cannot do —
 * and the node is what the listener hangs off, not a ref read on the first
 * commit: a mount that begins in the skeleton (the guest feed always does)
 * would read null and never run again once the papers arrived. The hover band
 * in this same file learned that the expensive way.
 */
test('SOURCE: the wheel listener is non-passive and hangs off the live node', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));

  assert.match(code, /container\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/,
    'preventDefault needs a non-passive listener');
  assert.match(code, /container\.removeEventListener\('wheel', onWheel\)/, 'and it is taken off again');

  const effect = block(code, 'const container = feedNode;', "container.addEventListener('wheel'", 'the wheel effect head');
  assert.equal(effect.includes('feedRef.current'), false, 'the node, not a ref read at first commit');
});

/**
 * The tail is the trap. A flick keeps arriving for hundreds of milliseconds
 * after the fingers have gone, so those events must (a) be prevented, or they
 * move scrollTop underneath the travel, and (b) still reach the reducer, or
 * the moment the travel ends they read as a fresh flick and skip a paper.
 */
test('SOURCE: every event we own is prevented and fed to the reducer', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const handler = block(code, 'const onWheel = (event) => {', '\n    };', 'onWheel');

  const preventAt = handler.indexOf('event.preventDefault()');
  const reduceAt = handler.indexOf('wheelStep(wheelGestureRef.current, event)');
  const bailAt = handler.indexOf('if (step === 0) return;');

  assert.ok(preventAt > 0 && reduceAt > preventAt,
    'prevent first, then reduce: a return before preventDefault leaves the tail to the native scroll');
  assert.ok(bailAt > reduceAt, 'the gesture is updated before a spent step returns');
  assert.match(handler, /wheelGestureRef\.current = gesture;/, 'the reducer state is carried forward');
});

/** Three other meanings of a wheel over this element, all of them not ours. */
test('SOURCE: the handler lets pinch, sideways and card scrollers through', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const handler = block(code, 'const onWheel = (event) => {', 'event.preventDefault()', 'onWheel guards');

  assert.match(handler, /if \(!wheelEventIsOurs\(event\)\) return;/, 'pinch zoom and sideways gestures');
  assert.match(handler, /PULL_BLOCKING_SCROLLERS/, 'a scroller of the card\'s own answers its own wheel');
  assert.match(handler, /\[aria-modal="true"\]/, 'an open sheet or modal owns the wheel');
});

/**
 * The reason this exists: the landing. If the travel handed the curve back to
 * the browser there would have been nothing to gain by taking the gesture.
 */
test('SOURCE: the travel is curved by us, on the quad, not by the engine', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const travel = block(code, 'const travelToIndex = useCallback(', '}, [prefersReducedMotion]);', 'travelToIndex');

  assert.match(travel, /1 - \(1 - t\) \* \(1 - t\)/,
    'the true quad, which --ease-out-quad approximates in bezier');
  assert.equal(travel.includes("behavior: 'smooth'"), false,
    'a native smooth scroll is the engine\'s curve again');
  assert.equal(travel.includes('cubic-bezier'), false, 'no second curve to disagree with the first');
  assert.match(travel, /requestAnimationFrame\(step\)/, 'driven per frame');
});

/**
 * Mandatory snap re-resolves an animated scrollTop to the nearest snap point
 * every frame, which stutters the travel and can teleport it. It has to come
 * off for the duration and go back on at the end — and the end is a frame
 * where scrollTop sits exactly on a snap point, so restoring it cannot be
 * seen. Restoring the saved string (empty, in practice) is what hands the
 * property back to the stylesheet instead of pinning an inline value.
 */
test('SOURCE: snap comes off for the travel and goes back on after it', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const travel = block(code, 'const travelToIndex = useCallback(', '}, [prefersReducedMotion]);', 'travelToIndex');

  assert.match(travel, /const snapType = container\.style\.scrollSnapType;/, 'the previous value is saved');
  assert.match(travel, /container\.style\.scrollSnapType = 'none';/, 'off for the travel');
  assert.match(travel, /container\.style\.scrollSnapType = snapType;/, 'and handed back, not hardcoded');

  const restoreAt = travel.indexOf('container.style.scrollSnapType = snapType;');
  const landAt = travel.indexOf('container.scrollTop = targetTop;\n      container.style.scrollSnapType');
  assert.ok(landAt >= 0 && landAt < restoreAt,
    'the exact landing is written BEFORE snap returns, so snap has nothing to correct');
});

/**
 * A second flick mid-flight has to count off the destination. Read live,
 * `Math.round(scrollTop / cardHeight)` answers the destination once the
 * travel is past halfway and the origin before it, so the same flick would
 * advance a card or vanish depending on when in the 380ms it landed.
 */
test('SOURCE: a step in flight counts from the destination', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const step = block(code, 'const stepTarget = useCallback(', '}, [loading, papers.length, showEndCard]);', 'stepTarget');

  assert.match(step, /travelTargetRef\.current \?\? Math\.round\(container\.scrollTop \/ cardHeight\)/,
    'the destination wins while there is one');
  assert.match(step, /next >= 0 && next < itemCount \? next : null/, 'and the ends of the feed are respected');

  const travel = block(code, 'const travelToIndex = useCallback(', '}, [prefersReducedMotion]);', 'travelToIndex');
  assert.match(travel, /travelTargetRef\.current = index;/, 'set on the way out');
  assert.match(travel, /travelTargetRef\.current = null;/, 'and cleared when the feed is at rest again');
});

/** One travel, two devices: the arrows must not keep a curve of their own. */
test('SOURCE: the arrow keys travel the same way the wheel does', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  const keys = block(code, "if (e.key === 'ArrowDown' || e.key === 'ArrowUp')", 'window.addEventListener(\'keydown\'', 'the arrow handler');

  assert.match(keys, /travelToIndex\(container, target\)/, 'the arrows go through the shared travel');
  assert.equal(keys.includes("behavior: 'smooth'"), false, 'and no longer ask the engine for a curve');
  assert.match(keys, /if \(isScrollingRef\.current\) return;/,
    'a held arrow repeats about thirty times a second and must not chain the way a flick does');
});

/**
 * A travel cut short by an unmount would leave snap switched off on a node on
 * its way out, with the next frame still writing scrollTop onto it.
 */
test('SOURCE: a travel in flight is cancelled on unmount', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  assert.match(code, /useEffect\(\(\) => \(\) => cancelAnimationFrame\(travelFrameRef\.current\), \[\]\);/,
    'the frame is released when the feed goes away');
});

test('the gesture rule is tuned for a hand, not for a harness', () => {
  assert.ok(WHEEL_GESTURE_IDLE_MS > 16 * 4,
    'a real flick arrives at the display rhythm; the window has to clear it by a margin');
  assert.ok(WHEEL_GESTURE_IDLE_MS <= 200, 'past this, two deliberate flicks read as one');
  assert.ok(WHEEL_STEP_MIN_DELTA_PX >= 12 && WHEEL_STEP_MIN_DELTA_PX <= 20,
    'the floor has to clear a resting hand and still sit inside the opening ramp of a flick');
});
