import { writeMark } from './write-mark.ts';

/**
 * Takes a paper's read mark off, on screen and in its interaction record.
 *
 * A refused write is logged. With `throwOnError` the mark and its read time
 * are put back and the error is rethrown, so the paper keeps its place in
 * Reading history. With `afterWrite` (the Lists page) the mark stays until the
 * write is accepted, and then goes only if no newer change to it has started
 * (`stillNewest`) and the paper is still shown read (`stillRead`), see
 * `writeMark`. Other callers keep the optimistic state.
 */
export async function unmarkRead<Entry extends { readAt?: string | number | null }>(
  paperId: string,
  { setReadIds, setLibrary, write, onUnmarked, onRestored, throwOnError = false, afterWrite = false, stillSignedIn, stillNewest, stillRead }: {
    setReadIds: (update: (ids: Set<string>) => Set<string>) => void;
    setLibrary: (update: (library: Record<string, Entry>) => Record<string, Entry>) => void;
    write: () => Promise<void>;
    /** Runs when the mark leaves the screen, `onRestored` when it comes back. */
    onUnmarked: () => void;
    onRestored: () => void;
    throwOnError?: boolean;
    afterWrite?: boolean;
    stillSignedIn: () => boolean;
    stillNewest: () => boolean;
    /** Whether the screen still shows the paper read (`stillAsStarted`). */
    stillRead: () => boolean;
  },
) {
  // Set by the updaters in `show`. React runs queued updaters in order, so the
  // updaters in `undo` always read them after those have run. `wasRead` keeps
  // the undo from adding an id the screen never held, such as an alias id that
  // has no interaction document.
  let readAt: Entry['readAt'];
  let wasRead = false;
  await writeMark({
    show: () => {
      setReadIds((ids) => {
        wasRead = ids.has(paperId);
        const next = new Set(ids);
        next.delete(paperId);
        return next;
      });
      setLibrary((library) => {
        if (!library[paperId]) return library;
        readAt = library[paperId].readAt;
        return { ...library, [paperId]: { ...library[paperId], readAt: null } };
      });
      onUnmarked();
    },
    undo: throwOnError ? () => {
      setReadIds((ids) => (wasRead ? new Set(ids).add(paperId) : ids));
      setLibrary((library) => (
        library[paperId] ? { ...library, [paperId]: { ...library[paperId], readAt } } : library
      ));
      onRestored();
    } : undefined,
    write,
    failure: 'Error unmarking read status:',
    afterWrite,
    throwOnError,
    stillSignedIn,
    stillNewest,
    stillAsStarted: stillRead,
  });
}
