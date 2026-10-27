/**
 * What a caller of a mark toggle may ask for. `throwOnError`: a refused write
 * rejects instead of only being logged. `afterWrite`: the change takes the
 * mark off a paper in a saved list, and the screen changes once the write is
 * accepted, not before.
 */
export interface MarkWriteOptions { throwOnError: boolean; afterWrite?: boolean }

/**
 * Whether a change starts from the mark on. A removal from a saved list
 * (`afterWrite`) only ever takes the mark off, so it starts from on whatever
 * the screen shows by now: when the mark has already gone, writeMark writes
 * nothing rather than turning it back on.
 */
export function markStartsOn(options: Pick<MarkWriteOptions, 'afterWrite'> | undefined, isOn: boolean) {
  return Boolean(options?.afterWrite) || isOn;
}

/**
 * Numbers the changes started on each mark, so a write answered late can tell
 * whether a newer change to the same mark has started since. A key names one
 * mark of one paper (`like:<id>`), not the paper: marking a paper read must
 * not hold back its pending removal from Favorites.
 *
 * Returns `start(key)`, which numbers a new change and returns whether that
 * change is still the newest.
 */
export function markChanges() {
  const newest = new Map<string, number>();
  return (key: string) => {
    const change = (newest.get(key) ?? 0) + 1;
    newest.set(key, change);
    return () => newest.get(key) === change;
  };
}

/**
 * Changes one of a paper's marks (liked, read, Read later) on screen and in
 * its interaction record.
 *
 * By default the screen changes first and the write follows. A caller whose
 * view is drawn from the mark and that must not move before the server agrees
 * passes `afterWrite`: the Lists page, whose row would otherwise leave and
 * come back when a removal is refused (ENG-156). The screen then changes only
 * once the write is accepted, and only if no newer change to the same mark
 * has started meanwhile, from any page (`stillNewest`): the newer change
 * shows its own value, and Firestore applies its write after this one. Nor
 * does it show when the mark no longer has the value this change started
 * from (`stillAsStarted`): something that bypasses the toggles, such as a
 * profile reload, already moved it, and showing again would tell the reading
 * profile twice. An `afterWrite` change is a removal: the caller states the
 * value it starts from (the mark on), and when the mark is already off as the
 * change is asked for, nothing is written.
 *
 * On a refused write, `undo` (when given) takes the optimistic change back,
 * and `throwOnError` rejects with the error instead of only logging it. An
 * undo runs even after a newer change: it takes back only what its own
 * `show` did, so the reading profile stays balanced when several writes are
 * refused in turn. It does not keep the screen equal to the server: when two
 * changes to one mark are both refused, the screen ends on the first one's
 * value, as it did before writeMark.
 *
 * Nothing is shown or put back once another account is signed in: a late
 * answer must not paint the previous account's mark over the new one.
 *
 * `writeOptimistically` (optimistic-write.ts) puts back a whole previous
 * value and always rethrows. A mark cannot use it: its undo moves only this
 * paper back inside a set other toggles may have changed meanwhile, the feed
 * callers only log a refusal, and the Lists page needs `afterWrite`.
 */
export async function writeMark({ show, undo, write, failure, afterWrite = false, throwOnError = false, stillSignedIn, stillNewest, stillAsStarted }: {
  show: () => void;
  undo?: () => void;
  write: () => Promise<void>;
  /** Logged with the error when the write is refused. */
  failure: string;
  afterWrite?: boolean;
  throwOnError?: boolean;
  stillSignedIn: () => boolean;
  /** From `markChanges`, started when this change was asked for. */
  stillNewest: () => boolean;
  /** Whether the mark on screen still has the value this change started from. */
  stillAsStarted: () => boolean;
}) {
  // A removal asked for once its mark has already gone, such as a second
  // Remove from a sheet left open over a row that has since left its list,
  // has nothing to take off: it sends nothing and shows nothing.
  if (afterWrite && !stillAsStarted()) return;
  if (!afterWrite) show();
  try {
    await write();
  } catch (error) {
    console.error(failure, error);
    if (!afterWrite && undo && stillSignedIn()) undo();
    if (throwOnError) throw error;
    return;
  }
  if (afterWrite && stillSignedIn() && stillNewest() && stillAsStarted()) show();
}
