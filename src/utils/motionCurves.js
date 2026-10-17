// The CSS easing tokens (styles/variables.css), for framer-motion. Keep the
// two in step; motionCurves.test.js fails when they drift.
export const EASE_OUT = Object.freeze([0.23, 1, 0.32, 1]); // --ease-out
export const EASE_OUT_EXPO = Object.freeze([0.16, 1, 0.3, 1]); // --ease-out-expo
export const EASE_IN_OUT = Object.freeze([0.77, 0, 0.175, 1]); // --ease-in-out

// A box whose size `auto` cannot interpolate: it travels from the size it had
// (`from`, measured before the change) to the one it lands on, unless the two
// match. `extra` rides on both keyframes.
export function animateSize(element, property, from, duration, ease, extra = {}) {
  const to = element.offsetHeight;
  if (Math.abs(to - from) < 2) return;
  element.animate(
    [{ [property]: `${from}px`, ...extra }, { [property]: `${to}px`, ...extra }],
    { duration, easing: `cubic-bezier(${ease.join(', ')})` },
  );
}
