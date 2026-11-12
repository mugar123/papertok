import test from 'node:test';
import assert from 'node:assert/strict';
import type { CustomFeed } from '../../utils/custom-feeds.ts';
import { customFeedPageState, feedFirstLoadPending, gatheringSentence, loadingNotice, nextFeedOpen, nextLoadingNotice } from './custom-feed-page-state.ts';

const thesis: CustomFeed = { id: 'abcd1234', name: 'Thesis', order: 'newest', ingredients: [{ kind: 'keyword', query: 'graphene' }] };

test('the page waits for the feeds, says when they failed, and leaves an address no feed has', () => {
  assert.deepEqual(customFeedPageState('loading', [thesis], 'abcd1234'), { kind: 'loading' });
  assert.deepEqual(customFeedPageState('unavailable', [], 'abcd1234'), { kind: 'unavailable' });
  assert.deepEqual(customFeedPageState('ready', [thesis], 'other123'), { kind: 'missing' });
  assert.deepEqual(customFeedPageState('ready', [], undefined), { kind: 'missing' });
  assert.deepEqual(customFeedPageState('ready', [thesis], 'abcd1234'), { kind: 'feed', feed: thesis });
});

test('the first load is pending until the feeds answer and the first page comes back', () => {
  assert.equal(feedFirstLoadPending({ status: 'loading', hasPapers: false, emptyKind: null, error: null }), true);
  assert.equal(feedFirstLoadPending({ status: 'unavailable', hasPapers: false, emptyKind: null, error: null }), false);
  assert.equal(feedFirstLoadPending({ status: 'ready', hasPapers: false, emptyKind: null, error: null }), true);
  assert.equal(feedFirstLoadPending({ status: 'ready', hasPapers: true, emptyKind: null, error: null }), false);
  assert.equal(feedFirstLoadPending({ status: 'ready', hasPapers: false, emptyKind: 'nothing', error: null }), false);
  assert.equal(feedFirstLoadPending({ status: 'ready', hasPapers: false, emptyKind: 'gathering', error: null }), false);
  assert.equal(feedFirstLoadPending({ status: 'ready', hasPapers: false, emptyKind: null, error: new Error('offline') }), false);
});

test('the loading notice names the sources still loading', () => {
  const tail = 'New sources usually arrive within a few minutes, or overnight when many are added at once.';
  assert.equal(loadingNotice(['graphene']), `graphene is still loading. ${tail}`);
  assert.equal(loadingNotice(['graphene', 'Ada Lovelace']), `graphene and Ada Lovelace are still loading. ${tail}`);
  assert.equal(loadingNotice(['graphene', 'Ada Lovelace', 'Optics']), `graphene, Ada Lovelace, and Optics are still loading. ${tail}`);
  assert.equal(loadingNotice([]), null);
  assert.equal(gatheringSentence(['graphene']), `graphene is still loading. ${tail}`);
  assert.equal(gatheringSentence([]), `This feed's sources are still loading. ${tail}`);
});

test('the loading notice is shown once each time a feed starts loading sources', () => {
  // On arrival with sources loading.
  const first = nextLoadingNotice(null, 'abcd1234', ['graphene', 'Optics']);
  assert.equal(first.notice?.startsWith('graphene and Optics are still loading.'), true);
  assert.equal(first.notifiedFor, 'abcd1234');
  // The same feed still loading, or with fewer sources left: no second notice.
  assert.deepEqual(nextLoadingNotice('abcd1234', 'abcd1234', ['graphene', 'Optics']), { notifiedFor: 'abcd1234', notice: null });
  assert.deepEqual(nextLoadingNotice('abcd1234', 'abcd1234', ['Optics']), { notifiedFor: 'abcd1234', notice: null });
  // Everything arrived: the next time something is loading, it is said again.
  assert.deepEqual(nextLoadingNotice('abcd1234', 'abcd1234', []), { notifiedFor: null, notice: null });
  assert.equal(nextLoadingNotice(null, 'abcd1234', ['Lasers']).notice?.startsWith('Lasers is still loading.'), true);
  // Another feed is another notice.
  assert.equal(nextLoadingNotice('abcd1234', 'other123', ['Lasers']).notifiedFor, 'other123');
  assert.notEqual(nextLoadingNotice('abcd1234', 'other123', ['Lasers']).notice, null);
});

test('opening a feed is recorded once per visit, with its order and nothing that names it', () => {
  // Before the feeds answer there is nothing to record.
  assert.deepEqual(nextFeedOpen(null, null), { openedFor: null, event: null });
  const first = nextFeedOpen(null, thesis);
  assert.deepEqual(first, { openedFor: 'abcd1234', event: { feed_order: 'newest' } });
  // The same feed again (papers reloading, the feed edited to another order): nothing more.
  assert.deepEqual(nextFeedOpen('abcd1234', { ...thesis, order: 'best' }), { openedFor: 'abcd1234', event: null });
  // The feed briefly unknown keeps the visit it was on.
  assert.deepEqual(nextFeedOpen('abcd1234', null), { openedFor: 'abcd1234', event: null });
  // Another feed is another visit.
  assert.deepEqual(nextFeedOpen('abcd1234', { ...thesis, id: 'other123', order: 'best' }), { openedFor: 'other123', event: { feed_order: 'best' } });
});
