/**
 * One operation per paper at a time. A tap while one runs is dropped: the
 * button already shows what the reader asked for, and the operation reads
 * the state it settles, so a second one could not tell which way to go.
 */
export function runOneAtATime(inFlight: Set<string>, id: string, operation: () => Promise<void>) {
  if (inFlight.has(id)) return Promise.resolve();
  inFlight.add(id);
  return operation().finally(() => { inFlight.delete(id); });
}

/**
 * A save: the mark fills the button now, after the saved document was issued
 * (`issued`), and the acknowledgements come after. A refused write takes the
 * mark back and rethrows, unless the paper was already saved when the
 * operation began: an Undo can land on a paper the reader has saved again by
 * hand, and a refused Undo must not take that save back.
 */
export async function markThenConfirm({ alreadySaved, issued, mark, unmark, confirm, onSaved }: {
  alreadySaved: boolean;
  issued: Promise<unknown> | null;
  mark: () => Promise<void>;
  unmark: () => Promise<void>;
  confirm: () => Promise<void>;
  onSaved: () => void;
}) {
  try {
    await Promise.all([issued, mark()]);
    await confirm();
  } catch (error) {
    if (!alreadySaved) void unmark();
    throw error;
  }
  if (!alreadySaved) onSaved();
}

export async function unmarkThenConfirm<T>({ unmark, confirm, restore, onRemoved }: {
  unmark: () => Promise<void>;
  confirm: () => Promise<T | null>;
  restore: () => Promise<void>;
  onRemoved: () => void;
}) {
  try {
    await unmark();
    const result = await confirm();
    if (result === null) {
      await restore();
      return null;
    }
    onRemoved();
    return result;
  } catch (error) {
    await restore();
    throw error;
  }
}

export async function writeSaveDestinations({ previousReadLater, nextReadLater, writeReadLater, writeLists }: {
  previousReadLater: boolean;
  nextReadLater: boolean;
  writeReadLater: (value: boolean) => Promise<unknown>;
  writeLists: () => Promise<void>;
}) {
  const changedReadLater = previousReadLater !== nextReadLater;
  if (changedReadLater) await writeReadLater(nextReadLater);
  try {
    await writeLists();
  } catch (error) {
    if (changedReadLater) await writeReadLater(previousReadLater);
    throw error;
  }
}
