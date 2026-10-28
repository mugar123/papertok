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

interface MarkChange {
  to: boolean;
  /** Whether the screen should show this change's value now. */
  stands: boolean;
  pending: boolean;
}

/**
 * Follows the changes to each mark while any of them waits for its write, so
 * that every answer leaves the screen on the value it should show. A key names
 * one mark of one paper for one account (`<uid>:like:<id>`), not the paper:
 * marking a paper read must not hold back its pending removal from Favorites.
 *
 * A change stands once Firestore accepts it, and while it waits if the screen
 * already shows it. A refused change no longer stands, unless its caller keeps
 * what it showed (no undo). Firestore applies a mark's writes in the order
 * they were sent, so the mark should show the newest change that stands, or,
 * when none does, the value the mark had when the first of these changes
 * started. A refusal therefore does not put back the value its own change
 * started from when an earlier removal has since been accepted.
 *
 * `start(key, change)` returns `answer(accepted)`, which records the write's
 * answer and returns the value the mark should now show, and whether the
 * answer changed what stands. It does not for an accepted change the screen
 * already shows, or a refused one that showed nothing or keeps what it showed.
 * `stand(key, to)` records a change that stands whatever its write's answer,
 * such as marking a paper read, which keeps its mark when refused.
 */
export function markChanges() {
  const marks = new Map<string, { startedFrom: boolean; changes: MarkChange[] }>();
  const shouldShow = (mark: { startedFrom: boolean; changes: MarkChange[] }) => (
    mark.changes.findLast((change) => change.stands)?.to ?? mark.startedFrom
  );
  return {
    start(key: string, { isOn, to, shown, keptIfRefused }: {
      /** The mark as the screen shows it before this change. */
      isOn: boolean;
      to: boolean;
      /** Whether the screen shows the change before the write is answered. */
      shown: boolean;
      /** Whether a refusal leaves on screen what the change showed. */
      keptIfRefused: boolean;
    }) {
      let mark = marks.get(key);
      if (!mark) {
        mark = { startedFrom: isOn, changes: [] };
        marks.set(key, mark);
      }
      const followed = mark;
      const change: MarkChange = { to, stands: shown, pending: true };
      followed.changes.push(change);
      return (accepted: boolean) => {
        change.pending = false;
        const stood = change.stands;
        change.stands = accepted || (stood && keptIfRefused);
        const value = shouldShow(followed);
        if (!followed.changes.some((other) => other.pending)) marks.delete(key);
        return { value, changed: change.stands !== stood };
      };
    },
    stand(key: string, to: boolean) {
      marks.get(key)?.changes.push({ to, stands: true, pending: false });
    },
  };
}

export type MarkChanges = ReturnType<typeof markChanges>;

/**
 * Changes one of a paper's marks (liked, read, Read later) on screen and in
 * its interaction record, from `from` to `to`.
 *
 * By default the screen changes first and the write follows. A caller whose
 * view is drawn from the mark and that must not move before the server agrees
 * passes `afterWrite`: the Lists page, whose row would otherwise leave and
 * come back when a removal is refused (ENG-156). An `afterWrite` change is a
 * removal: it starts from the mark on, and when the mark is already off as the
 * change is asked for, nothing is written.
 *
 * Once the write is answered, the mark moves to the value `markChanges` says
 * it should show, if the screen (`isOn`) differs: by `show` when that is this
 * change's value, by `undo` when it is the value this change started from.
 * So an accepted removal shows unless a newer change has already moved the
 * mark, and a refused change is taken back only as far as the changes still
 * standing allow. Each actual move runs `show` or `undo` once, so the reading
 * profile hears of each change on screen once. Without `undo`, a refused
 * change keeps what it showed, as the feed's toggles always have.
 * `throwOnError` rejects with the error instead of only logging it, unless
 * the mark ends where the change was going all the same, because another
 * change to the same value has been accepted or still stands, or the screen
 * already shows that value: the caller has nothing to report.
 *
 * Nothing is shown or put back once another account is signed in: a late
 * answer must not paint the previous account's mark over the new one.
 *
 * `writeOptimistically` (optimistic-write.ts) puts back a whole previous
 * value and always rethrows. A mark cannot use it: its undo moves only this
 * paper back inside a set other toggles may have changed meanwhile, the feed
 * callers only log a refusal, and the Lists page needs `afterWrite`.
 */
export async function writeMark({ show, undo, write, failure, afterWrite = false, throwOnError = false, stillSignedIn, changes, markKey, from, to, isOn }: {
  show: () => void;
  undo?: () => void;
  write: () => Promise<void>;
  /** Logged with the error when the write is refused. */
  failure: string;
  afterWrite?: boolean;
  throwOnError?: boolean;
  stillSignedIn: () => boolean;
  /** From `markChanges`, shared by every change to the marks. */
  changes: MarkChanges;
  markKey: string;
  from: boolean;
  to: boolean;
  /** The mark as the screen shows it now. */
  isOn: () => boolean;
}) {
  // A removal asked for once its mark has already gone, such as a second
  // Remove from a sheet left open over a row that has since left its list,
  // has nothing to take off: it sends nothing and shows nothing.
  if (afterWrite && isOn() !== from) return;
  const answer = changes.start(markKey, { isOn: isOn(), to, shown: !afterWrite, keptIfRefused: !undo });
  if (!afterWrite) show();
  let refusal: { error: unknown } | null = null;
  try {
    await write();
  } catch (error) {
    console.error(failure, error);
    refusal = { error };
  }
  // Nothing moves when this answer changes nothing that stands. A mark moved
  // since by something else, such as a profile reload, then stays where it
  // went, and an accepted change the screen already shows is not shown twice
  // before React has drawn it.
  const { value, changed } = answer(!refusal);
  if (changed && stillSignedIn() && isOn() !== value) {
    if (value === to) show();
    else if (value === from && undo) undo();
  }
  // A screen this answer leaves alone may already show `to` for a reason no
  // change records, such as a profile reload. A change asked for from the
  // value it goes to moved nothing, so its refusal is still news: the card's
  // unmark under an alias id the screen holds no mark for, say.
  const endsAtTo = from !== to && (value === to || (!changed && isOn() === to));
  if (refusal && throwOnError && !endsAtTo) throw refusal.error;
}
