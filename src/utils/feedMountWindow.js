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
/**
 * Coming back is the case that hurts. Measured on the production build with
 * the CPU at a quarter speed (390×844, `open` probe, back from an author):
 * the three cards of a resumed window were one 222 ms task the frame the feed
 * mounted — a blank beat between the page leaving and the feed arriving — and
 * the first growth, three more cards, was a 211 ms task that landed inside the
 * entrance and froze it. A resumed feed now mounts the card it was left on and
 * nothing else (`MOUNT_WINDOW_RESUME_RADIUS`), grows by two, and waits out the
 * page transition before the first growth (`MOUNT_WINDOW_SETTLE_MS`, the
 * entrance's 300 ms and a beat). A fresh feed keeps its neighbour: it opens
 * under the veil, with no transition to protect.
 */
export const MOUNT_WINDOW_RESUME_RADIUS = 0;
export const MOUNT_WINDOW_STEP = 2;
export const MOUNT_WINDOW_SETTLE_MS = 400;
/** How long an idle callback may be put off before it runs regardless. */
export const MOUNT_WINDOW_IDLE_TIMEOUT_MS = 600;

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

/**
 * Where a feed resumes: the index of the paper the reader was on, looked up
 * by identity in the papers it has now, and only then the index it saved.
 *
 * The restore used to be a pixel offset alone, which is an index in disguise
 * — and an index is only as good as the order it was taken from. Come back
 * to Following after a while and the order may have moved (papers marked seen
 * on the way out re-rank, a refresh appends), so the same offset landed on a
 * different paper, or on the first one. The paper's own id survives all of
 * that; the saved index is the fallback for a paper the feed no longer has.
 */
export function resumeIndex({ papers = [], savedPaperId = null, savedIndex = 0 } = {}) {
  const total = papers.length;
  if (total === 0) return 0;
  if (savedPaperId) {
    const found = papers.findIndex(paper => paper?.id === savedPaperId);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(0, Math.trunc(savedIndex) || 0), total - 1);
}
