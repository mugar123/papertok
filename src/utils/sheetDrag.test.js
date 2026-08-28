import test from 'node:test';
import assert from 'node:assert/strict';
import { sheetDragOffset, shouldSettleOpen, SHEET_DRAG_SLOP } from './sheetDrag.js';

/**
 * The two decisions a dragged sheet makes, kept out of the DOM.
 *
 * Where it sits while the finger is down, and whether it stays there when the
 * finger lifts. Both are arithmetic on a distance and a speed, and both are the
 * parts that are wrong in every bottom sheet that feels bad: a threshold that
 * ignores velocity means a fast flick does nothing, and one that ignores
 * distance means a slow deliberate pull does nothing either.
 *
 * `travel` is the full distance between the two resting states — the sheet's
 * height less the peek it peeks by. Downwards is positive, as in the DOM.
 */

const TRAVEL = 200;

test('a sheet at rest sits at its own end of the travel', () => {
  assert.equal(sheetDragOffset({ expanded: true, deltaY: 0, travel: TRAVEL }), 0);
  assert.equal(sheetDragOffset({ expanded: false, deltaY: 0, travel: TRAVEL }), TRAVEL);
});

test('it follows the finger between the two states', () => {
  assert.equal(sheetDragOffset({ expanded: true, deltaY: 60, travel: TRAVEL }), 60);
  assert.equal(sheetDragOffset({ expanded: false, deltaY: -60, travel: TRAVEL }), 140);
});

test('it cannot be dragged past either end', () => {
  // Pulling an open sheet further open, and a closed one further closed.
  assert.equal(sheetDragOffset({ expanded: true, deltaY: -80, travel: TRAVEL }), 0);
  assert.equal(sheetDragOffset({ expanded: false, deltaY: 80, travel: TRAVEL }), TRAVEL);
});

test('a slow pull past a quarter of the travel settles to the other state', () => {
  const slow = 0;
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: -51, travel: TRAVEL, velocity: slow }), true);
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: -49, travel: TRAVEL, velocity: slow }), false);

  assert.equal(shouldSettleOpen({ expanded: true, deltaY: 51, travel: TRAVEL, velocity: slow }), false);
  assert.equal(shouldSettleOpen({ expanded: true, deltaY: 49, travel: TRAVEL, velocity: slow }), true);
});

test('a flick settles it even though it barely moved', () => {
  // The gesture that a distance-only threshold gets wrong: short and fast.
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: -14, travel: TRAVEL, velocity: -0.9 }), true);
  assert.equal(shouldSettleOpen({ expanded: true, deltaY: 14, travel: TRAVEL, velocity: 0.9 }), false);
});

test('a flick still has to travel further than a tap wobbles', () => {
  // Otherwise a fast tap with a few pixels of jitter throws the sheet open.
  assert.equal(shouldSettleOpen({
    expanded: false, deltaY: -(SHEET_DRAG_SLOP - 1), travel: TRAVEL, velocity: -2,
  }), false);
});

test('speed in the wrong direction does not count', () => {
  // Dragged up, released while already moving back down: it is not a flick open.
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: -20, travel: TRAVEL, velocity: 0.9 }), false);
});

test('a pull away from the other state never toggles, however hard', () => {
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: 200, travel: TRAVEL, velocity: 3 }), false);
  assert.equal(shouldSettleOpen({ expanded: true, deltaY: -200, travel: TRAVEL, velocity: -3 }), true);
});

test('a sheet with no travel to give stays where it is', () => {
  // Measured before layout, or on a sheet shorter than its own peek.
  assert.equal(shouldSettleOpen({ expanded: false, deltaY: -400, travel: 0, velocity: -5 }), false);
  assert.equal(shouldSettleOpen({ expanded: true, deltaY: 400, travel: 0, velocity: 5 }), true);
  assert.equal(sheetDragOffset({ expanded: false, deltaY: -400, travel: 0 }), 0);
});
