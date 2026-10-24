/**
 * A sideways swipe on the feed moves between the navbar's feed tabs, in the
 * bar's order: left to the next tab, right to the previous one.
 */
export const FEED_TABS = ['/feed', '/following'] as const;
export const TAB_SWIPE_MIN_PX = 60;
// Safari's own back gesture starts at the screen edge; a swipe from there is the browser's.
export const TAB_SWIPE_EDGE_PX = 24;

export function tabSwipeTarget({ from, startX, dx, dy, viewportWidth }: {
  from: string;
  startX: number;
  dx: number;
  dy: number;
  viewportWidth: number;
}): string | null {
  const index = FEED_TABS.indexOf(from as (typeof FEED_TABS)[number]);
  if (index === -1) return null;
  if (startX < TAB_SWIPE_EDGE_PX || startX > viewportWidth - TAB_SWIPE_EDGE_PX) return null;
  // Mostly sideways: a diagonal flick through the feed stays a scroll.
  if (Math.abs(dx) < TAB_SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return FEED_TABS[index + (dx < 0 ? 1 : -1)] ?? null;
}
