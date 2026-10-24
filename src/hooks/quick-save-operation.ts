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
export async function markThenConfirm({ alreadySaved, issued, mark, unmark, confirm }: {
  alreadySaved: boolean;
  issued: Promise<unknown> | null;
  mark: () => Promise<void>;
  unmark: () => Promise<void>;
  confirm: () => Promise<void>;
}) {
  void mark();
  try {
    await issued;
    await confirm();
  } catch (error) {
    if (!alreadySaved) void unmark();
    throw error;
  }
}
