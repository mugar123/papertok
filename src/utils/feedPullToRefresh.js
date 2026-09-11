/**
 * Pull-to-refresh, the touch half of the feed's manual refresh.
 *
 * The hard part is that a downward drag already means something: under
 * `scroll-snap-type: y mandatory` it takes the reader to the previous paper.
 * So the pull has to be told apart from it, and there are two cases:
 *
 *   1. On the first card the feed cannot scroll up at all, so any downward
 *      drag there is free to mean refresh — this is the TikTok gesture.
 *   2. On any other card, only a drag that BEGINS in the band right under
 *      the navbar claims the gesture. Everywhere else on the card a drag
 *      down is the previous paper, untouched.
 *
 * The decision is taken on the first move of the finger, from its direction:
 * downward is ours (and the caller stops the feed scrolling under it),
 * upward is the feed's and we let go for the rest of the gesture. Deciding
 * on the first move matters — once the browser has begun scrolling for a
 * touch it will not honour `preventDefault` on the moves after it.
 *
 * Two ways to finish, also like TikTok's: a slow drag past the threshold and
 * a release, during which the pill grows with the distance; or a fast fling
 * that refreshes at once without waiting for the pill to fill.
 */
export const PULL_REFRESH_THRESHOLD_PX = 110;
/** A fling this fast, over at least `PULL_FLING_MIN_PX`, refreshes on release. */
export const PULL_FLING_VELOCITY_PX_PER_MS = 1.2;
export const PULL_FLING_MIN_PX = 40;
/**
 * Depth of the band under the navbar from which a pull may begin on a card
 * that is not the first. Deep enough to be reachable with a thumb, shallow
 * enough that the rest of the card keeps the gesture it already had.
 */
export const PULL_BAND_PX = 96;

/**
 * Scrollers of the card's own. A drag that begins inside one is that
 * scroller's — the expanded abstract used to answer its own drag with a feed
 * reload under the reader.
 */
export const PULL_BLOCKING_SCROLLERS = '.pc-abstract--open';

/** Where a pull may begin, or null. `containerTop` is the scroller's own top. */
export function pullStartFrom({ target, scrollTop, clientY, containerTop = 0 }) {
  if (typeof target?.closest === 'function' && target.closest(PULL_BLOCKING_SCROLLERS)) return null;
  if (scrollTop === 0) return clientY;
  return clientY - containerTop <= PULL_BAND_PX ? clientY : null;
}

/**
 * Whether the first move of an armed gesture claims it for the pull. Down is
 * ours; up is the feed going to the next paper. A move more sideways than
 * vertical is neither, and is left to the browser.
 */
export function pullTakesOver({ startY, startX = 0, currentY, currentX = 0 }) {
  const dy = currentY - startY;
  if (dy <= 0) return false;
  return dy > Math.abs(currentX - startX);
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
