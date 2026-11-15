import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../../models/paper.ts';
import type { CustomFeed } from '../../utils/custom-feeds.ts';
import { customFeedPageState, feedFirstLoadPending, gatheringSentence, loadingNotice, nextFeedOpen, nextLoadingNotice, nextRefreshEnd, placeAfterRefresh } from './custom-feed-page-state.ts';

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

test('a refresh that found no unseen paper says so once as it ends, over the papers it shows again', () => {
  const settled = { isRefreshing: false, failed: false, hasPapers: true, walksUnseen: false };
  // No refresh seen: a feed opened from its top, or resumed, says nothing and keeps its place.
  assert.deepEqual(nextRefreshEnd(null, 'abcd1234', settled), { watchedFeed: null, replaced: false, notice: false });
  const refreshing = nextRefreshEnd(null, 'abcd1234', { ...settled, isRefreshing: true });
  assert.deepEqual(refreshing, { watchedFeed: 'abcd1234', replaced: false, notice: false });
  // It ends with nothing unseen: said, and not again on the next render.
  const ended = nextRefreshEnd(refreshing.watchedFeed, 'abcd1234', settled);
  assert.deepEqual(ended, { watchedFeed: null, replaced: true, notice: true });
  assert.deepEqual(nextRefreshEnd(ended.watchedFeed, 'abcd1234', settled), { watchedFeed: null, replaced: false, notice: false });
  // It brought unseen papers, or the feed has none to show: a new list, and nothing to explain.
  assert.deepEqual(nextRefreshEnd('abcd1234', 'abcd1234', { ...settled, walksUnseen: true }), { watchedFeed: null, replaced: true, notice: false });
  assert.deepEqual(nextRefreshEnd('abcd1234', 'abcd1234', { ...settled, hasPapers: false }), { watchedFeed: null, replaced: true, notice: false });
  // It failed: the list on screen is the one before it.
  assert.deepEqual(nextRefreshEnd('abcd1234', 'abcd1234', { ...settled, failed: true }), { watchedFeed: null, replaced: false, notice: false });
  // The reader went to another feed while it ran.
  assert.deepEqual(nextRefreshEnd('abcd1234', 'other123', settled), { watchedFeed: null, replaced: false, notice: false });
});

test('after a refresh the remembered place names the card at its position in the new list, and a place that is still right is kept', () => {
  const list = (...ids: string[]): Paper[] => ids.map(id => ({ id, title: id, abstract: '', authors: [], sources: { primary: 'arxiv', enrichedBy: [] } }));
  const refreshed = list('2611.00020', '2611.00021', '2611.00022');
  // The jump to the top was remembered while the old list was still shown.
  assert.deepEqual(placeAfterRefresh(refreshed, { scrollTop: 0, index: 0, paperId: '2611.00001' }), { scrollTop: 0, index: 0, paperId: '2611.00020' });
  // The reader scrolled to the third card while the refresh ran.
  assert.deepEqual(placeAfterRefresh(refreshed, { scrollTop: 1600, index: 2, paperId: '2611.00003' }), { scrollTop: 1600, index: 2, paperId: '2611.00022' });
  // The new list is shorter than the place: its last card, where the scroll stops. An empty one has no card.
  assert.deepEqual(placeAfterRefresh(refreshed, { scrollTop: 4000, index: 5, paperId: '2611.00006' }), { scrollTop: 4000, index: 2, paperId: '2611.00022' });
  assert.deepEqual(placeAfterRefresh([], { scrollTop: 4000, index: 5, paperId: '2611.00006' }), { scrollTop: 0, index: 0, paperId: null });
  // The refresh showed the same list again, or a scroll wrote the place since: nothing to change.
  assert.equal(placeAfterRefresh(refreshed, { scrollTop: 800, index: 1, paperId: '2611.00021' }), null);
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
