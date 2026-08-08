import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DISPLAY_STATES, getFeedDisplayState } from './feedLoadingState.js';

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
