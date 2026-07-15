import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulateWheelGesture,
  shouldClampTrackpadMomentum,
  shouldUseNativeWheelScroll,
} from './wheelNavigation.js';

test('uses native scrolling for pixel-precise trackpad gestures', () => {
  assert.equal(shouldUseNativeWheelScroll(0), true);
  assert.equal(shouldUseNativeWheelScroll(1), false);
  assert.equal(shouldUseNativeWheelScroll(2), false);
});

test('clamps only fast trackpad momentum bursts', () => {
  assert.equal(shouldClampTrackpadMomentum(79), false);
  assert.equal(shouldClampTrackpadMomentum(-79), false);
  assert.equal(shouldClampTrackpadMomentum(80), true);
  assert.equal(shouldClampTrackpadMomentum(-120), true);
});

test('does not navigate on small trackpad movements', () => {
  const first = accumulateWheelGesture(0, 12);
  const second = accumulateWheelGesture(first.accumulatedDelta, 18);

  assert.equal(first.direction, 0);
  assert.equal(second.direction, 0);
  assert.equal(second.accumulatedDelta, 30);
});

test('navigates once after a deliberate accumulated gesture', () => {
  const first = accumulateWheelGesture(0, 55);
  const second = accumulateWheelGesture(first.accumulatedDelta, 60);

  assert.equal(second.direction, 1);
  assert.equal(second.accumulatedDelta, 0);
});

test('resets accumulated movement when gesture direction changes', () => {
  const result = accumulateWheelGesture(80, -45);

  assert.equal(result.direction, 0);
  assert.equal(result.accumulatedDelta, -45);
});
