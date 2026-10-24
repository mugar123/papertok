import { FEED_TABS } from './feed-tabs.ts';

const TAB_SWIPE_MIN_PX = 60;
const TAB_SWIPE_EDGE_PX = 24;

/**
 * A sideways swipe on the feed moves between the navbar's feed tabs, in the
 * bar's order: left to the next tab, right to the previous one.
 */
export function tabSwipeTarget({ from, startX, dx, dy, viewportWidth }: {
  from: string;
  startX: number;
  dx: number;
  dy: number;
  viewportWidth: number;
}): string | null {
  const index = FEED_TABS.findIndex(tab => tab.path === from);
  if (index === -1) return null;
  if (startX < TAB_SWIPE_EDGE_PX || startX > viewportWidth - TAB_SWIPE_EDGE_PX) return null;
  if (Math.abs(dx) < TAB_SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return FEED_TABS[index + (dx < 0 ? 1 : -1)]?.path ?? null;
}
