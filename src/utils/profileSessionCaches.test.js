import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWN_LISTS_FRESH_MS,
  followListKey,
  followRowProfileCache,
  followStatsCache,
  forgetFollowStats,
  forgetOwnLists,
  forgetOwnProfile,
  ownListsAreFresh,
  ownListsCache,
  readFollowList,
  rememberFollowList,
  rememberFollowStats,
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

/**
 * The follow counters and the follow lists. Both exist because a `count()`
 * aggregation is server-only and a closed sheet forgets everything: without a
 * seed, re-entering a profile you were just looking at paid the network again
 * and said so on screen.
 */

test('a counter is remembered per account, and one account never sees another', () => {
  rememberFollowStats('uid-g', { followers: { count: 43, capped: false } });
  rememberFollowStats('uid-h', { followers: { count: 2, capped: false } });

  assert.deepEqual(followStatsCache.get('uid-g').followers, { count: 43, capped: false });
  assert.deepEqual(followStatsCache.get('uid-h').followers, { count: 2, capped: false });
  assert.equal(followStatsCache.get('uid-unknown'), undefined);
  forgetFollowStats('uid-g');
  forgetFollowStats('uid-h');
});

test('each counter writes through on its own without wiping the other', () => {
  // The two aggregations are no longer awaited together, so the second to land
  // must fold into the first rather than replace the pair.
  rememberFollowStats('uid-i', { followers: { count: 43, capped: false } });
  rememberFollowStats('uid-i', { followed: { count: 7, capped: false } });

  assert.deepEqual(followStatsCache.get('uid-i'), {
    followers: { count: 43, capped: false },
    followed: { count: 7, capped: false },
  });
  forgetFollowStats('uid-i');
});

test('a failed read is never cached as a number', () => {
  // `{ count: null }` is the header's "this read failed" sentinel. Caching it
  // would turn one bad moment into a dash that outlives the moment.
  rememberFollowStats('uid-j', { followers: { count: 43, capped: false } });
  rememberFollowStats('uid-j', { followers: { count: null, capped: false } });

  assert.deepEqual(followStatsCache.get('uid-j').followers, { count: 43, capped: false });
  rememberFollowStats('uid-k', { followers: { count: null, capped: false } });
  assert.equal(followStatsCache.get('uid-k'), undefined, 'nothing worth keeping, nothing kept');
  forgetFollowStats('uid-j');
});

test('forgetting a profile takes its counters and both of its lists with it', () => {
  rememberFollowStats('uid-l', { followers: { count: 1, capped: false } });
  rememberFollowList('uid-l', 'followers', { rows: [{ uid: 'uid-m' }], cursor: null, hasMore: false });
  rememberFollowList('uid-l', 'following', { rows: [], cursor: null, hasMore: false });

  forgetOwnProfile('uid-l', 'someone');

  assert.equal(followStatsCache.get('uid-l'), undefined);
  assert.equal(readFollowList('uid-l', 'followers'), undefined);
  assert.equal(readFollowList('uid-l', 'following'), undefined);
});

test('the two tabs of a profile are separate entries, and so are two profiles', () => {
  rememberFollowList('uid-n', 'followers', { rows: [{ uid: 'a' }], cursor: null, hasMore: false });
  rememberFollowList('uid-n', 'following', { rows: [{ uid: 'b' }, { uid: 'c' }], cursor: null, hasMore: false });
  rememberFollowList('uid-o', 'followers', { rows: [], cursor: null, hasMore: false });

  assert.deepEqual(readFollowList('uid-n', 'followers').rows, [{ uid: 'a' }]);
  assert.deepEqual(readFollowList('uid-n', 'following').rows, [{ uid: 'b' }, { uid: 'c' }]);
  assert.deepEqual(readFollowList('uid-o', 'followers').rows, []);
  assert.equal(readFollowList('uid-o', 'following'), undefined, 'a tab never opened is not an empty tab');
  forgetFollowStats('uid-n');
  forgetFollowStats('uid-o');
});

test('a row profile that is confirmed gone is remembered as gone, not as unasked', () => {
  // The sheet renders those two very differently: `undefined` is a placeholder
  // row, `null` says the account is unavailable.
  followRowProfileCache.set('uid-p', null);
  assert.equal(followRowProfileCache.get('uid-p'), null);
  assert.equal(followRowProfileCache.get('uid-q'), undefined);
  followRowProfileCache.delete('uid-p');
});

test('rubbish is refused rather than cached by the follow slots too', () => {
  rememberFollowStats(null, { followers: { count: 3, capped: false } });
  rememberFollowStats('uid-r', null);
  rememberFollowList('uid-r', 'followers', { rows: 'not an array' });
  rememberFollowList(null, 'followers', { rows: [] });

  assert.equal(followStatsCache.get('uid-r'), undefined);
  assert.equal(readFollowList('uid-r', 'followers'), undefined);
  assert.equal(followListKey('uid-r', null), null);
});
