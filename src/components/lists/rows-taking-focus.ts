/**
 * Which row takes keyboard focus from each row that has left an open list, so
 * that focus on a leaving row, or on an overlay opened from one, lands on a row
 * that stays instead of falling to the page (WCAG 2.4.3).
 *
 * A leaving row hands over to the nearest row after it that stays and can hold
 * focus, else to the nearest such row before it, else to null: the list
 * heading. A row that left earlier and handed over to a row leaving now passes
 * on to that row's successor, so every entry names a row still in the list.
 *
 * Returns `takers` itself when no row left.
 */
export function rowsTakingFocus(
  takers: ReadonlyMap<string, string | null>,
  before: readonly string[],
  after: readonly string[],
  canHoldFocus: (paperId: string) => boolean,
): ReadonlyMap<string, string | null> {
  const kept = new Set(after);
  const stays = (paperId: string) => kept.has(paperId) && canHoldFocus(paperId);
  const leaving = new Map<string, string | null>();
  before.forEach((paperId, index) => {
    if (kept.has(paperId)) return;
    leaving.set(paperId, before.slice(index + 1).find(stays) ?? before.slice(0, index).findLast(stays) ?? null);
  });
  if (leaving.size === 0) return takers;
  const next = new Map<string, string | null>();
  for (const [paperId, taker] of takers) {
    next.set(paperId, taker !== null && leaving.has(taker) ? (leaving.get(taker) ?? null) : taker);
  }
  for (const [paperId, taker] of leaving) next.set(paperId, taker);
  return next;
}

/**
 * Which row an overlay opened from a row gives focus to as it closes, from the
 * rows shown when it opened (`opened`) and now (`shown`): the row itself while
 * it keeps its place among the rows that stayed, else the row now at that
 * place, picked as `rowsTakingFocus` picks it. When no other row can take it,
 * the row itself if it is still shown, else null for the list heading.
 *
 * The place is kept, not the paper: a paper unliked and liked again on its
 * card comes back at the end of Favorites, or at the top of Reading history,
 * and focus following it there would leave the screen.
 */
export function rowAfterOverlay(
  paperId: string,
  opened: readonly string[],
  shown: readonly string[],
  canHoldFocus: (paperId: string) => boolean,
): string | null {
  const index = opened.indexOf(paperId);
  const at = shown.indexOf(paperId);
  if (index === -1) return at === -1 ? null : paperId;
  const kept = new Set(shown);
  const previous = opened.slice(0, index).findLast((id) => kept.has(id));
  const next = opened.slice(index + 1).find((id) => kept.has(id));
  const inPlace = at !== -1
    && (previous === undefined || shown.indexOf(previous) < at)
    && (next === undefined || at < shown.indexOf(next));
  if (inPlace) return paperId;
  return rowsTakingFocus(new Map(), opened, shown.filter((id) => id !== paperId), canHoldFocus).get(paperId) ?? (at === -1 ? null : paperId);
}

/**
 * Whether the reader has moved focus out of a closing overlay to another
 * element, such as Search opened while the overlay was closing. Base UI leaves
 * focus there, but not when `finalFocus` is a function: it counts as an
 * explicit target and skips that check, so the function makes it. Focus on the
 * page body, or still inside the overlay, has not been moved. With no overlay
 * element, any focused element but the body counts as moved, as in Base UI.
 */
export function focusMovedOut<T>(focused: T | null, body: T, overlay: { contains(node: T): boolean } | null): boolean {
  return focused !== null && focused !== body && !overlay?.contains(focused);
}
