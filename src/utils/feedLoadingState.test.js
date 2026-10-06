import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DISPLAY_STATES, feedAtomVeilCopy, getFeedDisplayState } from './feedLoadingState.js';

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
