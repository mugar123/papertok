/** The pending-removal key of a paper's row in one list. */
export const rowRemovalKey = (listId: string, paperId: string) => `${listId}:${paperId}`;

/**
 * One removal per row at a time. A row now stays on screen until its removal
 * is accepted, so its Remove control can be pressed again meanwhile. A repeat
 * would send the same write again, and from Favorites a second like_change
 * event; FeedContext shows only the newest, so the reading profile counts the
 * removal once either way. While a removal is pending, a repeat is dropped
 * and the row can show that it is waiting.
 */
export function removeRowOnce(
  pending: ReadonlySet<string>,
  setPending: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
  key: string,
  remove: () => Promise<void>,
) {
  if (pending.has(key)) return;
  setPending((current) => new Set(current).add(key));
  void remove().finally(() => {
    setPending((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  });
}
