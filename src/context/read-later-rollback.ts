/**
 * Puts a paper's library entry back as it was before a refused Read later
 * change: the mark, and the edit time and paper copy that change stamped.
 * Read later is ordered by edit time, so restoring the mark alone would send
 * the paper to the top of the list. A field changed since, such as a note, a
 * later edit time or a paper copy completed with its topic, is kept: each
 * stamped field goes back only while it still holds what this change wrote.
 */
export function restoreReadLater<Entry extends { readLater?: boolean; updatedAt?: string | number | null; paper: unknown }>(
  library: Record<string, Entry>,
  paperId: string,
  previous: Entry | undefined,
  /** The paper copy and edit time the refused change put on screen. */
  stamped: Pick<Entry, 'paper' | 'updatedAt'>,
): Record<string, Entry> {
  const current = library[paperId];
  if (!current) return library;
  return {
    ...library,
    [paperId]: {
      ...current,
      readLater: Boolean(previous?.readLater),
      updatedAt: current.updatedAt === stamped.updatedAt ? previous?.updatedAt : current.updatedAt,
      paper: previous && current.paper === stamped.paper ? previous.paper : current.paper,
    },
  };
}
