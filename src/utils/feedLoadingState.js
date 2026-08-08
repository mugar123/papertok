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
