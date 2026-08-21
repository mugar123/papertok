import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWN_LISTS_FRESH_MS,
  forgetOwnLists,
  ownListsAreFresh,
  ownListsCache,
  rememberOwnLists,
  reviseOwnLists,
} from './profileSessionCaches.js';

/**
 * The freshness window on the lists read. Saving fifty papers in a row opened
 * the save modal fifty times and re-read all sixty list documents each time,
 * which is what saturated into an endless skeleton.
 */

test('a lists read just taken is fresh, and an unknown account never is', () => {
  const now = 1_000_000;
  rememberOwnLists('uid-a', [{ id: 'l1', paperIds: [] }]);
  assert.equal(ownListsAreFresh('uid-a', now + 1), true);
  assert.equal(ownListsAreFresh('uid-b', now), false, 'nothing cached, nothing to trust');
  assert.equal(ownListsAreFresh(null, now), false);
  forgetOwnLists('uid-a');
});

test('freshness expires, and the read happens again', () => {
  rememberOwnLists('uid-c', [{ id: 'l1' }]);
  const readAt = Date.now();
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS - 1), true);
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS), false, 'the window is exclusive');
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS + 5_000), false);
  forgetOwnLists('uid-c');
});

test('a write-through updates the lists WITHOUT pretending they were re-read', () => {
  // Otherwise every save would renew the window and the lists could go stale
  // for as long as somebody kept saving.
  rememberOwnLists('uid-d', [{ id: 'l1', paperIds: [] }]);
  const readAt = Date.now();
  reviseOwnLists('uid-d', [{ id: 'l1', paperIds: ['p1'] }]);

  assert.deepEqual(ownListsCache.get('uid-d'), [{ id: 'l1', paperIds: ['p1'] }]);
  assert.equal(ownListsAreFresh('uid-d', readAt + OWN_LISTS_FRESH_MS + 1), false,
    'the clock still runs from the last real read');
  forgetOwnLists('uid-d');
});

test('forgetting an account leaves nothing behind for the next one', () => {
  rememberOwnLists('uid-e', [{ id: 'l1' }]);
  forgetOwnLists('uid-e');
  assert.equal(ownListsCache.get('uid-e'), undefined);
  assert.equal(ownListsAreFresh('uid-e', Date.now()), false);
});

test('rubbish is refused rather than cached', () => {
  rememberOwnLists('uid-f', null);
  rememberOwnLists(null, [{ id: 'l1' }]);
  assert.equal(ownListsCache.get('uid-f'), undefined);
  assert.equal(ownListsAreFresh('uid-f', Date.now()), false);
});
