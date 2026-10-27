import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DISPLAY_STATES, FEED_EMPTY, feedAtomVeilCopy, firstLoadSettled, getFeedDisplayState } from './feed-loading-state.ts';

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
