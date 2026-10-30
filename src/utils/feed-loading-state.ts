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

/**
 * `autoRetryPending`: the load failed and its one automatic retry is still
 * due. The feed is still waiting, so the error waits for the retry's verdict
 * (ENG-116): under the first wait when `initialLoadPending` says this is the
 * first load, under the emptied feed's wait otherwise.
 */
export function getFeedDisplayState({ hasPapers, loading, error, isRefreshing, showLoader, initialLoadPending, autoRetryPending, hasSourceEmptyState }: { hasPapers?: boolean; loading?: boolean; error?: unknown; isRefreshing?: boolean; showLoader?: boolean; initialLoadPending?: boolean; autoRetryPending?: boolean; hasSourceEmptyState?: boolean }) {
  if (error && error !== FEED_EMPTY && !hasPapers && !autoRetryPending) return FEED_DISPLAY_STATES.ERROR;
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
 * show it: the first load, and an emptied feed that is still loading, being
 * refreshed or waiting for its automatic retry. An empty feed that has stopped
 * loading is a verdict with a retry, not a wait, and gets no veil.
 */
export function feedAtomVeilCopy({ displayState, loading, isRefreshing, autoRetryPending }: { displayState?: string; loading?: boolean; isRefreshing?: boolean; autoRetryPending?: boolean }) {
  if (displayState === FEED_DISPLAY_STATES.INITIAL_DISCOVERY) return 'discovery';
  if (displayState === FEED_DISPLAY_STATES.EMPTY && (loading || isRefreshing || autoRetryPending)) return 'gathering';
  return null;
}

/**
 * What a screen reader hears from the feed's status region. Under the veil it
 * is "Loading papers…", whatever started the wait: a refresh that empties the
 * feed and the automatic retry after it are one wait, so it is spoken once
 * (and not at all while the focus is on the veil's heading: regionStatusText).
 * The veil's visible copy is in the page from its first frame, so it cannot
 * be the announcement. A refresh over shown papers has its own words while
 * its load runs (`loading`: the load that replaces the list, not a next
 * page). The refresh is held for a minimum time after its papers arrive
 * (refreshFeed), and saying it is still refreshing then would announce a wait
 * over cards already shown. "Papers updated" only when it ended with papers
 * and without a failure (`failed`: the load's error, or its automatic retry
 * still due): a refresh that fails keeps the old papers and has updated nothing.
 * Nor while a load that replaces the list runs: a refresh that timed out is
 * retried at once, inside the refresh's done hold, and nothing is updated yet.
 */
export function feedStatusText({ isRefreshing, loading, refreshDone, veil, hasPapers, failed }: { isRefreshing: boolean; loading: boolean; refreshDone: boolean; veil: boolean; hasPapers: boolean; failed: boolean }) {
  if (veil) return 'Loading papers…';
  if (isRefreshing && loading) return 'Refreshing papers…';
  return refreshDone && hasPapers && !failed && !loading ? 'Papers updated' : '';
}

/**
 * What the feed's status region is given now, or null to leave it as it is.
 * Nothing until the region has been in the page a moment (`regionReady`):
 * words that arrive with the region are not spoken. Empty while the focus is
 * on an element that already says it (the veil's heading, where a retry's
 * focus waits), so a keyboard reader hears the wait once.
 */
export function regionStatusText({ status, regionReady, focusSpeaks }: { status: string; regionReady: boolean; focusSpeaks: boolean }) {
  if (!regionReady) return null;
  return focusSpeaks ? '' : status;
}

/**
 * The feed tail's status: only for a next page (`loadingNextPage`), under
 * papers already shown. A load that replaces the list (a refresh, its
 * automatic retry, a follow change) is not more papers.
 */
export function nextPageStatusText({ loadingNextPage, hasPapers }: { loadingNextPage: boolean; hasPapers: boolean }) {
  return loadingNextPage && hasPapers ? 'Loading more papers…' : '';
}
