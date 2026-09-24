import { SWIPE_DURATIONS, T } from "./timeline.ts";

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export const progress = (frame: number, start: number, duration: number): number =>
  clamp01((frame - start) / duration);

export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeInCubic = (t: number): number => t ** 3;
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
export const easeOutQuint = (t: number): number => 1 - (1 - t) ** 5;

// Gentle overshoot for landings; `s` controls how far past 1 it goes.
export const easeOutBack = (t: number, s = 1.2): number =>
  t <= 0 ? 0 : t >= 1 ? 1 : 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Soft entrance used by every text element: rise, unblur, fade in.
export const rise = (
  frame: number,
  at: number,
  { duration = 22, distance = 22, blur = 10 } = {}
): { opacity: number; y: number; blur: number } => {
  const p = easeOutCubic(progress(frame, at, duration));
  return { opacity: p, y: (1 - p) * distance, blur: (1 - p) * blur };
};

// Position along the feed: 0 is the first paper, n is the (n+1)th, with
// fractional values mid-swipe.
export const trackPosition = (frame: number): number => {
  let position = 0;
  T.swipes.forEach((start, i) => {
    const t = progress(frame, start, SWIPE_DURATIONS[i]);
    const last = i === T.swipes.length - 1;
    position += last ? easeOutBack(t, 0.9) : easeInOutCubic(t);
  });
  return position;
};

// Deterministic PRNG so the flood looks identical on every render.
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
