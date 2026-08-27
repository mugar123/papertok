/**
 * Scrolling an element on the same clock as a CSS transition.
 *
 * `scrollTo({ behavior: 'smooth' })` is the obvious way to slide a panel back
 * to its first line, and it is the wrong one whenever something else is
 * animating alongside: its duration and its easing belong to the browser, not
 * to us. Collapsing the abstract moves two things at once — the panel's height,
 * on `cubic-bezier(0.16, 1, 0.3, 1)` over 420ms, and the text inside it — and
 * with the native scroll those two finish at different moments on a curve that
 * does not match. The eye reads that as one motion dragging behind the other.
 *
 * So the scroll is driven here instead, off the same curve and the same
 * duration, and the two land together.
 */

/** The card's easing, as used across `PaperCard.css`. */
export const CARD_EASE = Object.freeze([0.16, 1, 0.3, 1]);

/** And its duration, in milliseconds. Kept in step with the CSS by hand. */
export const CARD_DURATION_MS = 420;

/**
 * A cubic-bézier solver, the same shape CSS uses: the curve is defined by two
 * control points and animates y against a *time* x, so the y for a given
 * progress needs x solved first.
 *
 * Newton-Raphson converges in a handful of steps over this range; the bisection
 * fallback covers the flat stretches where the derivative is too small to
 * trust, which is exactly where a curve like `0.16, 1, 0.3, 1` spends its tail.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const curve = (a, b, t) => {
    const c = 3 * a;
    const B = 3 * (b - a) - c;
    const A = 1 - c - B;
    return ((A * t + B) * t + c) * t;
  };
  const slope = (a, b, t) => {
    const c = 3 * a;
    const B = 3 * (b - a) - c;
    const A = 1 - c - B;
    return (3 * A * t + 2 * B) * t + c;
  };

  return (progress) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;

    let t = progress;
    for (let i = 0; i < 8; i += 1) {
      const error = curve(x1, x2, t) - progress;
      if (Math.abs(error) < 1e-6) return curve(y1, y2, t);
      const d = slope(x1, x2, t);
      if (Math.abs(d) < 1e-6) break;
      t -= error / d;
    }

    let low = 0;
    let high = 1;
    t = progress;
    for (let i = 0; i < 24; i += 1) {
      const x = curve(x1, x2, t);
      if (Math.abs(x - progress) < 1e-6) break;
      if (x > progress) high = t;
      else low = t;
      t = (low + high) / 2;
    }
    return curve(y1, y2, t);
  };
}

/**
 * Slides `node.scrollTop` to `to`, and returns a function that stops it.
 *
 * Stopping matters more than it looks: tapping the abstract twice quickly used
 * to leave the native scroll still running into a panel that had already
 * reopened, which walked the text while the reader was trying to read it. The
 * caller cancels the previous run before starting anything new.
 *
 * `now` and `raf` are injectable so the tween can be tested without a browser
 * and without waiting real seconds for it.
 */
export function tweenScrollTop(node, to, options = {}) {
  const {
    durationMs = CARD_DURATION_MS,
    easing = cubicBezier(...CARD_EASE),
    immediate = false,
    now = () => Date.now(),
    raf = (callback) => globalThis.requestAnimationFrame?.(callback),
    cancelRaf = (handle) => globalThis.cancelAnimationFrame?.(handle),
  } = options;

  if (!node) return () => {};

  const from = node.scrollTop;
  const distance = to - from;
  // Nothing to do, and no frame worth burning: the reader is already there, or
  // reduced motion asked for the destination without the journey.
  if (immediate || durationMs <= 0 || Math.abs(distance) < 1) {
    node.scrollTop = to;
    return () => {};
  }

  const startedAt = now();
  let handle = null;
  let stopped = false;

  const step = () => {
    if (stopped) return;
    const elapsed = now() - startedAt;
    const progress = Math.min(1, elapsed / durationMs);
    node.scrollTop = from + distance * easing(progress);
    if (progress < 1) handle = raf(step);
  };

  handle = raf(step);

  return () => {
    stopped = true;
    if (handle != null) cancelRaf(handle);
  };
}
