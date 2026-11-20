import test from 'node:test';
import assert from 'node:assert/strict';
import { recentCheckStatus, recentEmptyKind, settleRecentCheck } from './recent-feed-page-state.ts';

test('a reader with no topics is told so, even while a load is on its way', () => {
  assert.equal(recentEmptyKind({ hasTopics: false, hasPapers: false, hasMore: false, loading: false, error: null }), 'no-topics');
  assert.equal(recentEmptyKind({ hasTopics: false, hasPapers: false, hasMore: false, loading: true, error: null }), 'no-topics');
});

test('a list with topics that came back with nothing unseen is caught up', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: false, loading: false, error: null }), 'caught-up');
});

test('a list that stopped asking by itself while it has more is not caught up: it offers the older papers', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: true, loading: false, error: null }), 'more');
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: true, loading: true, error: null }), null);
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: true, loading: false, error: new Error('offline') }), 'error');
});

test('a failed list with no papers is an error', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: false, loading: false, error: new Error('offline') }), 'error');
});

test('nothing replaces the cards while a load is on its way or while there are cards', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, hasMore: false, loading: true, error: null }), null);
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: true, hasMore: false, loading: false, error: null }), null);
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: true, hasMore: true, loading: false, error: new Error('next page failed') }), null);
});

test('Check again stays asked while its load runs, and a check that found nothing says so', () => {
  assert.equal(settleRecentCheck('asked', { busy: true, hasPapers: false, error: null }), 'asked');
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: false, error: null }), 'none-new');
  assert.equal(recentCheckStatus('asked'), 'Checking for new papers…');
  assert.equal(recentCheckStatus('none-new'), 'No new papers yet.');
  assert.equal(recentCheckStatus('idle'), '');
});

test('Show older papers stays asked while its pages load, and says when they held nothing new either', () => {
  assert.equal(settleRecentCheck('asked-older', { busy: true, hasPapers: false, error: null }), 'asked-older');
  assert.equal(settleRecentCheck('asked-older', { busy: false, hasPapers: false, error: null }), 'none-older');
  assert.equal(recentCheckStatus('asked-older'), 'Loading older papers…');
  assert.equal(recentCheckStatus('none-older'), 'Those were not new to you either.');
});

test('a check that brought papers or failed is over', () => {
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: true, error: null }), 'idle');
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: false, error: new Error('offline') }), 'idle');
  assert.equal(settleRecentCheck('asked-older', { busy: false, hasPapers: true, error: null }), 'idle');
  assert.equal(settleRecentCheck('asked-older', { busy: false, hasPapers: false, error: new Error('offline') }), 'idle');
});

test('a load that Check again did not start clears what the last check found', () => {
  assert.equal(settleRecentCheck('none-new', { busy: true, hasPapers: false, error: null }), 'idle');
  assert.equal(settleRecentCheck('none-new', { busy: false, hasPapers: false, error: null }), 'none-new');
  assert.equal(settleRecentCheck('none-older', { busy: true, hasPapers: false, error: null }), 'idle');
  assert.equal(settleRecentCheck('none-older', { busy: false, hasPapers: false, error: null }), 'none-older');
  assert.equal(settleRecentCheck('idle', { busy: true, hasPapers: false, error: null }), 'idle');
});
