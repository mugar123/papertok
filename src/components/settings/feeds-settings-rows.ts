import { ingredientLabel, MAX_CUSTOM_FEEDS, type CustomFeed } from '../../utils/custom-feeds.ts';

/** One row of Settings › Feeds: what it shows and which of its moves are possible. */
export interface FeedRow {
  feed: CustomFeed;
  /** The ingredients in the feed's order, on one line. */
  ingredients: string;
  /** Each action's accessible name, which says the feed it acts on. */
  names: { edit: string; moveUp: string; moveDown: string; delete: string };
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export function feedRows(feeds: readonly CustomFeed[]): FeedRow[] {
  return feeds.map((feed, index) => ({
    feed,
    ingredients: feed.ingredients.length > 0 ? feed.ingredients.map(ingredientLabel).join(', ') : 'No ingredients yet',
    names: {
      edit: `Edit ${feed.name}`,
      moveUp: `Move ${feed.name} up`,
      moveDown: `Move ${feed.name} down`,
      delete: `Delete ${feed.name}`,
    },
    canMoveUp: index > 0,
    canMoveDown: index < feeds.length - 1,
  }));
}

/** Said only when it explains something: once the account holds as many feeds as it may. */
export function feedLimitNote(count: number): string | null {
  return count >= MAX_CUSTOM_FEEDS ? `${count} of ${MAX_CUSTOM_FEEDS} feeds` : null;
}

/**
 * The status line's text for the `n`th announcement. A live region speaks
 * only when its text changes, so every other one ends in a no-break space:
 * two moves that end in the same words are both announced.
 */
export function liveStatusText(text: string, n: number): string {
  return text && n % 2 === 1 ? `${text}\u00A0` : text;
}

/**
 * The move button that takes focus once a move has been saved: the one
 * pressed, or the row's other one when the feed reached an end and the
 * pressed one is disabled.
 */
export function focusAfterMove(row: FeedRow, pressed: 'up' | 'down'): 'up' | 'down' | null {
  const enabled = { up: row.canMoveUp, down: row.canMoveDown };
  if (enabled[pressed]) return pressed;
  const other = pressed === 'up' ? 'down' : 'up';
  return enabled[other] ? other : null;
}

/**
 * The feed whose row takes focus once the feed `id` is deleted: the one that
 * moves into its place, else the one before it; null when no feed is left or
 * `id` is not among them.
 */
export function rowAfterDelete(feeds: readonly CustomFeed[], id: string): string | null {
  const index = feeds.findIndex(feed => feed.id === id);
  if (index < 0) return null;
  return feeds[index + 1]?.id ?? feeds[index - 1]?.id ?? null;
}
