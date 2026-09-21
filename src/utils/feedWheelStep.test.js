import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WHEEL_GESTURE_IDLE_MS,
  WHEEL_LINE_PX,
  WHEEL_PAGE_PX,
  WHEEL_STEP_MIN_DELTA_PX,
  initialWheelGesture,
  normalizeWheelDelta,
  wheelEventIsOurs,
  wheelStep,
} from './feedWheelStep.js';

/** Feeds a trace through the reducer and returns every step it produced. */
function run(trace, gesture = initialWheelGesture()) {
  const steps = [];
  let state = gesture;
  for (const event of trace) {
    const result = wheelStep(state, event);
    state = result.gesture;
    if (result.step !== 0) steps.push(result.step);
  }
  return { steps, state };
}

/**
 * One physical flick of a trackpad, at the display's own rhythm. The ramp is
 * the one measured on this project (papertok-feed-scroll-measure-traps): a
 * gesture does not begin at full delta, it climbs into it, and the first two
 * or three events are below anything a reader would call a scroll.
 */
function flick({ from = 0, sign = 1, intervalMs = 16 } = {}) {
  const ramp = [3, 8, 18, 40, 78, 130, 178, 200];
  const trace = [];
  let at = from;
  for (const delta of ramp) {
    trace.push({ deltaY: delta * sign, timeStamp: at });
    at += intervalMs;
  }
  // The momentum tail the OS keeps sending after the fingers have left.
  let tail = 200;
  while (tail > 0.5) {
    tail *= 0.94;
    trace.push({ deltaY: tail * sign, timeStamp: at });
    at += intervalMs;
  }
  return { trace, lastAt: trace[trace.length - 1].timeStamp };
}

test('normalizeWheelDelta speaks one unit: pixels', () => {
  assert.equal(normalizeWheelDelta({ deltaY: 120, deltaMode: 0 }), 120);
  assert.equal(normalizeWheelDelta({ deltaY: 120 }), 120, 'a missing deltaMode is pixels');
  assert.equal(normalizeWheelDelta({ deltaY: 3, deltaMode: 1 }), 3 * WHEEL_LINE_PX);
  assert.equal(normalizeWheelDelta({ deltaY: -1, deltaMode: 2 }), -WHEEL_PAGE_PX);
});

test('one flick of the trackpad is one paper', () => {
  const { steps } = run(flick().trace);
  assert.deepEqual(steps, [1], 'the ramp and its whole momentum tail spend one step');
});

test('the ramp spends its step as soon as the gesture is a scroll, not on the tremor', () => {
  const trace = flick().trace;
  const first = wheelStep(initialWheelGesture(), trace[0]);
  assert.equal(first.step, 0, `a ${trace[0].deltaY}px opening move is under the ${WHEEL_STEP_MIN_DELTA_PX}px floor`);
  const second = wheelStep(first.gesture, trace[1]);
  assert.equal(second.step, 0);
  const third = wheelStep(second.gesture, trace[2]);
  assert.equal(third.step, 1, 'the third event crosses the floor and is the one that moves');
});

test('two flicks with a real pause between them are two papers', () => {
  const first = flick();
  const second = flick({ from: first.lastAt + WHEEL_GESTURE_IDLE_MS + 1 });
  const { steps } = run([...first.trace, ...second.trace]);
  assert.deepEqual(steps, [1, 1]);
});

test('a gap shorter than the idle window is still the same gesture', () => {
  const first = flick();
  const second = flick({ from: first.lastAt + WHEEL_GESTURE_IDLE_MS });
  const { steps } = run([...first.trace, ...second.trace]);
  assert.deepEqual(steps, [1], 'the feed must not skip a paper on a stutter inside one flick');
});

test('a resting finger never moves the feed', () => {
  const trace = [];
  for (let i = 0; i < 40; i += 1) {
    trace.push({ deltaY: (i % 2 === 0 ? 1 : -1) * (WHEEL_STEP_MIN_DELTA_PX - 1), timeStamp: i * 16 });
  }
  assert.deepEqual(run(trace).steps, [], 'every delta is under the floor, in both directions');
});

test('a mouse wheel notch moves exactly one paper', () => {
  // The case the native mandatory snap cannot serve at all: one notch is
  // ~100px and a card is ~757px tall, so the reader had to spin the wheel.
  const trace = [
    { deltaY: 100, timeStamp: 0 },
    { deltaY: 100, timeStamp: 300 },
    { deltaY: 100, timeStamp: 600 },
  ];
  assert.deepEqual(run(trace).steps, [1, 1, 1]);
});

test('a notch upwards asks for the paper above', () => {
  assert.deepEqual(run([{ deltaY: -100, timeStamp: 0 }]).steps, [-1]);
});

test('a reversal inside one gesture is a new intent', () => {
  const trace = [
    { deltaY: 200, timeStamp: 0 },
    { deltaY: 180, timeStamp: 16 },
    { deltaY: -200, timeStamp: 32 },
  ];
  assert.deepEqual(run(trace).steps, [1, -1], 'changing your mind must not wait out the idle window');
});

test('a tail that flips sign does not count as a reversal', () => {
  const trace = [
    { deltaY: 200, timeStamp: 0 },
    { deltaY: -(WHEEL_STEP_MIN_DELTA_PX - 1), timeStamp: 16 },
    { deltaY: -4, timeStamp: 32 },
  ];
  assert.deepEqual(run(trace).steps, [1], 'a sign flip under the floor is momentum, not a decision');
});

test('wheelEventIsOurs leaves every other meaning of a wheel alone', () => {
  const plain = { deltaY: 100, deltaX: 0, ctrlKey: false };
  assert.equal(wheelEventIsOurs(plain), true);
  assert.equal(wheelEventIsOurs({ ...plain, ctrlKey: true }), false, 'ctrl+wheel is a pinch zoom');
  assert.equal(wheelEventIsOurs({ ...plain, deltaX: -140 }), false, 'a sideways gesture is not the feed');
  assert.equal(wheelEventIsOurs({ deltaY: 0, deltaX: 0 }), false, 'nothing to do with no delta');
  assert.equal(wheelEventIsOurs({ ...plain, deltaX: 40 }), true, 'a little sideways drift is still a scroll down');
});
