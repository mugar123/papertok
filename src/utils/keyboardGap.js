/**
 * How far `.rd-bar` must lift off the layout viewport's bottom edge to clear
 * whatever now separates it from the visual viewport's bottom.
 *
 * That "whatever" is deliberately not named "the keyboard" in here: the
 * on-screen keyboard is the case this exists for, but the arithmetic cannot
 * tell a keyboard apart from a momentary mismatch between the two viewports —
 * an address-bar transition, a pinch-zoom, anything that shrinks the visual
 * viewport relative to the layout one. The caller decides when this number is
 * trustworthy (only while composing a note, on this component); this
 * function only computes it.
 *
 * `innerHeight` is the layout viewport's own bottom edge — the one
 * `position: fixed` measures against, and the one that keeps reporting the
 * full height regardless of the keyboard. `viewportOffsetTop +
 * viewportHeight` is the visual viewport's bottom edge in the same
 * (layout-viewport) coordinate space. The difference between the two is
 * exactly how much of the layout viewport's bottom is currently out of
 * view — and how far the bar must rise to clear it.
 *
 * Clamped at zero: a negative result is not "the bar can drop below its
 * resting position," it is rounding noise around the steady state, and
 * treating it as real would tug the bar downward for no visible reason.
 */
export function measureKeyboardGap({ innerHeight, viewportHeight, viewportOffsetTop }) {
  const gap = innerHeight - (viewportHeight + viewportOffsetTop);
  return gap > 0 ? gap : 0;
}
