import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_MOTIONS, isArrivalMotion, pageMotionFor } from './pageMotion.ts';

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
