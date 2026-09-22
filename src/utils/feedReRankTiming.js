/**
 * When a deferred re-rank may land.
 *
 * The re-rank reorders the queue behind the reader: it re-attaches every
 * snap item whose position moved and re-renders their cards. An idle
 * callback is not, by itself, a quiet moment to do that in — the main
 * thread is idle for exactly as long as the compositor is running the snap
 * to the next card, so a re-rank armed by the card that just left landed
 * inside that animation (measured 2026-09-22, production bundle). The feed
 * reports every scroll event through `reportVisiblePaper`; this holds the
 * re-rank until that report has been quiet for `RERANK_SCROLL_QUIET_MS`,
 * and never past `RERANK_MAX_WAIT_MS` from the first request, so a reader
 * flicking through cards without pause still gets the queue re-ranked.
 */
// The snap takes ~300-500 ms from the last input; this covers it with a
// beat to spare before anything heavy is committed.
export const RERANK_SCROLL_QUIET_MS = 450;
export const RERANK_MAX_WAIT_MS = 4000;

/**
 * Milliseconds to hold a pending re-rank, or 0 to run it now.
 *
 * `scrolledAt` is the last scroll report (0 when the feed has never
 * scrolled), `requestedAt` when this re-rank was first asked for.
 */
export function reRankHoldMs({ now, scrolledAt = 0, requestedAt = now } = {}) {
  const sinceScroll = now - scrolledAt;
  if (sinceScroll >= RERANK_SCROLL_QUIET_MS) return 0;
  if (now - requestedAt >= RERANK_MAX_WAIT_MS) return 0;
  return RERANK_SCROLL_QUIET_MS - sinceScroll;
}
