import { feedPositionSentence, type CustomFeed } from './custom-feeds.ts';

type NamedFeed = Pick<CustomFeed, 'id' | 'name'>;

/**
 * Which moves a feed's tab menu offers: none past either end of the reader's
 * feeds, and none for a feed that is no longer among them.
 */
export function feedTabMoves(feeds: readonly NamedFeed[], id: string): { left: boolean; right: boolean } {
  const index = feeds.findIndex(feed => feed.id === id);
  return { left: index > 0, right: index >= 0 && index < feeds.length - 1 };
}

/**
 * What the bar says once a move from a tab's menu is saved, worked out from
 * the order before the move: where the feed now stands among the reader's
 * feeds. Empty for a feed that is not there or cannot move that way.
 */
export function feedMovedAnnouncement(feeds: readonly NamedFeed[], id: string, delta: -1 | 1): string {
  const index = feeds.findIndex(feed => feed.id === id);
  const to = index + delta;
  if (index < 0 || to < 0 || to >= feeds.length) return '';
  const moved = [...feeds];
  [moved[index], moved[to]] = [moved[to], moved[index]];
  return feedPositionSentence(moved, id);
}

/**
 * The tab that takes focus once a feed's tab is deleted: the feed tab that
 * moves into its place, else the tab before it, else For you.
 *
 * @param tabKeys     the bar's tab keys in order (`home`, `following`, then `feed:<id>` for each feed)
 * @param deletedKey  the deleted feed's tab key
 */
export function tabAfterDelete(tabKeys: readonly string[], deletedKey: string): string {
  const index = tabKeys.indexOf(deletedKey);
  const next = tabKeys[index + 1];
  if (index >= 0 && next?.startsWith('feed:')) return next;
  return index > 0 ? tabKeys[index - 1] : 'home';
}

/**
 * What a menu opening on a tab does with the touch press recorded there:
 * `none` when no touch pressed this tab (a mouse or the keyboard opened it),
 * otherwise the press ends (lifting the finger must not also choose the tab)
 * and the menu opens only if the line stayed still (`held`), as a tap would
 * choose it; a press during which the line moved is `refused`. Decided by the
 * press, not by the event that opens the menu: a long press may arrive as
 * touch events or as the browser's own `contextmenu`.
 */
export function holdOutcome(pressedTab: string | null, tab: string, lineStill: () => boolean): 'none' | 'held' | 'refused' {
  if (pressedTab !== tab) return 'none';
  return lineStill() ? 'held' : 'refused';
}

/**
 * The delete confirmation's title. The name is isolated (U+2068 … U+2069) so
 * a right-to-left name keeps the quotes and the question mark where an
 * English sentence puts them.
 */
export function deleteFeedTitle(name: string): string {
  return `Delete “\u2068${name}\u2069”?`;
}

export const DELETE_FEED_SENTENCE = 'The feed and its tab go away. Your likes and saved papers stay.';
