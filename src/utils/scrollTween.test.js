import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_DURATION_MS, CARD_EASE, cubicBezier, tweenScrollTop } from './scrollTween.js';

/** A stand-in for the abstract: the tween only ever touches `scrollTop`. */
function node(scrollTop = 0) {
  return { scrollTop };
}

/**
 * A hand-cranked clock and frame loop. Real `requestAnimationFrame` would make
 * these tests wait out the animation and, worse, make them flaky on a busy
 * machine — the whole point of injecting both is that a tween is a pure
 * function of elapsed time.
 */
function clock() {
  let time = 0;
  const queue = [];
  return {
    now: () => time,
    raf: (callback) => queue.push(callback),
    cancelRaf: () => {},
    advance(ms) {
      time += ms;
      const pending = queue.splice(0, queue.length);
      pending.forEach(callback => callback());
    },
  };
}

test('the easing starts at 0, ends at 1 and never turns back', () => {
  const ease = cubicBezier(...CARD_EASE);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);

  let previous = 0;
  for (let i = 1; i <= 40; i += 1) {
    const value = ease(i / 40);
    assert.ok(value >= previous, `monotonic at ${i}/40: ${value} < ${previous}`);
    previous = value;
  }
});

test('the curve front-loads, which is what makes it read as a settle', () => {
  const ease = cubicBezier(...CARD_EASE);
  // `0.16, 1, 0.3, 1` is a decelerating curve: a quarter of the time should
  // already have covered well over half the distance. A linear ramp would put
  // 0.25 here, and the difference is the whole character of the motion.
  assert.ok(ease(0.25) > 0.6, `quarter of the way: ${ease(0.25)}`);
  assert.ok(ease(0.5) > 0.85, `half way: ${ease(0.5)}`);
});

test('a linear curve is reproduced exactly, so the solver itself is sound', () => {
  const linear = cubicBezier(0.25, 0.25, 0.75, 0.75);
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(linear(p) - p) < 1e-3, `linear(${p}) = ${linear(p)}`);
  }
});

test('the scroll lands exactly on its target when the clock runs out', () => {
  const timer = clock();
  const element = node(188);
  tweenScrollTop(element, 0, { now: timer.now, raf: timer.raf, cancelRaf: timer.cancelRaf });

  timer.advance(CARD_DURATION_MS / 2);
  assert.ok(element.scrollTop < 188, 'it has started moving');
  assert.ok(element.scrollTop > 0, 'and has not jumped to the end');

  timer.advance(CARD_DURATION_MS);
  assert.equal(element.scrollTop, 0, 'it finishes on the destination, not near it');
});

test('reduced motion gets the destination and no frames at all', () => {
  const timer = clock();
  const element = node(188);
  let framesAsked = 0;
  tweenScrollTop(element, 0, {
    immediate: true,
    now: timer.now,
    raf: (callback) => { framesAsked += 1; return timer.raf(callback); },
    cancelRaf: timer.cancelRaf,
  });

  assert.equal(element.scrollTop, 0);
  assert.equal(framesAsked, 0, 'no animation frame is requested');
});

test('cancelling stops it where it stands, for the reader who taps twice', () => {
  const timer = clock();
  const element = node(200);
  const stop = tweenScrollTop(element, 0, { now: timer.now, raf: timer.raf, cancelRaf: timer.cancelRaf });

  timer.advance(CARD_DURATION_MS / 4);
  const whenStopped = element.scrollTop;
  stop();

  timer.advance(CARD_DURATION_MS);
  assert.equal(element.scrollTop, whenStopped, 'no frame ran after the cancel');
});

test('a scroll that is already there does not schedule a frame', () => {
  const timer = clock();
  const element = node(0);
  let framesAsked = 0;
  tweenScrollTop(element, 0, {
    now: timer.now,
    raf: (callback) => { framesAsked += 1; return timer.raf(callback); },
    cancelRaf: timer.cancelRaf,
  });
  assert.equal(framesAsked, 0);
});

test('a missing node is survivable, and hands back a no-op', () => {
  const stop = tweenScrollTop(null, 0);
  assert.equal(typeof stop, 'function');
  stop();
});
