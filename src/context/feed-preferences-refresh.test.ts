import test from 'node:test';
import assert from 'node:assert/strict';
import { planPreferencesRefresh } from './feed-preferences-refresh.ts';

const reader = { signature: 'cs.LG', ready: true, onFeedRoute: true, restored: false };

test('a cold start whose first load was cancelled before it ran plans that load again, with the newest interests', () => {
  // The interests effect plans the first page; the account profile applies
  // before the 0 ms timer fires, so the cleanup cancels it and nothing was applied.
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null }), { action: 'load', coldMount: true });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null, signature: 'cs.AI|cs.LG' }), { action: 'load', coldMount: true });
  // Once the load ran, its interests are applied and a re-run loads nothing more.
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.AI|cs.LG', signature: 'cs.AI|cs.LG' }), { action: 'none' });
});

test('a cold start over the restored snapshot of these interests keeps it; changed interests replace the feed', () => {
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null, restored: true }), { action: 'keep-restored' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', signature: 'cs.AI', restored: true }), { action: 'load', coldMount: false });
});

test('no profile or no interests forgets what was applied; off the feed nothing is planned', () => {
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', ready: false }), { action: 'forget' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: 'cs.LG', signature: '' }), { action: 'forget' });
  assert.deepEqual(planPreferencesRefresh({ ...reader, applied: null, onFeedRoute: false }), { action: 'none' });
});
