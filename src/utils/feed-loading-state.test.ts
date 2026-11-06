import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DISPLAY_STATES, FEED_EMPTY, feedAtomVeilCopy, feedStatusText, feedTailState, firstLoadSettled, getFeedDisplayState, lastVisitOnFailedReset, nextPageStatusText, refreshEndBeat, refreshStatusText, type RefreshEnd, type RefreshWatch } from './feed-loading-state.ts';

const baseState = {
  hasPapers: false,
  loading: false,
  error: null,
  isRefreshing: false,
  showLoader: false,
  initialLoadPending: false,
  hasSourceEmptyState: false,
};

test('keeps the discovery screen through the initial pre-fetch gap and request', () => {
  assert.equal(
    getFeedDisplayState({ ...baseState, initialLoadPending: true }),
    FEED_DISPLAY_STATES.INITIAL_DISCOVERY,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, loading: true, initialLoadPending: true }),
    FEED_DISPLAY_STATES.INITIAL_DISCOVERY,
  );
});

test('preserves later empty-feed loading behavior', () => {
  assert.equal(
    getFeedDisplayState({ ...baseState, loading: true }),
    FEED_DISPLAY_STATES.SKELETON,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, loading: true, showLoader: true }),
    FEED_DISPLAY_STATES.EMPTY,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, loading: true, isRefreshing: true }),
    FEED_DISPLAY_STATES.EMPTY,
  );
});

test('keeps established priority for errors, cards, and source empty states', () => {
  assert.equal(
    getFeedDisplayState({ ...baseState, error: 'FEED_LOAD_FAILED', initialLoadPending: true }),
    FEED_DISPLAY_STATES.ERROR,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, hasPapers: true, loading: true }),
    FEED_DISPLAY_STATES.FEED,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, hasSourceEmptyState: true }),
    FEED_DISPLAY_STATES.SOURCE_EMPTY,
  );
});

test('a store with no papers for the reader\'s interests is the empty state, not the error', () => {
  assert.equal(
    getFeedDisplayState({ ...baseState, error: FEED_EMPTY }),
    FEED_DISPLAY_STATES.EMPTY,
  );
  assert.equal(
    getFeedDisplayState({ ...baseState, error: FEED_EMPTY, hasPapers: true }),
    FEED_DISPLAY_STATES.FEED,
  );
});

/**
 * The atom screen no longer swaps out for the cards in one frame: it stays up
 * as a veil over the feed and recedes as the first paper composes. This says
 * which copy the veil carries, and when there is no veil at all.
 */
test('the veil carries the discovery copy through the first load', () => {
  assert.equal(
    feedAtomVeilCopy({ displayState: FEED_DISPLAY_STATES.INITIAL_DISCOVERY, loading: true, isRefreshing: false }),
    'discovery',
  );
  assert.equal(
    feedAtomVeilCopy({ displayState: FEED_DISPLAY_STATES.INITIAL_DISCOVERY, loading: false, isRefreshing: false }),
    'discovery',
  );
});

test('the veil carries the gathering copy while an emptied feed is loading or refreshing', () => {
  assert.equal(
    feedAtomVeilCopy({ displayState: FEED_DISPLAY_STATES.EMPTY, loading: true, isRefreshing: false }),
    'gathering',
  );
  assert.equal(
    feedAtomVeilCopy({ displayState: FEED_DISPLAY_STATES.EMPTY, loading: false, isRefreshing: true }),
    'gathering',
  );
});

test('there is no veil over cards, a verdict, a skeleton or a source\'s own empty state', () => {
  for (const displayState of [
    FEED_DISPLAY_STATES.FEED,
    FEED_DISPLAY_STATES.ERROR,
    FEED_DISPLAY_STATES.SKELETON,
    FEED_DISPLAY_STATES.SOURCE_EMPTY,
  ]) {
    assert.equal(feedAtomVeilCopy({ displayState, loading: true, isRefreshing: true }), null, displayState);
  }
  // An empty feed that has stopped loading is a verdict with a retry, not a wait.
  assert.equal(feedAtomVeilCopy({ displayState: FEED_DISPLAY_STATES.EMPTY, loading: false, isRefreshing: false }), null);
});

test('a first load that failed is still the first wait, so its retry gets the veil', () => {
  const failed = { hasPapers: false, loadStarted: true, loading: false, error: 'FEED_LOAD_FAILED' };
  assert.equal(firstLoadSettled(failed), false);
  assert.equal(firstLoadSettled({ ...failed, error: null, loading: true }), false);
  assert.equal(
    getFeedDisplayState({ ...baseState, loading: true, initialLoadPending: !firstLoadSettled({ ...failed, error: null, loading: true }) }),
    FEED_DISPLAY_STATES.INITIAL_DISCOVERY,
  );
});

// ENG-116: the reader saw "Error loading papers" for the 2.5 s before the
// automatic retry, even when that retry then brought the papers.
test('a failed first load keeps the discovery screen while its automatic retry is due, and shows the error once none is', () => {
  const failed = { ...baseState, error: 'FEED_LOAD_FAILED', initialLoadPending: true };
  assert.equal(getFeedDisplayState({ ...failed, autoRetryPending: true }), FEED_DISPLAY_STATES.INITIAL_DISCOVERY);
  assert.equal(feedAtomVeilCopy({ displayState: getFeedDisplayState({ ...failed, autoRetryPending: true }), autoRetryPending: true }), 'discovery');
  assert.equal(getFeedDisplayState({ ...failed, autoRetryPending: false }), FEED_DISPLAY_STATES.ERROR);
  // An empty answer has no automatic retry, and stays the empty state.
  assert.equal(getFeedDisplayState({ ...baseState, error: FEED_EMPTY }), FEED_DISPLAY_STATES.EMPTY);
});

// A feed emptied for a reset, such as new interests with no snapshot, showed
// the error and its alert for the 2.5 s before its automatic retry too.
test('an emptied feed whose reset failed keeps its gathering wait while the automatic retry is due', () => {
  const failed = { ...baseState, error: 'FEED_LOAD_FAILED' };
  const waiting = getFeedDisplayState({ ...failed, autoRetryPending: true });
  assert.notEqual(waiting, FEED_DISPLAY_STATES.ERROR);
  assert.equal(feedAtomVeilCopy({ displayState: waiting, autoRetryPending: true }), 'gathering');
  // The retry itself, once the loader has been up, keeps the same wait.
  assert.equal(feedAtomVeilCopy({ displayState: getFeedDisplayState({ ...baseState, loading: true, showLoader: true }), loading: true }), 'gathering');
  assert.equal(getFeedDisplayState(failed), FEED_DISPLAY_STATES.ERROR);
});

test('the first wait ends with papers, or with a load that finished empty and clean', () => {
  assert.equal(firstLoadSettled({ hasPapers: true, loadStarted: false, loading: true, error: null }), true);
  assert.equal(firstLoadSettled({ hasPapers: false, loadStarted: true, loading: false, error: null }), true);
  assert.equal(firstLoadSettled({ hasPapers: false, loadStarted: false, loading: false, error: null }), false);
});

test('a first load the store answered with no papers is over: it is not retried', () => {
  assert.equal(firstLoadSettled({ hasPapers: false, loadStarted: true, loading: false, error: FEED_EMPTY }), true);
});

// PR #425 browser check: the first wait was spoken, if at all, as the tail's
// "Loading more papers…", wording for a next page.
test('the first wait is announced as loading papers, once, through its automatic retry', () => {
  const firstWait = (state: Parameters<typeof getFeedDisplayState>[0]) => feedStatusText({
    refreshStatus: '',
    veil: feedAtomVeilCopy({ displayState: getFeedDisplayState(state), ...state }) !== null,
  });
  const loadingFirst = { ...baseState, loading: true, initialLoadPending: true };
  const retryDue = { ...baseState, error: 'FEED_LOAD_FAILED', initialLoadPending: true, autoRetryPending: true };
  assert.equal(firstWait(loadingFirst), 'Loading papers…');
  assert.equal(firstWait(retryDue), firstWait(loadingFirst));
  assert.equal(firstWait({ ...baseState, error: 'FEED_LOAD_FAILED' }), '');
  assert.equal(firstWait({ ...baseState, hasPapers: true }), '');
  // An emptied feed reloading under the veil is a wait too.
  assert.equal(firstWait({ ...baseState, loading: true, showLoader: true }), 'Loading papers…');
});

// ENG-188: the last visit's cards stand in for a failed first load.
test('the last visit\'s cards say where they come from while the feed updates, and when it could not', () => {
  const shown = (lastVisit: Parameters<typeof feedStatusText>[0]['lastVisit']) => feedStatusText({ refreshStatus: '', veil: false, lastVisit });
  assert.equal(shown('updating'), 'These papers are from your last visit. The feed is updating.');
  assert.equal(shown('not-updated'), 'These papers are from your last visit. The feed could not update.');
  assert.equal(shown(null), '');
});

// A retry that failed under the last visit's cards was announced twice: by the
// feed's status and by the tail's "Could not load more papers.", though no
// next page was asked for.
test('under the last visit\'s cards a failed update is announced by the feed status alone, and the tail keeps Try again', () => {
  const failed = { loading: false, hasMore: true, error: 'FEED_LOAD_FAILED', hasPapers: true, autoRetryPending: false, resetFailed: false };
  assert.equal(feedTailState(failed), 'failed');
  assert.equal(nextPageStatusText({ loading: false, hasPapers: true, failed: true, lastVisit: 'not-updated' }), '');
  assert.equal(nextPageStatusText({ loading: false, hasPapers: true, failed: true, lastVisit: null }), 'Could not load more papers.');
});

// The last visit's cards were read only while an automatic retry was due, so
// a first load failing without one still showed the error screen.
test('a failed first load reads the last visit\'s cards with or without an automatic retry', () => {
  assert.deepEqual(lastVisitOnFailedReset({ nothingShown: true, retryDue: true, lastVisit: null }), { readSaved: true, shown: 'updating', kept: null });
  assert.deepEqual(lastVisitOnFailedReset({ nothingShown: true, retryDue: false, lastVisit: null }), { readSaved: true, shown: 'not-updated', kept: null });
  assert.equal(lastVisitOnFailedReset({ nothingShown: false, retryDue: false, lastVisit: null }).readSaved, false);
  assert.equal(lastVisitOnFailedReset({ nothingShown: false, retryDue: false, lastVisit: 'updating' }).kept, 'not-updated');
});

test('a refresh keeps its own words under the veil', () => {
  assert.equal(feedStatusText({ refreshStatus: 'Refreshing papers…', veil: true }), 'Refreshing papers…');
  assert.equal(feedStatusText({ refreshStatus: 'Papers updated', veil: false }), 'Papers updated');
});

// ENG-176: a Try again that failed put "Papers updated" in the status region,
// beside the "Error loading papers" alert. A refresh that failed over the
// cards said Updated on the pill, and then, once that was fixed, nothing.
test('a refresh that ends says whether it updated the papers', () => {
  const quiet = { isRefreshing: false, autoRetryPending: false, loading: false };
  const ended = (error: unknown) => refreshEndBeat({ ...quiet, watch: 'refreshing', error }).end;
  assert.equal(ended(null), 'updated');
  for (const error of ['FEED_LOAD_FAILED', 'FOLLOWING_LOAD_FAILED', FEED_EMPTY]) {
    assert.equal(ended(error), 'failed', error);
  }
  // Nothing ended: a refresh still running, or none at all.
  assert.deepEqual(refreshEndBeat({ ...quiet, watch: 'refreshing', isRefreshing: true, loading: true, error: 'FEED_LOAD_FAILED' }), { watch: 'refreshing', end: null });
  assert.deepEqual(refreshEndBeat({ ...quiet, watch: 'idle', isRefreshing: true, error: null }), { watch: 'refreshing', end: null });
  assert.deepEqual(refreshEndBeat({ ...quiet, watch: 'idle', error: null }), { watch: 'idle', end: null });

  const spoken = (error: unknown, hasPapers: boolean) => refreshStatusText({ isRefreshing: false, end: ended(error), hasPapers });
  assert.equal(spoken(null, true), 'Papers updated');
  assert.equal(spoken('FEED_LOAD_FAILED', true), 'Could not refresh papers');
  assert.equal(spoken('FOLLOWING_LOAD_FAILED', true), 'Could not refresh papers');
  // With no card left, the error's alert or the empty state says how it ended.
  assert.equal(spoken('FEED_LOAD_FAILED', false), '');
  assert.equal(spoken(null, false), '');
  // A beat whose time is up says nothing, and a new refresh says it is running.
  assert.equal(refreshStatusText({ isRefreshing: false, end: null, hasPapers: true }), '');
  assert.equal(refreshStatusText({ isRefreshing: true, end: 'failed', hasPapers: true }), 'Refreshing papers…');
});

// A refresh that failed over the cards on For You, with its automatic retry
// due, said "Not updated" and then the retry quietly brought the papers.
test('a refresh whose automatic retry is due ends with that retry', () => {
  const run = (steps: Array<{ isRefreshing: boolean; autoRetryPending: boolean; loading: boolean; error: unknown }>) => {
    let watch: RefreshWatch = 'idle';
    const ends: Array<RefreshEnd | null> = [];
    for (const step of steps) {
      const next = refreshEndBeat({ watch, ...step });
      watch = next.watch;
      ends.push(next.end);
    }
    return ends;
  };
  const failedWithRetryDue = [
    { isRefreshing: true, autoRetryPending: false, loading: true, error: null },
    // The refresh's load fails and schedules its retry; the spinner holds.
    { isRefreshing: true, autoRetryPending: true, loading: false, error: 'FEED_LOAD_FAILED' },
    // The refresh is over, the retry still due: no beat yet.
    { isRefreshing: false, autoRetryPending: true, loading: false, error: 'FEED_LOAD_FAILED' },
    // The retry runs.
    { isRefreshing: false, autoRetryPending: false, loading: true, error: null },
  ];
  assert.deepEqual(run([...failedWithRetryDue, { isRefreshing: false, autoRetryPending: false, loading: false, error: null }]), [null, null, null, null, 'updated']);
  assert.deepEqual(run([...failedWithRetryDue, { isRefreshing: false, autoRetryPending: false, loading: false, error: 'FEED_LOAD_FAILED' }]), [null, null, null, null, 'failed']);
  // A retry that started before the refresh's spinner stopped is still waited for.
  assert.deepEqual(run([
    { isRefreshing: true, autoRetryPending: true, loading: false, error: 'FEED_LOAD_FAILED' },
    { isRefreshing: true, autoRetryPending: false, loading: true, error: null },
    { isRefreshing: false, autoRetryPending: false, loading: true, error: null },
    { isRefreshing: false, autoRetryPending: false, loading: false, error: null },
  ]), [null, null, null, 'updated']);
  // Without a retry, a page loading after the refresh does not hold its beat.
  assert.deepEqual(run([
    { isRefreshing: true, autoRetryPending: false, loading: true, error: null },
    { isRefreshing: false, autoRetryPending: false, loading: true, error: null },
  ]), [null, 'updated']);
});

// Outside verifier on #436: a refresh brought new cards, its next page failed
// before the spinner stopped, and the pill said Not updated beside the tail's
// Try again for that one failed page.
test('a next page that fails during the refresh spinner is the tail’s, not the refresh’s', () => {
  let watch: RefreshWatch = 'idle';
  const ends: Array<RefreshEnd | null> = [];
  const failedPage = { isRefreshing: false, autoRetryPending: false, loading: false, error: 'FEED_LOAD_FAILED' };
  for (const step of [
    { isRefreshing: true, autoRetryPending: false, loading: true, error: null },
    // The refresh's load brings the cards; the spinner holds its 800 ms.
    { isRefreshing: true, autoRetryPending: false, loading: false, error: null },
    // The short first screen asks for its next page, which fails.
    { isRefreshing: true, autoRetryPending: false, loading: true, error: null },
    { ...failedPage, isRefreshing: true },
    failedPage,
  ]) {
    const next = refreshEndBeat({ watch, ...step });
    watch = next.watch;
    ends.push(next.end);
  }
  assert.deepEqual(ends, [null, null, null, null, 'updated']);
  assert.equal(refreshStatusText({ isRefreshing: false, end: 'updated', hasPapers: true }), 'Papers updated');
  assert.equal(feedTailState({ ...failedPage, hasMore: true, hasPapers: true, resetFailed: false }), 'failed');
  // The refresh's own load failing is still the refresh's failure.
  assert.deepEqual(refreshEndBeat({ watch: 'refreshing', isRefreshing: true, autoRetryPending: false, loading: false, error: 'FEED_LOAD_FAILED' }), { watch: 'failed', end: null });
  assert.deepEqual(refreshEndBeat({ watch: 'failed', isRefreshing: false, autoRetryPending: false, loading: false, error: null }), { watch: 'idle', end: 'failed' });
});

// A refresh that failed over cards also set the tail to its failure, so one
// failure said both "Could not refresh papers" and "Could not load more
// papers", and the tail's Try again asked for the old list's next page.
test('a refresh that fails over cards is reported by the pill alone, not the tail', () => {
  const refreshFailed = { isRefreshing: false, autoRetryPending: false, loading: false, error: 'FEED_LOAD_FAILED' };
  const { end } = refreshEndBeat({ watch: 'refreshing', ...refreshFailed });
  assert.equal(refreshStatusText({ isRefreshing: false, end, hasPapers: true }), 'Could not refresh papers');
  const tail = feedTailState({ ...refreshFailed, hasMore: true, hasPapers: true, resetFailed: true });
  assert.equal(tail, null);
  assert.equal(nextPageStatusText({ loading: false, hasPapers: true, failed: tail === 'failed' }), '');
});

test('the tail speaks of more papers only under papers already shown', () => {
  assert.equal(nextPageStatusText({ loading: true, hasPapers: false }), '');
  assert.equal(nextPageStatusText({ loading: true, hasPapers: true }), 'Loading more papers…');
  assert.equal(nextPageStatusText({ loading: false, hasPapers: true }), '');
});

// ENG-183: a failed next page removed the tail, and with the automatic
// retries paused, the reader sat on the last paper with nothing after it and
// nothing said for up to two minutes.
test('a load that fails under papers already shown keeps the tail, which says so and offers to try again', () => {
  const shown = { loading: false, hasMore: true, error: null, hasPapers: true, autoRetryPending: false, resetFailed: false };
  assert.equal(feedTailState({ ...shown, loading: true }), 'loading');
  assert.equal(feedTailState(shown), 'loading', 'mounted ahead of the next page');
  const failed = { ...shown, error: 'FEED_LOAD_FAILED' };
  assert.equal(feedTailState(failed), 'failed');
  assert.equal(nextPageStatusText({ loading: false, hasPapers: true, failed: true }), 'Could not load more papers.');
  assert.equal(feedTailState({ ...failed, loading: true }), 'loading', 'Try again, or a retry, is on its way');
});

test('the tail offers no retry when nothing more can come, nothing can be retried yet, or nothing is shown', () => {
  const failed = { loading: false, hasMore: true, error: 'FEED_LOAD_FAILED', hasPapers: true, autoRetryPending: false, resetFailed: false };
  assert.equal(feedTailState({ ...failed, hasMore: false }), null);
  assert.equal(feedTailState({ ...failed, error: null, hasMore: false }), null);
  // A failed refresh's automatic retry is the next load, and loadMore waits for it.
  assert.equal(feedTailState({ ...failed, autoRetryPending: true }), null);
  // Asking again for an answer with no papers gets the same answer.
  assert.equal(feedTailState({ ...failed, error: FEED_EMPTY }), null);
  // An empty feed's failure is the error screen, with its own Try again.
  assert.equal(feedTailState({ ...failed, hasPapers: false }), null);
});
