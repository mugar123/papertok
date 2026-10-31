/**
 * The pending-removal key of a paper's row in one list of one account: a
 * removal still waiting when another account signs in must not hold back the
 * same row of the new account.
 */
export const rowRemovalKey = (uid: string, listId: string, paperId: string) => `${uid}:${listId}:${paperId}`;

/**
 * One removal per row at a time. A row now stays on screen until its removal
 * is accepted, so its Remove control can be pressed again meanwhile. While a
 * removal is pending, a repeat is dropped and the row can show that it is
 * waiting. This state lives as long as the page; FeedContext's writeMark also
 * drops a repeated removal from Favorites, Read later or Reading history, so
 * the page opened again sends no second write or like_change event either.
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
