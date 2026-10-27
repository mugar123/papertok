/**
 * Takes a paper's read mark off: on screen at once, then in its interaction
 * record.
 *
 * A refused write is logged. A caller that passes `throwOnError` (the Lists
 * page, whose Reading history row leaves with the mark) gets the mark and its
 * read time put back, then the error, so the row stays where it was and the
 * page can say why. Other callers keep the optimistic state.
 *
 * Nothing is put back once another account is signed in: a late refusal must
 * not paint the previous account's mark over the new one.
 */
export async function unmarkRead<Entry extends { readAt?: string | number | null }>(
  paperId: string,
  { setReadIds, setLibrary, write, onRestored, throwOnError = false, stillSignedIn }: {
    setReadIds: (update: (ids: Set<string>) => Set<string>) => void;
    setLibrary: (update: (library: Record<string, Entry>) => Record<string, Entry>) => void;
    write: () => Promise<void>;
    onRestored: () => void;
    throwOnError?: boolean;
    stillSignedIn: () => boolean;
  },
) {
  // Set by the updater below. React runs queued updaters in order, so the
  // rollback's updater always reads it after this one has run.
  let readAt: Entry['readAt'];
  setReadIds((ids) => {
    const next = new Set(ids);
    next.delete(paperId);
    return next;
  });
  setLibrary((library) => {
    if (!library[paperId]) return library;
    readAt = library[paperId].readAt;
    return { ...library, [paperId]: { ...library[paperId], readAt: null } };
  });

  try {
    await write();
  } catch (error) {
    console.error('Error unmarking read status:', error);
    if (!throwOnError) return;
    if (stillSignedIn()) {
      setReadIds((ids) => new Set(ids).add(paperId));
      setLibrary((library) => (
        library[paperId] ? { ...library, [paperId]: { ...library[paperId], readAt } } : library
      ));
      onRestored();
    }
    throw error;
  }
}
