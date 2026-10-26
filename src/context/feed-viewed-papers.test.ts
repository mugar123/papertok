import test from 'node:test';
import assert from 'node:assert/strict';
import { addViewedPapers, leavesLoadedAccount, markSeenLatest, recordCardView, seenPapersForAccount } from './feed-viewed-papers.ts';
import { clearUserScopedStorage, readSeenPaperIds, saveSeenPaperIds } from '../utils/user-scoped-storage.ts';
import { MAX_VIEWED_IDS, createEmptyInteractionProfile, deserializeInteractionProfile, recordInteractionEvent, serializeInteractionProfile } from '../utils/interaction-profile.ts';
import { feedSeenFilter, feedSeenIds, hasSeenPaper, readFeedSeenFilter } from '../utils/seen-paper-filter.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test('a card viewed by the signed-in account joins its viewed list, last viewed at the end', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  const account = { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen };
  recordCardView('p1', 'account-a', account, storage);
  recordCardView('p2', 'account-a', account, storage);
  recordCardView('p1', 'account-a', account, storage);
  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['p2', 'p1']);
  assert.deepEqual([...sessionSeen], ['p2', 'p1']);
});

test('a card that reports after the feed switched to another account counts for neither', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('before', 'account-a', { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen }, storage);
  // The feed now belongs to B; A's last card still reports, as A's.
  recordCardView('late-card', 'account-a', { activeUserId: 'account-b', signedInUid: 'account-b', sessionSeen }, storage);

  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['before']);
  assert.deepEqual([...readSeenPaperIds('account-b', storage)], []);
  assert.equal(sessionSeen.has('late-card'), false);
});

test('a card that reports while signing out does not write the swept list back', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('before', 'account-a', { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen }, storage);
  clearUserScopedStorage('account-a', storage);
  // Firebase names nobody; the feed's account effect has not run yet.
  recordCardView('on-screen-at-sign-out', 'account-a', { activeUserId: 'account-a', signedInUid: undefined, sessionSeen }, storage);

  assert.equal(storage.getItem('papertok_viewedIds:account-a'), null);
  assert.equal(storage.length, 0);
});

test('a guest view is remembered for the session only', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('guest-paper', undefined, { activeUserId: null, signedInUid: undefined, sessionSeen }, storage);
  assert.deepEqual([...sessionSeen], ['guest-paper']);
  assert.equal(storage.length, 0);
});

test('switching from A to B starts from B\'s viewed list and leaves A\'s for when A returns', () => {
  const storage = memoryStorage();
  saveSeenPaperIds('account-a', ['a-viewed'], storage);
  saveSeenPaperIds('account-b', ['b-viewed'], storage);

  assert.deepEqual([...seenPapersForAccount('account-b', storage)], ['b-viewed']);
  assert.deepEqual([...seenPapersForAccount(null, storage)], []);
  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['a-viewed']);
});

test('an account\'s first load starts from the list this browser kept before the release', () => {
  const storage = memoryStorage();
  storage.setItem('papertok_seenIds:account-b', JSON.stringify(['b-before-release']));
  assert.deepEqual([...seenPapersForAccount('account-b', storage)], ['b-before-release']);
  assert.equal(storage.getItem('papertok_seenIds:account-b'), null);
});

// The corpus offers a reader's unseen notable papers in one fixed order. Had
// a viewed notable card left the seen set with the 500-id viewed ring, the
// corpus would offer it again before any the reader never saw: in the
// re-review's probe, 100 notable places showed 34 distinct papers.
test('a notable card the reader viewed is in the seen set the next load starts from, however many cards they viewed after it', () => {
  const storage = memoryStorage();
  const account = { activeUserId: 'test-user', signedInUid: 'test-user', sessionSeen: new Set<string>() };
  const aggregate = createEmptyInteractionProfile();
  // A card's dwell, as trackViewTime reports it: to this browser's list and to the account's aggregate.
  const view = (paperId: string, notable = false) => {
    recordCardView(paperId, 'test-user', account, storage);
    recordInteractionEvent(aggregate, { paperId, kind: 'viewTime', category: 'cs.AI', viewTime: 4, notable });
  };
  view('notable-viewed', true);
  for (let index = 0; index < MAX_VIEWED_IDS; index += 1) view(`viewed-after-${index}`);

  // The next load: what this browser kept, and what the stored aggregate carries over.
  const seen = seenPapersForAccount('test-user', storage);
  assert.equal(seen.has('notable-viewed'), false, "this browser's list keeps the last 500");
  addViewedPapers(seen, deserializeInteractionProfile(serializeInteractionProfile(aggregate))!);
  assert.equal(seen.has('notable-viewed'), true, 'the corpus is told the reader saw it');
});

// A feed request to a Worker that skips seen papers tells it about the 2,000
// papers the set lists last (feedSeenIds), so the set has to list them oldest first.
test('the papers an account viewed on any device join the seen set oldest first, ahead of the pages loaded since', () => {
  const storage = memoryStorage();
  const account = { activeUserId: 'test-user', signedInUid: 'test-user', sessionSeen: new Set<string>() };
  const aggregate = createEmptyInteractionProfile();
  const viewed = (paperId: string, notable = false) => recordInteractionEvent(aggregate, { paperId, kind: 'viewTime', category: 'cs.AI', viewTime: 4, notable });
  // On another device: 1,200 notable cards, then 500 ordinary ones, oldest first.
  const earlier = Array.from({ length: 1_200 }, (_, index) => `notable-${index}`);
  const recent = Array.from({ length: 500 }, (_, index) => `recent-${index}`);
  earlier.forEach(paperId => viewed(paperId, true));
  recent.forEach(paperId => viewed(paperId));
  // On this browser, the last 500 are already in its list.
  recent.forEach(paperId => recordCardView(paperId, 'test-user', account, storage));

  // The profile arrives after the first page loaded.
  const session = Array.from({ length: 600 }, (_, index) => `session-${index}`);
  const seen = seenPapersForAccount('test-user', storage);
  seen.add(session[0]);
  addViewedPapers(seen, deserializeInteractionProfile(serializeInteractionProfile(aggregate))!);
  assert.deepEqual([...seen], [...earlier, ...recent, session[0]]);

  // A long session then fills the filter past what it holds: the oldest views leave it, the newest stay.
  session.slice(1).forEach(paperId => seen.add(paperId));
  const filter = readFeedSeenFilter(feedSeenFilter(feedSeenIds(seen, true)));
  assert.ok([...recent, ...session].every(paperId => hasSeenPaper(filter, paperId)), 'the newest views and the session are held');
  assert.ok(earlier.slice(300).every(paperId => hasSeenPaper(filter, paperId)), 'so are the notable cards after the 300 oldest');
  const forgotten = earlier.slice(0, 300).filter(paperId => hasSeenPaper(filter, paperId)).length;
  assert.ok(forgotten <= 9, `${forgotten} of the 300 oldest notable cards are still held; only false positives may be`);
});

// The corpus sends a paper the request does not hold as unseen. The app passes
// it over (FeedContext.loadPapers), or views it when it is a notable card, and
// the next request must hold it, or the corpus sends it again on every page.
test('a paper seen before the 2,000 most recent that a page brings back is held by the next request', () => {
  const later = Array.from({ length: 2_000 }, (_, index) => `later-${index}`);
  const sessionSeen = new Set(['passed-over', 'notable-viewed', ...later]);
  assert.equal(feedSeenIds(sessionSeen, true).includes('passed-over'), false, 'the request left it out');

  markSeenLatest(sessionSeen, 'passed-over');
  recordCardView('notable-viewed', 'test-user', { activeUserId: 'test-user', signedInUid: 'test-user', sessionSeen }, memoryStorage());
  assert.deepEqual(feedSeenIds(sessionSeen, true).slice(-2), ['passed-over', 'notable-viewed']);
  const filter = readFeedSeenFilter(feedSeenFilter(feedSeenIds(sessionSeen, true)));
  assert.ok(hasSeenPaper(filter, 'passed-over') && hasSeenPaper(filter, 'notable-viewed'));
  assert.equal(sessionSeen.size, 2_002, 'each paper is listed once');
});

test('the previous account\'s papers are cleared on a switch or a sign-out, not on a reload of the same account', () => {
  assert.equal(leavesLoadedAccount('account-a', 'account-b'), true);
  assert.equal(leavesLoadedAccount('account-a', null), true);
  assert.equal(leavesLoadedAccount('account-a', 'account-a'), false);
  // Nothing loaded yet: a profile that failed to load leaves the sets alone.
  assert.equal(leavesLoadedAccount(null, 'account-b'), false);
});
