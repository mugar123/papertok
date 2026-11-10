import test from 'node:test';
import assert from 'node:assert/strict';
import { recentCheckStatus, recentEmptyKind, settleRecentCheck } from './recent-feed-page-state.ts';

test('a reader with no topics is told so, even while a load is on its way', () => {
  assert.equal(recentEmptyKind({ hasTopics: false, hasPapers: false, loading: false, error: null }), 'no-topics');
  assert.equal(recentEmptyKind({ hasTopics: false, hasPapers: false, loading: true, error: null }), 'no-topics');
});

test('a list with topics that came back with nothing unseen is caught up', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, loading: false, error: null }), 'caught-up');
});

test('a failed list with no papers is an error', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, loading: false, error: new Error('offline') }), 'error');
});

test('nothing replaces the cards while a load is on its way or while there are cards', () => {
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: false, loading: true, error: null }), null);
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: true, loading: false, error: null }), null);
  assert.equal(recentEmptyKind({ hasTopics: true, hasPapers: true, loading: false, error: new Error('next page failed') }), null);
});

test('Check again stays asked while its load runs, and a check that found nothing says so', () => {
  assert.equal(settleRecentCheck('asked', { busy: true, hasPapers: false, error: null }), 'asked');
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: false, error: null }), 'none-new');
  assert.equal(recentCheckStatus('asked'), 'Checking for new papers…');
  assert.equal(recentCheckStatus('none-new'), 'No new papers yet.');
  assert.equal(recentCheckStatus('idle'), '');
});

test('a check that brought papers or failed is over', () => {
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: true, error: null }), 'idle');
  assert.equal(settleRecentCheck('asked', { busy: false, hasPapers: false, error: new Error('offline') }), 'idle');
});

test('a load that Check again did not start clears what the last check found', () => {
  assert.equal(settleRecentCheck('none-new', { busy: true, hasPapers: false, error: null }), 'idle');
  assert.equal(settleRecentCheck('none-new', { busy: false, hasPapers: false, error: null }), 'none-new');
  assert.equal(settleRecentCheck('idle', { busy: true, hasPapers: false, error: null }), 'idle');
});
