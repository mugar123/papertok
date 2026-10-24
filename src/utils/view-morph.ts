import { EASE_IN_OUT } from './motion-curves.ts';

// Two sections of one window that replace each other in place (the save
// window's lists and its new-list form) cross on a strong ease-in-out over 240ms, the clock a window's
// height takes when it changes with them. A 2px blur is enough to read the
// cross as one change. `dir` is the side the arriving section comes from: 1
// forward, -1 back; the leaving one goes the other way. `axis` is 'x' for
// sideways or 'y' for up and down: a bottom sheet on a phone grows and
// shrinks vertically, so its sections cross on that axis too, forward rising
// from below. Reduced motion keeps the cross-fade only.

export const viewMorph = (reduce: boolean | null, axis = 'x') => {
  const shift = (px: number) => (axis === 'y' ? `translateY(${px}px)` : `translateX(${px}px)`);
  return {
    enter: (dir: number) => ({ opacity: 0, filter: reduce ? 'blur(0px)' : 'blur(2px)', transform: shift(reduce ? 0 : dir * 16) }),
    center: { opacity: 1, filter: 'blur(0px)', transform: shift(0), transition: { duration: 0.24, ease: EASE_IN_OUT } },
    exit: (dir: number) => ({ opacity: 0, filter: reduce ? 'blur(0px)' : 'blur(2px)', transform: shift(reduce ? 0 : dir * -16), transition: { duration: 0.18, ease: EASE_IN_OUT } }),
  };
};
