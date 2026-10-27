/** The pending-removal key of a paper's row in one list. */
export const rowRemovalKey = (listId: string, paperId: string) => `${listId}:${paperId}`;

/**
 * One removal per row at a time. A row now stays on screen until its removal
 * is accepted, so its Remove control can be pressed again meanwhile. A second
 * Favorites removal would send a second unlike, and each accepted unlike
 * takes the paper's weight out of the reading profile again. While a
 * removal is pending, a repeat is dropped and the row can show that it is
 * waiting.
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
