/**
 * Which row's Unfollow button takes focus when the row keyed `removed`
 * leaves the follows list, whose rows are `keys` in order: the next row, or
 * the previous one when it was the last. The row's own button leaves with
 * it, and focus left there would fall to the page (ENG-170). Null when no
 * other row stays, or the row is not in the list, and focus goes to the
 * type control above the list instead.
 */
export function focusAfterUnfollow(keys: readonly string[], removed: string): string | null {
  const index = keys.indexOf(removed);
  if (index === -1) return null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}
