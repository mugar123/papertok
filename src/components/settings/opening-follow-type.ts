/**
 * The tab the follows settings open on, of `types` in tab order: the first
 * the reader follows something in, else the first.
 */
export function openingFollowType(types: readonly string[], followedByType: Record<string, readonly unknown[] | undefined>) {
  return types.find(type => (followedByType[type]?.length ?? 0) > 0) || types[0];
}
