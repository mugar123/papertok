/**
 * Puts a paper's library entry back as it was before a refused Read later
 * change: the mark, and the edit time and paper copy that change stamped.
 * Read later is ordered by edit time, so restoring the mark alone would send
 * the paper to the top of the list. Fields edited meanwhile, such as a note,
 * are kept.
 */
export function restoreReadLater<Entry extends { readLater?: boolean; updatedAt?: string | number | null; paper: unknown }>(
  library: Record<string, Entry>,
  paperId: string,
  previous: Entry | undefined,
): Record<string, Entry> {
  const current = library[paperId];
  if (!current) return library;
  return {
    ...library,
    [paperId]: {
      ...current,
      readLater: Boolean(previous?.readLater),
      updatedAt: previous?.updatedAt,
      paper: previous ? previous.paper : current.paper,
    },
  };
}
