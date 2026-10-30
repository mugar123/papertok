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
  /** For a change not shown before its answer: settles once it is answered. */
  answered: Promise<void> | null;
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
 * `start(key, change)` returns `answer(accepted, isOn)`, which records the
 * write's answer and returns the value the mark should now show, whether the
 * answer changed what stands, and what the screen shows (`onScreen`). It does
 * not change what stands for an accepted change the screen already shows, or
 * a refused one that showed nothing or keeps what it showed. The caller that
 * then moves the mark calls `moved()`.
 * `stand(key, to, isOn)` records a change that stands whatever its write's
 * answer, such as marking a paper read, which keeps its mark when refused.
 * `unshownChange(key, to)` returns, while the newest change to the mark is
 * one to `to` not shown before its answer, a promise that settles once it is
 * answered: the same removal asked for again need not be sent again.
 *
 * The screen a caller reads (`isOn`) lags: FeedContext reads a ref React
 * updates only once it has drawn the state. Several answers can land before
 * that, and each would find the value from before the others moved the mark,
 * move it again and tell the reading profile again. So each mark keeps the
 * value its changes last sent to the screen, with what `isOn` read then;
 * while `isOn` still reads that, the sent value is what the screen shows
 * (`shows(key, isOn)`). When its last change is answered before React draws
 * the value last sent to the screen, a mark stays followed for that value
 * until `isOn` reads something else, so a tap before React draws it still
 * counts it; a value already drawn by then is not followed any further. A tap
 * that starts from that value without showing anything spends it: once that
 * tap is answered, the mark is no longer followed unless the answer moved it.
 * A boolean cannot tell a drawn move from one undone since, so whatever puts
 * every mark back at once, such as a profile load, calls `screenReplaced()`:
 * otherwise, after the old value came back before anything read the mark,
 * the next tap would write without moving the screen. The cost is that a
 * second tap from the same undrawn value, answered before React draws, is
 * counted from the old screen again.
 *
 * Firestore answers one document's writes in the order they were sent.
 * Answered out of that order, the screen still ends on the right value, but
 * the profile may hear a like and unlike pair (or read and unread) that was
 * never drawn; the two carry equal and opposite weight.
 */
export function markChanges() {
  interface Mark {
    startedFrom: boolean;
    changes: MarkChange[];
    /**
     * `spent`: a change has since started, without showing anything, from the
     * screen this value is on.
     */
    sent?: { value: boolean; read: boolean; spent?: boolean };
  }
  const marks = new Map<string, Mark>();
  const shouldShow = (mark: Mark) => (
    mark.changes.findLast((change) => change.stands)?.to ?? mark.startedFrom
  );
  const onScreen = (mark: Mark, isOn: boolean) => (
    mark.sent && mark.sent.read === isOn ? mark.sent.value : isOn
  );
  // A mark whose changes have all been answered is kept only for the value
  // last sent to the screen, and only until `isOn` reads something else.
  const followedMark = (key: string, isOn: boolean) => {
    const mark = marks.get(key);
    if (mark && !mark.changes.some((change) => change.pending) && mark.sent?.read !== isOn) {
      marks.delete(key);
      return undefined;
    }
    return mark;
  };
  return {
    /** What the screen shows of the mark, counting moves React has not drawn. */
    shows(key: string, isOn: boolean) {
      const mark = followedMark(key, isOn);
      return mark ? onScreen(mark, isOn) : isOn;
    },
    start(key: string, { isOn, to, shown, spends = false, keptIfRefused }: {
      /** The mark as the screen shows it before this change. */
      isOn: boolean;
      to: boolean;
      /** Whether the screen shows the change before the write is answered. */
      shown: boolean;
      /** Whether the change asks for the value the screen was last sent. */
      spends?: boolean;
      /** Whether a refusal leaves on screen what the change showed. */
      keptIfRefused: boolean;
    }) {
      let mark = followedMark(key, isOn);
      if (!mark) {
        mark = { startedFrom: isOn, changes: [] };
        marks.set(key, mark);
      }
      const followed = mark;
      if (shown) followed.sent = { value: to, read: isOn };
      else if (spends && followed.sent) followed.sent.spent = true;
      let settle = () => {};
      const answered = shown ? null : new Promise<void>((resolve) => { settle = resolve; });
      const change: MarkChange = { to, stands: shown, pending: true, answered };
      followed.changes.push(change);
      return (accepted: boolean, isOnNow: boolean) => {
        change.pending = false;
        const stood = change.stands;
        change.stands = accepted || (stood && keptIfRefused);
        const value = shouldShow(followed);
        const shown = onScreen(followed, isOnNow);
        // The last answer ends these changes. The mark stays followed for the
        // value last sent to the screen, for one tap that starts from it.
        // Once `isOn` reads something other than what it read when that value
        // was sent, React has drawn it, and a later reset that puts the old
        // value back must not make the value count as shown again.
        if (!followed.changes.some((other) => other.pending)) {
          const undrawn = followed.sent && !followed.sent.spent && followed.sent.read === isOnNow;
          if (undrawn) marks.set(key, { startedFrom: shown, changes: [], sent: followed.sent });
          else marks.delete(key);
        }
        settle();
        return {
          value,
          changed: change.stands !== stood,
          onScreen: shown,
          moved: () => {
            const sent = { value, read: isOnNow };
            const mark = marks.get(key);
            if (mark) {
              mark.sent = sent;
              if (!mark.changes.some((other) => other.pending)) mark.startedFrom = value;
            } else {
              marks.set(key, { startedFrom: value, changes: [], sent });
            }
          },
        };
      };
    },
    stand(key: string, to: boolean, isOn: boolean) {
      const mark = followedMark(key, isOn);
      if (!mark) return;
      mark.changes.push({ to, stands: true, pending: false, answered: null });
      mark.sent = { value: to, read: isOn };
    },
    /**
     * Every mark on screen was set anew, as a profile load sets them: what
     * earlier changes sent to the screen no longer describes it. Changes
     * still waiting stay followed, as their answers have yet to land.
     */
    screenReplaced() {
      for (const [key, mark] of marks) {
        if (mark.changes.some((change) => change.pending)) delete mark.sent;
        else marks.delete(key);
      }
    },
    unshownChange(key: string, to: boolean) {
      const newest = marks.get(key)?.changes.at(-1);
      return newest?.pending && newest.to === to ? newest.answered : null;
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
 * it should show, if the screen differs (`isOn`, counting the moves earlier
 * answers made before React drew them): by `show` when that is this
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
 * An `afterWrite` removal asked for again while the same removal still waits,
 * and no other change to the mark has started since, sends nothing and
 * returns once the first is answered; the first caller reports a refusal.
 * The Lists page, left and opened again, offers Remove on a row whose removal
 * is pending, and two answers landing before React has drawn the first would
 * both find the mark on and tell the reading profile twice.
 *
 * Nothing is shown, put back or rethrown once another account is signed in: a
 * late answer must not paint the previous account's mark over the new one, or
 * report the previous account's refusal in the new one's session.
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
  const showsNow = changes.shows(markKey, isOn());
  if (afterWrite && showsNow !== from) return;
  const sent = afterWrite ? changes.unshownChange(markKey, to) : null;
  if (sent) return sent;
  // A tap drawn from a screen an answer has moved since, before React drew
  // the move, asks for the value the mark already shows: its write is still
  // sent, but it shows nothing, so the profile is not told the move twice and
  // a refusal cannot put back a value the screen no longer holds.
  const spends = !afterWrite && from !== to && showsNow === to;
  const shown = !afterWrite && !spends;
  const answer = changes.start(markKey, { isOn: isOn(), to, shown, spends, keptIfRefused: !undo });
  if (shown) show();
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
  // before React has drawn it. `onScreen` counts the moves earlier answers
  // sent before React drew them, so a move is made and told once.
  const { value, changed, onScreen, moved } = answer(!refusal, isOn());
  if (changed && stillSignedIn() && onScreen !== value) {
    if (value === to) {
      show();
      moved();
    } else if (value === from && undo) {
      undo();
      moved();
    }
  }
  // A screen this answer leaves alone may already show `to` for a reason no
  // change records, such as a profile reload. A change asked for from the
  // value it goes to moved nothing, so its refusal is still news: the card's
  // unmark under an alias id the screen holds no mark for, say.
  // Once another account is signed in, the refusal is no news to it either.
  const endsAtTo = from !== to && (value === to || (!changed && onScreen === to));
  if (refusal && throwOnError && !endsAtTo && stillSignedIn()) throw refusal.error;
}
