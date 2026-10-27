/**
 * What a caller of a mark toggle may ask for. `throwOnError`: a refused write
 * rejects instead of only being logged. `afterWrite`: the screen changes once
 * the write is accepted, not before.
 */
export interface MarkWriteOptions { throwOnError: boolean; afterWrite?: boolean }

/**
 * Changes one of a paper's marks (liked, read, Read later) on screen and in
 * its interaction record.
 *
 * By default the screen changes first and the write follows. A caller whose
 * view is drawn from the mark and that must not move before the server agrees
 * passes `afterWrite`: the Lists page, whose row would otherwise leave and
 * come back when a removal is refused (ENG-156). The screen then changes only
 * once the write is accepted.
 *
 * On a refused write, `undo` (when given) takes the optimistic change back,
 * and `throwOnError` rejects with the error instead of only logging it.
 *
 * Nothing is shown or put back once another account is signed in: a late
 * answer must not paint the previous account's mark over the new one.
 */
export async function writeMark({ show, undo, write, failure, afterWrite = false, throwOnError = false, stillSignedIn }: {
  show: () => void;
  undo?: () => void;
  write: () => Promise<void>;
  /** Logged with the error when the write is refused. */
  failure: string;
  afterWrite?: boolean;
  throwOnError?: boolean;
  stillSignedIn: () => boolean;
}) {
  if (!afterWrite) show();
  try {
    await write();
  } catch (error) {
    console.error(failure, error);
    if (!afterWrite && undo && stillSignedIn()) undo();
    if (throwOnError) throw error;
    return;
  }
  if (afterWrite && stillSignedIn()) show();
}
