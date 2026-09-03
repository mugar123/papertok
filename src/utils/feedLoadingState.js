export const FEED_DISPLAY_STATES = Object.freeze({
  ERROR: 'error',
  FEED: 'feed',
  INITIAL_DISCOVERY: 'initial-discovery',
  SKELETON: 'skeleton',
  SOURCE_EMPTY: 'source-empty',
  EMPTY: 'empty',
});

export function getFeedDisplayState({
  hasPapers,
  loading,
  error,
  isRefreshing,
  showLoader,
  initialLoadPending,
  hasSourceEmptyState,
}) {
  if (error && !hasPapers) return FEED_DISPLAY_STATES.ERROR;
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
export function feedAtomVeilCopy({ displayState, loading, isRefreshing }) {
  if (displayState === FEED_DISPLAY_STATES.INITIAL_DISCOVERY) return 'discovery';
  if (displayState === FEED_DISPLAY_STATES.EMPTY && (loading || isRefreshing)) return 'gathering';
  return null;
}
