export const FEED_DISPLAY_STATES = Object.freeze({
  ERROR: 'error',
  FEED: 'feed',
  INITIAL_DISCOVERY: 'initial-discovery',
  SKELETON: 'skeleton',
  SOURCE_EMPTY: 'source-empty',
  EMPTY: 'empty',
});

/** The paper store answered with no papers for the reader's interests: not a failure to retry. */
export const FEED_EMPTY = 'FEED_EMPTY';

/** A failed first load is not over: its retry is still the first wait, under the veil. An empty answer is over. */
export function firstLoadSettled({ hasPapers, loadStarted, loading, error }: { hasPapers: boolean; loadStarted: boolean; loading: boolean; error: unknown }) {
  return hasPapers || (loadStarted && !loading && (!error || error === FEED_EMPTY));
}

export function getFeedDisplayState({ hasPapers, loading, error, isRefreshing, showLoader, initialLoadPending, hasSourceEmptyState }: { hasPapers?: boolean; loading?: boolean; error?: unknown; isRefreshing?: boolean; showLoader?: boolean; initialLoadPending?: boolean; hasSourceEmptyState?: boolean }) {
  if (error && error !== FEED_EMPTY && !hasPapers) return FEED_DISPLAY_STATES.ERROR;
  if (hasPapers) return FEED_DISPLAY_STATES.FEED;
  if (initialLoadPending) return FEED_DISPLAY_STATES.INITIAL_DISCOVERY;
  if (loading && !showLoader && !isRefreshing) return FEED_DISPLAY_STATES.SKELETON;
  if (hasSourceEmptyState && !loading && !isRefreshing) return FEED_DISPLAY_STATES.SOURCE_EMPTY;
  return FEED_DISPLAY_STATES.EMPTY;
}

/**
 * The copy the atom veil carries, or null when there is no veil.
 *
 * The veil is the loading screen kept over the feed's own container, so the
 * papers can compose under it while it recedes (FeedContainer). Two waits
 * show it: the first load, and an emptied feed that is still loading or being
 * refreshed. An empty feed that has stopped loading is a verdict with a retry,
 * not a wait, and gets no veil.
 */
export function feedAtomVeilCopy({ displayState, loading, isRefreshing }: { displayState?: string; loading?: boolean; isRefreshing?: boolean }) {
  if (displayState === FEED_DISPLAY_STATES.INITIAL_DISCOVERY) return 'discovery';
  if (displayState === FEED_DISPLAY_STATES.EMPTY && (loading || isRefreshing)) return 'gathering';
  return null;
}
