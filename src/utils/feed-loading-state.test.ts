import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DISPLAY_STATES, FEED_EMPTY, feedAtomVeilCopy, feedStatusText, firstLoadSettled, getFeedDisplayState, nextPageStatusText, regionStatusText } from './feed-loading-state.ts';

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
    isRefreshing: false,
    loading: Boolean(state.loading),
    refreshDone: false,
    veil: feedAtomVeilCopy({ displayState: getFeedDisplayState(state), ...state }) !== null,
    hasPapers: Boolean(state.hasPapers),
    failed: Boolean(state.error),
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

test('a refresh over shown papers is spoken as a refresh, and as updated once it lands', () => {
  const shown = { isRefreshing: false, loading: false, refreshDone: false, veil: false, hasPapers: true, failed: false };
  assert.equal(feedStatusText({ ...shown, isRefreshing: true, loading: true }), 'Refreshing papers…');
  assert.equal(feedStatusText({ ...shown, refreshDone: true }), 'Papers updated');
  assert.equal(feedStatusText(shown), '');
});

// PR #425 review: a retry that answered before the refresh's minimum 800 ms
// said "Refreshing papers…" over the cards it had already shown.
test('a refresh whose papers arrived does not speak a wait while it is held', () => {
  const steps = [
    // Try again from the error: the reload runs under the veil.
    { isRefreshing: true, loading: true, refreshDone: false, veil: true, hasPapers: false, failed: false },
    // Its papers are shown; the refresh is still held for its minimum time.
    { isRefreshing: true, loading: false, refreshDone: false, veil: false, hasPapers: true, failed: false },
    // The hold ends.
    { isRefreshing: false, loading: false, refreshDone: true, veil: false, hasPapers: true, failed: false },
  ];
  assert.deepEqual(steps.map(feedStatusText), ['Loading papers…', '', 'Papers updated']);
  // The same hold after a refresh over shown papers, and after one that failed.
  assert.equal(feedStatusText({ isRefreshing: true, loading: false, refreshDone: false, veil: false, hasPapers: true, failed: true }), '');
});

// Try again, Check again or Explore again from an empty feed: the wait they
// start, its automatic retry included, is one wait under the veil.
test('a refresh under the veil is the same wait as the retry that follows it', () => {
  const underVeil = { isRefreshing: true, loading: true, refreshDone: false, veil: true, hasPapers: false, failed: false };
  const retrying = { ...underVeil, isRefreshing: false, loading: false, refreshDone: true };
  assert.equal(feedStatusText(underVeil), 'Loading papers…');
  assert.equal(feedStatusText(retrying), feedStatusText(underVeil));
});

// A Try again that ends in the error again said "Papers updated" beside the
// alert "Error loading papers".
test('a refresh that ends without papers updated nothing', () => {
  const failed = getFeedDisplayState({ ...baseState, error: 'FEED_LOAD_FAILED' });
  assert.equal(failed, FEED_DISPLAY_STATES.ERROR);
  assert.equal(feedStatusText({ isRefreshing: false, loading: false, refreshDone: true, veil: feedAtomVeilCopy({ displayState: failed }) !== null, hasPapers: false, failed: true }), '');
});

// A refresh over shown papers that failed kept them, and still said "Papers updated".
test('a refresh over shown papers that fails updated nothing', () => {
  const shown = { isRefreshing: false, loading: false, refreshDone: true, veil: false, hasPapers: true };
  assert.equal(feedStatusText({ ...shown, failed: true }), '');
  assert.equal(feedStatusText({ ...shown, failed: false }), 'Papers updated');
});

test('the tail speaks of more papers only under papers already shown', () => {
  assert.equal(nextPageStatusText({ loadingNextPage: true, hasPapers: false }), '');
  assert.equal(nextPageStatusText({ loadingNextPage: true, hasPapers: true }), 'Loading more papers…');
  assert.equal(nextPageStatusText({ loadingNextPage: false, hasPapers: true }), '');
});

// A refresh over shown papers, its automatic retry and a follow change replace
// the list: the tail said "Loading more papers…" beside "Refreshing papers…".
test('a load that replaces shown papers is not spoken as more papers', () => {
  const refreshing = { loadingNextPage: false, hasPapers: true };
  assert.equal(nextPageStatusText(refreshing), '');
  assert.equal(feedStatusText({ isRefreshing: true, loading: true, refreshDone: false, veil: false, hasPapers: true, failed: false }), 'Refreshing papers…');
});

// The region was inserted empty and given "Loading papers…" one frame later,
// often too soon to be spoken; and a keyboard Try again heard the wait twice,
// from the focused veil heading and from the region.
test('the status region speaks once it has settled, and not over a focus that already says it', () => {
  assert.equal(regionStatusText({ status: 'Loading papers…', regionReady: false, focusSpeaks: false }), null);
  assert.equal(regionStatusText({ status: 'Loading papers…', regionReady: true, focusSpeaks: false }), 'Loading papers…');
  assert.equal(regionStatusText({ status: 'Loading papers…', regionReady: true, focusSpeaks: true }), '');
  // Once the focus has gone on to a card, the outcome is spoken.
  assert.equal(regionStatusText({ status: 'Papers updated', regionReady: true, focusSpeaks: false }), 'Papers updated');
});
