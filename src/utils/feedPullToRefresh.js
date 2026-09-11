/**
 * Pull-to-refresh, the touch half of the feed's manual refresh.
 *
 * The gesture only exists on the first card: the scroller is at `scrollTop`
 * 0 and cannot move up, so a downward drag there is free to mean "refresh".
 * On every other card a downward drag is the scroll-snap taking the reader to
 * the previous paper, and the two must never compete — which is why nothing
 * here looks at where on the card the drag began, only at whether the feed
 * had anywhere to go.
 *
 * Two ways to complete it, like TikTok's: a slow drag past the threshold and
 * a release, during which the pill grows with the distance; or a fast fling
 * that refreshes at once without waiting for the pill to fill.
 */
export const PULL_REFRESH_THRESHOLD_PX = 110;
/** A fling this fast, over at least `PULL_FLING_MIN_PX`, refreshes on release. */
export const PULL_FLING_VELOCITY_PX_PER_MS = 1.2;
export const PULL_FLING_MIN_PX = 40;

/**
 * Scrollers of the card's own. A drag that begins inside one is that
 * scroller's — the expanded abstract used to answer its own drag with a feed
 * reload under the reader.
 */
export const PULL_BLOCKING_SCROLLERS = '.pc-abstract--open';

/** Where a pull may begin, or null. */
export function pullStartFrom({ target, scrollTop, clientY }) {
  if (scrollTop !== 0) return null;
  if (typeof target?.closest === 'function' && target.closest(PULL_BLOCKING_SCROLLERS)) return null;
  return clientY;
}

/** How far along the pull is, 0..1, for the pill to grow with. */
export function pullProgress({ startY, currentY }) {
  if (typeof startY !== 'number') return 0;
  const dy = currentY - startY;
  if (dy <= 0) return 0;
  return Math.min(1, dy / PULL_REFRESH_THRESHOLD_PX);
}

/**
 * Whether a release ends in a refresh: past the threshold, or a fling that
 * was fast enough over a distance that could not be a tremor.
 */
export function pullOutcome({ startY, endY, elapsedMs }) {
  if (typeof startY !== 'number') return 'none';
  const dy = endY - startY;
  if (dy > PULL_REFRESH_THRESHOLD_PX) return 'refresh';
  if (dy > PULL_FLING_MIN_PX && elapsedMs > 0 && dy / elapsedMs >= PULL_FLING_VELOCITY_PX_PER_MS) return 'refresh';
  return 'none';
}

/** Kept for callers that only need the slow-drag answer. */
export function isPullRefresh({ startY, endY }) {
  return pullOutcome({ startY, endY, elapsedMs: Infinity }) === 'refresh';
}
