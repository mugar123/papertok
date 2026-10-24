import test from 'node:test';
import assert from 'node:assert/strict';
import { EASE_IN_OUT, EASE_OUT_EXPO, animateSize } from './motionCurves.ts';

test('animateSize travels from the measured size to the new one, and skips a change under 2px', () => {
  const calls: unknown[][] = [];
  const box = (height: number, width = 0) => ({ offsetHeight: height, offsetWidth: width, animate: (...args: unknown[]): unknown => calls.push(args) } as Pick<HTMLElement, 'offsetWidth' | 'offsetHeight' | 'animate'>);
  animateSize(box(301), 'height', 300, 240, EASE_IN_OUT);
  assert.equal(calls.length, 0, 'a 1px change does not animate');
  animateSize(box(420), 'maxHeight', 200, 420, EASE_OUT_EXPO, { overflowY: 'hidden' });
  assert.deepEqual(calls[0][0], [{ maxHeight: '200px', overflowY: 'hidden' }, { maxHeight: '420px', overflowY: 'hidden' }]);
  assert.deepEqual(calls[0][1], { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  animateSize(box(36, 112), 'width', 96, 220, EASE_IN_OUT);
  assert.deepEqual(calls[1][0], [{ width: '96px' }, { width: '112px' }], 'width travels to the new width, not the height');
});
