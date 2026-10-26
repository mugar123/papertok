/**
 * Takes a paper out of one of the owner's own lists, on screen, once the
 * server has accepted the removal.
 *
 * A refused write (the list was deleted on another device, or its stored
 * document fails the `lists` rule) leaves the list as it was and calls
 * `onFailed`. Hiding the row anyway would show a paper gone that returns on
 * the next read, and the copy persisted on this device would keep the wrong
 * membership.
 *
 * The edit time is stamped after the write: a removal that failed must not
 * tell the freshness check that an edit happened, or the sync would publish
 * a list the account never agreed to.
 */
export async function removePaperFromList<List extends { id: string; paperIds?: string[]; updatedAt?: unknown }>(
  listId: string,
  paperId: string,
  { write, apply, onFailed }: {
    write: () => Promise<void>;
    apply: (update: (lists: List[]) => List[]) => void;
    onFailed: (error: unknown) => void;
  },
) {
  try {
    await write();
  } catch (error) {
    onFailed(error);
    return;
  }
  const editedAt = new Date();
  apply((lists) => lists.map((list) => {
    if (list.id !== listId) return list;
    return {
      ...list,
      paperIds: (list.paperIds ?? []).filter((id) => id !== paperId),
      updatedAt: editedAt,
    };
  }));
}
