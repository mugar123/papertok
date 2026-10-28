/**
 * What the feed does when the reader's interests may have changed.
 *
 * `applied` is the signature of the interests the feed last acted on, or null
 * before it acted on any (a cold mount). The caller records `signature` as
 * applied when the plan takes effect: at once for 'keep-restored', and through
 * scheduleRefresh, when the load runs, for 'load'. A load cancelled before it ran (its
 * effect cleaned up because a dependency changed, such as the account profile
 * applying) leaves `applied` as it was, so the next run plans it again with the
 * newest interests. Recording it at schedule time lost the first page of a cold
 * start and left the reader on the loading veil with no request (ENG-116).
 */
type PreferencesRefresh =
  | { action: 'forget' }
  | { action: 'none' }
  | { action: 'keep-restored' }
  | { action: 'load'; coldMount: boolean };

export function planPreferencesRefresh({ applied, signature, ready, onFeedRoute, restored }: {
  applied: string | null;
  /** The sorted interests, '' when the reader has none. */
  signature: string;
  /** The account's recommendation profile is loaded. */
  ready: boolean;
  onFeedRoute: boolean;
  /** The feed on screen is the restored snapshot of this account and these interests. */
  restored: boolean;
}): PreferencesRefresh {
  if (!signature || !ready) return { action: 'forget' };
  // Off the feed route nothing is recorded, so preference edits made from
  // settings or onboarding are picked up as a change on the next visit to the
  // feed, and no source cascade fires for a feed nobody is looking at.
  if (!onFeedRoute || applied === signature) return { action: 'none' };
  const coldMount = applied === null;
  if (coldMount && restored) return { action: 'keep-restored' };
  return { action: 'load', coldMount };
}

/**
 * Runs `run` in a 0 ms timer and records `signature` in `applied` when the
 * timer fires, not when it is set. Returns the effect cleanup that clears it.
 *
 * A render between the two (the account profile applying, or another effect's
 * timer changing the papers and so loadPapers) runs the cleanup first. Nothing
 * is recorded then, so the effect's next run schedules the same work again.
 */
export function scheduleRefresh<T>(applied: { current: T }, signature: T, run: () => void): () => void {
  const timer = setTimeout(() => {
    applied.current = signature;
    run();
  }, 0);
  return () => clearTimeout(timer);
}
