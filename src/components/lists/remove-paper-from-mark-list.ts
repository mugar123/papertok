import type { MarkWriteOptions } from '../../context/write-mark.ts';

/**
 * Takes a paper out of Favorites, Read later or Reading history, the lists
 * drawn from a paper's marks rather than from a list document.
 *
 * Like a custom list (`removePaperFromList`), the row leaves only once the
 * server has accepted the removal, so a refused write never moves it: the
 * remove dialog closes on a row that is still there, and `onFailed` says why.
 *
 * The paper's stored copy can carry an id other than the row's (R8: ids differ
 * by entry route), so the removal names the row's own id: otherwise it would
 * look for the mark under the copy's id, find none and send nothing.
 *
 * Returns null for any other list.
 */
export function removePaperFromMarkList<P extends { id: string }>(
  listId: string,
  paperId: string,
  paper: P,
  { unmarkAsRead, toggleLike, toggleReadLater, onFailed }: {
    unmarkAsRead: (id: string, options: MarkWriteOptions) => Promise<void>;
    toggleLike: (paper: P, options: MarkWriteOptions) => Promise<void>;
    toggleReadLater: (paper: P, value: boolean, options: MarkWriteOptions) => Promise<unknown>;
    onFailed: (error: unknown) => void;
  },
): Promise<void> | null {
  const once: MarkWriteOptions = { throwOnError: true, afterWrite: true };
  const row = { ...paper, id: paperId };
  let write: Promise<unknown>;
  if (listId === '__read__') write = unmarkAsRead(paperId, once);
  else if (listId === '__favorites__') write = toggleLike(row, once);
  else if (listId === '__read_later__') write = toggleReadLater(row, false, once);
  else return null;
  return write.then(() => undefined, onFailed);
}
