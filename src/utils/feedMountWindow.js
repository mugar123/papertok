/**
 * Which cards a feed mounts right now.
 *
 * The container used to mount every paper it had the moment it appeared —
 * on a tab switch, thirty-odd PaperCards in one commit. Measured (dev build,
 * twelve cards): three long tasks of 196, 185 and 112 ms and the frame loop
 * frozen for 211 and 189 ms, which is the page transition stalling and the
 * navbar's rule stopping mid-slide. Three cards cost ~60 ms. Nothing in the
 * remaining cards is needed before the reader scrolls to them.
 *
 * So a feed mounts a window around the card it is opening on, and grows the
 * window outwards in idle chunks until every paper is in. Cards outside the
 * window are full-height placeholders, so the scroll extent and every snap
 * point are exactly what they will be once the window has grown — the scroll
 * restore lands on the right card before the card exists. Pure functions,
 * because the growth order is the thing worth pinning: outwards from the
 * anchor on both sides, never top-down past a reader who is at card twenty.
 */
export const MOUNT_WINDOW_RADIUS = 1;
export const MOUNT_WINDOW_STEP = 3;

export function initialMountWindow({ total = 0, anchorIndex = 0, radius = MOUNT_WINDOW_RADIUS } = {}) {
  if (total <= 0) return { lo: 0, hi: 0 };
  const anchor = Math.min(Math.max(0, Math.trunc(anchorIndex) || 0), total - 1);
  return { lo: Math.max(0, anchor - radius), hi: Math.min(total, anchor + radius + 1) };
}

/** The next window: `step` more cards, below first (where the reader is headed), then above. */
export function growMountWindow(window, total, step = MOUNT_WINDOW_STEP) {
  const lo = Math.max(0, window?.lo ?? 0);
  const hi = Math.min(total, window?.hi ?? 0);
  if (total <= 0) return { lo: 0, hi: 0 };
  const below = Math.min(step, total - hi);
  const above = Math.min(step - below, lo);
  return { lo: lo - above, hi: hi + below };
}

export function mountWindowCovers(window, total) {
  return total <= 0 || ((window?.lo ?? 0) <= 0 && (window?.hi ?? 0) >= total);
}

export function inMountWindow(window, index) {
  return index >= (window?.lo ?? 0) && index < (window?.hi ?? 0);
}
