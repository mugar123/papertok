/**
 * Shows `next` at once, then writes it. A refused write puts `previous` back
 * and rethrows, but only while the account that started the write is still
 * the signed-in one: a late failure after a session switch must not paint the
 * previous account's state over the new one.
 */
export async function writeOptimistically<T>({ previous, next, apply, write, startedBy, signedInUid }: {
  previous: T;
  next: T;
  apply: (value: T) => void;
  write: (value: T) => Promise<void>;
  startedBy: string | undefined;
  signedInUid: () => string | undefined;
}) {
  apply(next);
  try {
    await write(next);
    return next;
  } catch (updateError) {
    if (signedInUid() === startedBy) apply(previous);
    throw updateError;
  }
}
