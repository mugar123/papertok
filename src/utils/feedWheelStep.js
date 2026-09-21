/**
 * The wheel and the trackpad, on desktop, turned into card steps.
 *
 * Until now this input was entirely native, and the whole movement was
 * governed by `scroll-snap-type: y mandatory` plus `scroll-snap-stop: always`
 * (FeedContainer.css). That law is right — one gesture, one paper — but as
 * the only mechanism it has two edges a reader feels:
 *
 *   1. A mouse wheel cannot use it. One notch is about 100px and a card is
 *      about 757px tall, so a notch travels an eighth of the way and the snap
 *      pulls it straight back: `scrollTop` measures 0 -> 0 -> 0 and the feed
 *      reads as stuck. The reader has to spin the wheel to go anywhere.
 *   2. The landing is the browser's. A native snap is timed and curved by the
 *      engine, and `scroll-behavior` does not reach it — that property only
 *      affects programmatic scrolling. So there is no CSS lever for how the
 *      card settles: to touch that at all, we have to be the ones moving the
 *      scroller.
 *
 * So this module answers one question, and it is deliberately the only
 * question it answers: given a stream of `wheel` events, when does the reader
 * mean "next paper"? The travel itself belongs to the caller.
 *
 * Touch is NOT routed through here. A finger keeps the native scroll, its
 * inertia and its snap, and keeps the pull-to-refresh built on top of them
 * (utils/feedPullToRefresh.js). This is `pointer: fine` only.
 *
 * ## One gesture, one paper
 *
 * The rule is the one the snap already enforced, and the reason it cannot be
 * done by counting distance is that the two devices that produce these events
 * have nothing in common. One flick of a trackpad is dozens of events over a
 * few hundred milliseconds, ramping up and then decaying through a momentum
 * tail the OS keeps sending after the fingers have gone; one notch of a mouse
 * wheel is a single event. Distance tells them apart badly — the flick's
 * total is thousands of pixels and the notch's is a hundred — but *time*
 * tells them apart exactly: both are one burst with silence around it.
 *
 * So a gesture is a burst of events with no gap longer than
 * `WHEEL_GESTURE_IDLE_MS` in it, and it spends exactly one step. Everything
 * after that in the same burst, tail included, returns 0. This is why the
 * caller must keep feeding events to the reducer even while its own scroll
 * animation is running: the tail of the flick that started the animation has
 * to land on a gesture that is already spent, or it would be read as a fresh
 * flick the moment the animation ended and skip a paper.
 */

/**
 * Below this, a delta is not a scroll.
 *
 * A trackpad reports a resting hand and the death of a momentum tail as a
 * stream of one- and two-pixel deltas, and a gesture does not begin at full
 * delta either — the measured opening of a flick on this project is 3, 8, 18,
 * so the floor also decides WHICH event of the ramp is the one that moves.
 * 12px puts that on the third, about 32ms in, which is as soon as the
 * movement is unambiguous and still inside the same frame budget a native
 * snap would have used to make up its mind.
 */
export const WHEEL_STEP_MIN_DELTA_PX = 12;

/**
 * The silence that ends a gesture.
 *
 * On real hardware a physical flick arrives at the display's rhythm, roughly
 * every 16ms, and its momentum tail keeps that up until it dies, so any real
 * gap is the reader stopping. 140ms is comfortably above that rhythm and
 * still below the pause between two deliberate flicks. It is deliberately
 * generous in one direction: reading a stutter as a second gesture skips a
 * paper the reader never asked for, which is much worse than reading two very
 * fast flicks as one.
 *
 * Do not try to confirm this number with synthetic wheels over CDP. Measured
 * on this project, `Input.dispatchMouseEvent` has a median of 34ms between
 * events and gaps over 120ms inside what the driving loop calls one gesture:
 * against that harness any idle window looks broken. The honest guardian is a
 * node test over a 16ms trace, which is what feedWheelStep.test.js is.
 */
export const WHEEL_GESTURE_IDLE_MS = 140;

/** `DOM_DELTA_LINE` in pixels. Firefox reports lines, not pixels. */
export const WHEEL_LINE_PX = 40;
/** `DOM_DELTA_PAGE` in pixels. Only the sign of it is ever load-bearing. */
export const WHEEL_PAGE_PX = 400;

/** A wheel delta in pixels, whatever unit the browser chose to send. */
export function normalizeWheelDelta({ deltaY = 0, deltaMode = 0 } = {}) {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * WHEEL_PAGE_PX;
  return deltaY;
}

/**
 * Whether a wheel event means the feed at all.
 *
 * `ctrlKey` is a pinch zoom, which browsers deliver as a wheel and which must
 * keep working. A gesture more sideways than vertical is not this feed's axis
 * — the reader is on a horizontal trackpad swipe, or holding shift. And an
 * event with no delta in either axis has nothing to say.
 */
export function wheelEventIsOurs({ deltaY = 0, deltaX = 0, ctrlKey = false } = {}) {
  if (ctrlKey) return false;
  if (deltaY === 0 && deltaX === 0) return false;
  return Math.abs(deltaY) > Math.abs(deltaX);
}

/**
 * `lastAt` is when this gesture was last heard from; `direction` is the step
 * it has already spent (0 while it still owes one).
 */
export function initialWheelGesture() {
  return { lastAt: null, direction: 0 };
}

/**
 * One event in, at most one step out: -1 for the paper above, +1 for the one
 * below, 0 for "this event is part of a gesture that has already been
 * answered".
 *
 * Every event updates `lastAt`, including the ones under the floor: a tremor
 * is still the reader's hand on the trackpad, so it keeps the gesture alive
 * without being able to spend it. What it cannot do is arm a new one.
 */
export function wheelStep(gesture, event) {
  const state = gesture || initialWheelGesture();
  const timeStamp = Number.isFinite(event?.timeStamp) ? event.timeStamp : 0;
  const px = normalizeWheelDelta(event);

  const opensGesture = state.lastAt === null || timeStamp - state.lastAt > WHEEL_GESTURE_IDLE_MS;
  let direction = opensGesture ? 0 : state.direction;

  if (Math.abs(px) < WHEEL_STEP_MIN_DELTA_PX) {
    return { gesture: { lastAt: timeStamp, direction }, step: 0 };
  }

  const step = px > 0 ? 1 : -1;
  // A reversal is a decision and does not wait out the idle window; a sign
  // flip under the floor never reaches here, so momentum cannot fake one.
  if (direction === step) {
    return { gesture: { lastAt: timeStamp, direction }, step: 0 };
  }

  direction = step;
  return { gesture: { lastAt: timeStamp, direction }, step };
}
