/**
 * The tab the follows settings open on, of `types` in tab order: the one a
 * link asked for (`location.state.followType`, such as the Explorer's
 * journal-limit toast), else the first the reader follows something in,
 * else the first.
 */
export function openingFollowType(types: readonly string[], requested: unknown, followedByType: Record<string, readonly unknown[] | undefined>) {
  return types.find(type => type === requested)
    || types.find(type => (followedByType[type]?.length ?? 0) > 0)
    || types[0];
}
