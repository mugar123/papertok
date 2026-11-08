/**
 * Which row's Unfollow button takes focus when the row keyed `removed`
 * leaves the follows list, whose rows are `keys` in order: the next row, or
 * the previous one when it was the last. The row's own button leaves with
 * it, and focus left there would fall to the page (ENG-170). Rows in
 * `pending` are skipped: their write is still running, so their button is
 * disabled and cannot take focus. Null when no other row can take it, or the
 * row is not in the list, and focus goes to the type control instead.
 */
export function focusAfterUnfollow(keys: readonly string[], removed: string, pending: ReadonlySet<string>): string | null {
  const rows = keys.filter(key => key === removed || !pending.has(key));
  const index = rows.indexOf(removed);
  if (index === -1) return null;
  return rows[index + 1] ?? rows[index - 1] ?? null;
}

/**
 * Whether focus is still where a closing unfollow question leaves it, so the
 * unfollow may hand it on: on nothing (the page's `body`, or null, as when
 * the question's popup is removed with focus inside it), on the Unfollow
 * button of the row it asked about, or inside the question. Focus the reader
 * has moved anywhere else during the close, such as into the search palette,
 * stays there.
 */
export function focusLeftByQuestion<T extends { contains(other: T | null): boolean }>(
  focused: T | null,
  { body, rowButton, question }: { body: T | null; rowButton: T | undefined; question: T | null },
) {
  return focused === null || focused === body || focused === rowButton || (question?.contains(focused) ?? false);
}
