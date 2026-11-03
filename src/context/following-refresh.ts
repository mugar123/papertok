/**
 * Which Following refresh owns the loading indicator.
 *
 * A response that lands after the follows changed is dropped
 * (`isCurrentFollowingRequest`), but its `finally` used to clear the loading
 * and refreshing flags by account alone. With a newer refresh still on its
 * way, the old one's end read as that refresh succeeding: the feed said
 * "Papers updated", and said nothing when the newer one then failed. Each
 * refresh takes a turn as it starts, and only the latest turn ends the
 * indicator. When no newer refresh starts (the follows went to none, or a
 * fresh cache answers for them), the older one is still the latest turn and
 * ends it.
 */
export function followingRefreshTurns() {
  let latest = 0;
  return {
    take() {
      const turn = ++latest;
      return () => turn === latest;
    },
  };
}

/** Waits for one refresh and hands its answer on, as the provider applies it. */
export async function settleFollowingRefresh<T>(request: Promise<T>, handlers: {
  /** True while the request still answers for the account and follows on screen. */
  isCurrent: () => boolean;
  /** True while this refresh holds the latest turn (`followingRefreshTurns`). */
  ownsTurn: () => boolean;
  apply: (result: T) => void;
  fail: (error: unknown) => void;
  endLoading: () => void;
}) {
  try {
    const result = await request;
    if (handlers.isCurrent()) handlers.apply(result);
  } catch (error) {
    if (handlers.isCurrent()) handlers.fail(error);
  } finally {
    if (handlers.ownsTurn()) handlers.endLoading();
  }
}
