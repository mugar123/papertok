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
 * Whether the row an overlay was opened from has left the list now shown, so
 * the overlay hands focus to the row in `takers` rather than back to its own
 * opener. A row of another list, or one that came back, has not.
 */
export function rowHasLeft(
  row: { listId: string; paperId: string } | null,
  shown: { listId: string | null; paperIds: readonly string[] },
  takers: ReadonlyMap<string, string | null>,
): boolean {
  return row !== null && row.listId === shown.listId && takers.has(row.paperId) && !shown.paperIds.includes(row.paperId);
}

/**
 * Whether the reader has moved focus out of a closing overlay to another
 * element, such as Search opened while the overlay was closing. Base UI leaves
 * focus there, but not when `finalFocus` is a function: it counts as an
 * explicit target and skips that check, so the function makes it. Focus on the
 * page body, or still inside the overlay, has not been moved.
 */
export function focusMovedOut<T>(focused: T | null, body: T, overlay: { contains(node: T): boolean } | null): boolean {
  return focused !== null && focused !== body && !overlay?.contains(focused);
}
