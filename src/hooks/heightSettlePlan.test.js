import test from 'node:test';
import assert from 'node:assert/strict';
import { depsAreSame, planHeightSettle } from './heightSettlePlan.js';

/**
 * The hero body's settle used to keep its memory only on the commits whose
 * deps changed. Every height change without a dep — the Wikipedia toggle
 * mounting a frame after the paragraph, the reader folding the experience
 * panel — left the memory behind, and the next dep animated the box from a
 * height it had already left: measured on a topic page, the list jumped 27px
 * up and slid back down 1.4s after the paragraph had landed.
 */
test('the first commit only remembers', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: null, depsChanged: true, running: null, current: null, natural: 226 }),
    { action: 'none', remember: 226 },
  );
});

test('a declared change animates from the remembered height to the natural one', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 237.9, depsChanged: true, running: null, current: null, natural: 479.3 }),
    { action: 'animate', from: 237.9, to: 479.3, remember: 479.3 },
  );
});

test('a change too small to see is not animated', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 226, depsChanged: true, running: null, current: null, natural: 226.6 }),
    { action: 'none', remember: 226.6 },
  );
});

test('a commit without a declared change re-syncs the memory instead of animating', () => {
  // The reader folded the panel: the box is at 243 and nothing declared it.
  assert.deepEqual(
    planHeightSettle({ remembered: 216.4, depsChanged: false, running: null, current: null, natural: 243.4 }),
    { action: 'none', remember: 243.4 },
  );
});

test('a settle in flight whose target moved is re-aimed from where the box is', () => {
  // Measured: Wikipedia lands (146 → 216.4), the toggle mounts a frame later
  // and the natural height is 243.4. Without this the box eased to 216.4 and
  // snapped +27px the frame the settle let go.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 17 }, current: 146.3, natural: 243.4 }),
    { action: 'animate', from: 146.3, to: 243.4, remember: 243.4 },
  );
});

test('a settle in flight whose target did not move resumes on its own clock', () => {
  // A row chunk mounted under the list mid-settle: nothing about the hero
  // changed, so the same keyframes carry on from the same instant.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 200 }, current: 205, natural: 216.4 }),
    { action: 'resume', from: 146, to: 216.4, currentTime: 200, remember: 216.4 },
  );
});

test('depsAreSame compares position by position with Object.is', () => {
  assert.equal(depsAreSame(null, [1]), false);
  assert.equal(depsAreSame([1, 'a', null], [1, 'a', null]), true);
  assert.equal(depsAreSame([1, 'a'], [1, 'b']), false);
  assert.equal(depsAreSame([NaN], [NaN]), true);
  assert.equal(depsAreSame([1], [1, 2]), false);
});
