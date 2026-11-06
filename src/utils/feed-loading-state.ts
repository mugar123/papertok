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
 * Whether the feed shows the last visit's cards because its first load
 * failed (ENG-188): while its automatic retry runs ('updating'), after that
 * retry failed too ('not-updated'), or after the store answered with no new
 * papers ('no-new'). 'updated': a later load brought fresh papers below them.
 */
export type LastVisitStatus = 'updating' | 'not-updated' | 'no-new' | 'updated' | null;

/**
 * The last visit's status with the date its cards were saved (`savedAt`),
 * kept while those cards are all the feed shows. A refresh empties the feed's
 * cache, not this: a later load that brings no new card saves them under
 * their original date, so after a reload they still carry the note and
 * expire three days after that date.
 */
export interface LastVisit { status: LastVisitStatus; savedAt?: number }

const LAST_VISIT_STATUS = {
  updating: 'These papers are from your last visit. The feed is updating.',
  'not-updated': 'These papers are from your last visit. The feed could not update.',
  'no-new': 'These papers are from your last visit. There are no new papers yet.',
  updated: 'Papers updated',
  none: '',
};

/** Whether the list is still only the last visit's cards. */
export function showsLastVisit(lastVisit: LastVisitStatus) {
  return lastVisit === 'updating' || lastVisit === 'not-updated' || lastVisit === 'no-new';
}

/**
 * The visible note above the last visit's cards: the status region's words,
 * shown, so a sighted reader also knows the cards may be days old.
 */
export function lastVisitNote(lastVisit: LastVisitStatus) {
  return lastVisit && showsLastVisit(lastVisit) ? LAST_VISIT_STATUS[lastVisit] : '';
}

/**
 * The last visit's status after a load that succeeded: fresh papers end it
 * with "Papers updated", and an answer with none says there are no new ones
 * and keeps the cards' saved date.
 */
export function lastVisitAfterLoad(lastVisit: LastVisit, added: boolean): LastVisit {
  if (!showsLastVisit(lastVisit.status)) return lastVisit;
  return added ? { status: 'updated' } : { status: 'no-new', savedAt: lastVisit.savedAt };
}

/**
 * What a screen reader hears from the feed's status region: a refresh's own
 * words, and "Loading papers…" under the veil otherwise. The veil's visible
 * copy is in the page from its first frame, so it cannot be the announcement.
 * One text through the veil's whole wait, its automatic retry included, so
 * the wait is spoken once.
 */
export function feedStatusText({ refreshStatus, veil, lastVisit = null }: { refreshStatus: string; veil: boolean; lastVisit?: LastVisitStatus }) {
  return refreshStatus || (veil ? 'Loading papers…' : '') || LAST_VISIT_STATUS[lastVisit ?? 'none'];
}

/**
 * What a failed reset does with the last visit's cards (ENG-188). With
 * nothing on screen it reads them, whether or not an automatic retry is due:
 * 'updating' while that retry runs, 'not-updated' without one. Over cards
 * already shown, the last visit's cards stay and could not update. An empty
 * answer (FEED_EMPTY) is not a failure to update: the store answered, with
 * nothing new, so it keeps its own empty state, and over the last visit's
 * cards says there are no new papers. Kept cards keep their saved date.
 */
export function lastVisitOnFailedReset({ nothingShown, retryDue, lastVisit, error }: { nothingShown: boolean; retryDue: boolean; lastVisit: LastVisit; error?: string | null }) {
  const shown: LastVisitStatus = retryDue ? 'updating' : 'not-updated';
  const kept: LastVisit = !showsLastVisit(lastVisit.status)
    ? { status: null }
    : { status: error === FEED_EMPTY ? 'no-new' : 'not-updated', savedAt: lastVisit.savedAt };
  return { readSaved: nothingShown && error !== FEED_EMPTY, shown, kept };
}

/** How a refresh ended: it brought the papers, or it failed over them. */
export type RefreshEnd = 'updated' | 'failed';

/**
 * What the pill waits for: nothing, a refresh, or the automatic retry of a
 * refresh that failed. `updated` and `failed` hold how the refresh's own load
 * ended while its spinner still runs.
 */
export type RefreshWatch = 'idle' | 'refreshing' | 'retrying' | RefreshEnd;

/**
 * One step of a refresh's watch, and the beat it earns as it ends: Updated or
 * Not updated on the pill, and the status region's words for it. A refresh
 * whose failure has its automatic retry due ends with that retry, so a
 * failure the retry repairs is never announced. `error` is read as the
 * refresh's own load ends: a next page that loads and fails before the
 * spinner stops is not the refresh, and its tail says so. Without a load
 * seen to end, the error at the spinner's end decides. Any error is a
 * failure, the store's empty answer (`FEED_EMPTY`) included: none of them
 * brought papers (ENG-176).
 */
export function refreshEndBeat({ watch, isRefreshing, autoRetryPending, loading, error }: { watch: RefreshWatch; isRefreshing: boolean; autoRetryPending: boolean; loading: boolean; error: unknown }): { watch: RefreshWatch; end: RefreshEnd | null } {
  const settled = watch === 'updated' || watch === 'failed';
  const outcome: RefreshEnd = error ? 'failed' : 'updated';
  if (!isRefreshing && watch === 'idle') return { watch, end: null };
  if (autoRetryPending || (watch === 'retrying' && (isRefreshing || loading))) return { watch: 'retrying', end: null };
  if (isRefreshing) {
    if (settled) return { watch, end: null };
    return { watch: watch === 'refreshing' && !loading ? outcome : 'refreshing', end: null };
  }
  return { watch: 'idle', end: settled ? watch : outcome };
}

/**
 * What the status region says of a refresh. Its end is spoken only over
 * cards: with none, the error's alert or the empty state says how it ended,
 * and "Papers updated" beside either would be false (ENG-176).
 */
export function refreshStatusText({ isRefreshing, end, hasPapers }: { isRefreshing: boolean; end: RefreshEnd | null; hasPapers: boolean }) {
  if (isRefreshing) return 'Refreshing papers…';
  if (!end || !hasPapers) return '';
  return end === 'updated' ? 'Papers updated' : 'Could not refresh papers';
}

/**
 * What the slot at the end of the feed holds: `loading` while a page is on its
 * way or more can come, `failed` once a load failed under papers already
 * shown, and null when nothing more can come. A failed load used to remove
 * the slot, so the reader sat on the last paper with nothing after it and
 * nothing said until the next attempt (ENG-183). The slot stays out while a
 * refresh's automatic retry is due, since that retry is the next load, and
 * after an answer with no papers, which asking again does not change. A
 * failed refresh (`resetFailed`) is the pill's to report, and its Try again
 * would ask for the old list's next page: the slot stays out then too (ENG-176).
 */
export function feedTailState({ loading, hasMore, error, hasPapers, autoRetryPending, resetFailed }: { loading: boolean; hasMore: boolean; error: unknown; hasPapers: boolean; autoRetryPending: boolean; resetFailed: boolean }) {
  if (loading || (hasMore && !error)) return 'loading';
  return hasMore && hasPapers && error !== FEED_EMPTY && !autoRetryPending && !resetFailed ? 'failed' : null;
}

/**
 * The feed tail's status: only for a next page, under papers already shown.
 * `retrying`: the load is an automatic retry of a failed page. It keeps the
 * failure's words, so a long outage announces its state once, not at every
 * attempt as "loading" and "could not load" alternate. Under the last visit's
 * cards a failed load is the first load's, and the feed's status already says
 * the feed could not update (ENG-188), until the reader asks again with Try
 * again (`asked`): that attempt's failure is the tail's to say.
 */
export function nextPageStatusText({ loading, hasPapers, failed = false, retrying = false, lastVisit = null, asked = false }: { loading: boolean; hasPapers: boolean; failed?: boolean; retrying?: boolean; lastVisit?: LastVisitStatus; asked?: boolean }) {
  if (failed || (loading && retrying && hasPapers)) return lastVisit === 'not-updated' && !asked ? '' : 'Could not load more papers.';
  return loading && hasPapers ? 'Loading more papers…' : '';
}
