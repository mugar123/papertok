// The CSS easing tokens (styles/variables.css), for framer-motion. Keep the
// two in step; motion-curves.test.ts fails when they drift.
export const EASE_OUT = Object.freeze([0.23, 1, 0.32, 1] as const); // --ease-out
export const EASE_OUT_EXPO = Object.freeze([0.16, 1, 0.3, 1] as const); // --ease-out-expo
export const EASE_IN_OUT = Object.freeze([0.77, 0, 0.175, 1] as const); // --ease-in-out
export const EASE_DRAWER = Object.freeze([0.32, 0.72, 0, 1] as const); // --ease-drawer
export const EASE_OUT_QUAD = Object.freeze([0.25, 0.46, 0.45, 0.94] as const); // --ease-out-quad

// A box whose size `auto` cannot interpolate: it travels from the size it had
// (`from`, measured before the change) to the one it lands on, unless the two
// match. `width` travels across, any other property down. `extra` rides on
// both keyframes.
export function animateSize(element: Pick<HTMLElement, 'offsetWidth' | 'offsetHeight' | 'animate'>, property: string, from: number, duration: number, ease: readonly [number, number, number, number], extra: Keyframe = {}) {
  const to = property === 'width' ? element.offsetWidth : element.offsetHeight;
  if (Math.abs(to - from) < 2) return;
  element.animate(
    [{ [property]: `${from}px`, ...extra }, { [property]: `${to}px`, ...extra }],
    { duration, easing: `cubic-bezier(${ease.join(', ')})` },
  );
}

export function pulseIcon(svg: Element | null | undefined, on: boolean) {
  if (!svg) return;
  svg.getAnimations().forEach((running) => running.cancel());
  svg.animate(
    [
      { transform: 'scale(1)', easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      { transform: on ? 'scale(1.16)' : 'scale(0.9)', offset: 0.4, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' },
      { transform: 'scale(1)' },
    ],
    { duration: 260 },
  );
}
