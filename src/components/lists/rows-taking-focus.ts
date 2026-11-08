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
