import { FEED_TABS } from './feed-tabs.ts';

const TAB_SWIPE_MIN_PX = 60;
const TAB_SWIPE_EDGE_PX = 24;

/**
 * The tab a feed surface is, by the key its caller passed. For you passes
 * none: its scroll memory is keyed by account, which no tab is.
 */
export function feedTabPathForSurface(surfaceKey: string | undefined) {
  return FEED_TABS.find(tab => tab.scrollKey === (surfaceKey ?? 'forYou'))?.path;
}

/**
 * A sideways swipe on the feed moves between the navbar's feed tabs, `paths`
 * in the bar's order (the reader's feeds included): left to the next tab,
 * right to the previous one.
 */
export function tabSwipeTarget({ from, paths, startX, dx, dy, viewportWidth }: {
  from: string;
  paths: readonly string[];
  startX: number;
  dx: number;
  dy: number;
  viewportWidth: number;
}): string | null {
  const index = paths.indexOf(from);
  if (index === -1) return null;
  if (startX < TAB_SWIPE_EDGE_PX || startX > viewportWidth - TAB_SWIPE_EDGE_PX) return null;
  if (Math.abs(dx) < TAB_SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return paths[index + (dx < 0 ? 1 : -1)] ?? null;
}
