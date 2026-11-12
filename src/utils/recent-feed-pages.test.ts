import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import type { FeedPlan } from '../context/feed-corpus-requests.ts';
import type { CustomFeedPages } from './custom-feed-pages.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import {
  recentPageRequest,
  recentPagesKey,
  recentRunFor,
  recentScrollKey,
  recentSeenIds,
  settleRecentPage,
  startsNewRecentList,
  type RecentRun,
} from './recent-feed-pages.ts';
import { createSessionCache } from './session-cache.ts';

const plan = (groups: FeedPlan['groups']): FeedPlan => ({
  groups,
  unassignedPositiveIds: ['unassigned-like'],
  positiveIds: ['group-like', 'unassigned-like'],
  dormantCategories: [],
  interestProgress: {},
  coldAdded: [],
});

const twoGroups = plan([
  { categories: ['cs.AI', 'cs.LG'], exampleCategories: ['cs.AI'], positiveIds: ['group-like'], weight: 0.6 },
  { categories: ['q-bio.NC'], exampleCategories: [], positiveIds: [], weight: 0.4 },
]);

const run = (overrides: Partial<RecentRun> = {}): RecentRun => ({
  plan: twoGroups,
  negativeIds: ['rejected'],
  excludedIds: ['liked'],
  received: [],
  walk: 'run-1',
  ...overrides,
});

const papers = (prefix: string, count: number) => Array.from({ length: count }, (_, n) => ({ id: `${prefix}-${n}` }) as Paper);
const ids = (list: Paper[]) => list.map(paper => paper.id);

test('a Most recent page asks for the reader\'s groups by day, with nothing For you adds', () => {
  const request = recentPageRequest(run(), 2, ['seen-a', 'seen-b']);
  assert.ok(request);
  assert.equal(request.order, 'daily');
  assert.equal(request.pageSize, 15);
  assert.equal(request.page, 2);
  assert.deepEqual(request.groups, twoGroups.groups);
  assert.deepEqual(request.positiveIds, ['unassigned-like']);
  assert.deepEqual(request.negativeIds, ['rejected']);
  assert.deepEqual(request.excludedIds, ['liked']);
  assert.deepEqual([...(request.seen ?? [])], ['seen-a', 'seen-b']);
  assert.equal(request.walk, 'run-1', 'the page names its run');
  for (const key of ['notable', 'continues', 'follows', 'categories', 'exact', 'areas']) {
    assert.equal(key in request, false, `the request carries no ${key}`);
  }
});

test('a reader with no interest groups asks for nothing', () => {
  assert.equal(recentPageRequest(run({ plan: plan([]) }), 0, []), null);
});

test('a later page goes on with its run; a first page starts a new one from the latest signals', () => {
  const current = run({ received: ['earlier'] });
  const latest = { plan: plan([{ categories: ['math.AG'], exampleCategories: [], positiveIds: [], weight: 1 }]), negativeIds: ['new-rejected'], excludedIds: ['new-liked'], viewedIds: ['viewed'] };

  assert.equal(recentRunFor(current, 2, latest), current);
  const restarted = recentRunFor(current, 0, latest);
  assert.deepEqual(restarted, { plan: latest.plan, negativeIds: ['new-rejected'], excludedIds: ['new-liked'], received: [], walk: restarted.walk });
  const forgotten = recentRunFor(null, 2, latest);
  assert.deepEqual(forgotten, { plan: latest.plan, negativeIds: ['new-rejected'], excludedIds: ['new-liked'], received: [], walk: forgotten.walk });
  // A new run names itself afresh.
  assert.notEqual(restarted.walk, current.walk);
  assert.notEqual(forgotten.walk, restarted.walk);
});

// ENG-198: two tabs of one reader start their runs from the same signals, and
// the Worker keeps one walk of the order per request. Unless each run names
// itself, one tab's pages move the other's walk on past papers it never showed.
test('two tabs\' runs ask with the same request but for the run each names, which every page of a run keeps', async () => {
  const latest = { plan: twoGroups, negativeIds: [], excludedIds: [], viewedIds: [] };
  const asked: Array<Record<string, unknown>> = [];
  const options = {
    apiBase: 'https://papertok-report-api.example',
    fetchWorker: async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ papers: [], skipsSeen: true }), { status: 200 });
    },
  };
  const ask = (current: RecentRun, page: number) => fetchCorpusPage(recentPageRequest(current, page, [])!, options);
  const tabA = recentRunFor(null, 0, latest);
  const tabB = recentRunFor(null, 0, latest);
  await ask(tabA, 0);
  await ask(tabB, 0);
  await ask(recentRunFor(tabB, 1, latest), 1);
  // Tab A goes on later with the run the session kept, as when the reader comes back from a paper.
  await ask(recentRunFor({ ...tabA, received: ['2611.00001'] }, 1, latest), 1);
  // Check again in tab A starts a run of its own.
  await ask(recentRunFor(tabA, 0, latest), 0);
  const [a0, b0, b1, a1, again] = asked;

  assert.deepEqual({ ...a0, walk: null }, { ...b0, walk: null });
  assert.equal(typeof a0.walk, 'string');
  assert.notEqual(a0.walk, b0.walk);
  // The Worker reads a run's name only in this shape (WALK_ID, worker/paper-store.ts).
  for (const body of [a0, b0]) assert.match(String(body.walk), /^[\w-]{8,64}$/);
  assert.equal(b1.walk, b0.walk);
  assert.equal(a1.walk, a0.walk);
  assert.notEqual(again.walk, a0.walk);
  assert.notEqual(again.walk, b0.walk);
});

test('the seen filter holds the viewed papers, then what the run received as the newest', () => {
  assert.deepEqual(recentSeenIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);

  const viewed = Array.from({ length: 2_000 }, (_, n) => `viewed-${n}`);
  const received = Array.from({ length: 100 }, (_, n) => `received-${n}`);
  const held = recentSeenIds(viewed, received);
  assert.equal(held.length, 2_000);
  assert.deepEqual(held, [...viewed.slice(100), ...received]);
});

test('a full page of unseen papers is shown, and more may follow', () => {
  const answer = papers('new', 15);
  const settled = settleRecentPage({ papers: answer, skipsSeen: true }, new Set(['elsewhere']), new Set());
  assert.deepEqual(ids(settled.papers), ids(answer));
  assert.equal(settled.hasMore, true);
  assert.deepEqual(settled.received, ids(answer));
});

test('a page that brings back a paper the filter held ends the run without showing it', () => {
  const answer = papers('new', 15);
  const settled = settleRecentPage({ papers: answer, skipsSeen: true }, new Set(['new-14']), new Set());
  assert.deepEqual(ids(settled.papers), ids(answer.slice(0, 14)));
  assert.equal(settled.hasMore, false);
  assert.deepEqual(settled.received, ids(answer));
});

test('a short page of new papers from a corpus that skips seen ones has more after it', () => {
  const settled = settleRecentPage({ papers: papers('new', 4), skipsSeen: true }, new Set(), new Set());
  assert.equal(settled.papers.length, 4);
  assert.equal(settled.hasMore, true);
});

test('an empty answer ends the run', () => {
  const settled = settleRecentPage({ papers: [], skipsSeen: true }, new Set(['elsewhere']), new Set());
  assert.deepEqual(settled.papers, []);
  assert.equal(settled.hasMore, false);
});

test('a short page from a corpus that does not skip seen papers ends the run', () => {
  const settled = settleRecentPage({ papers: papers('new', 4), skipsSeen: false }, new Set(), new Set());
  assert.equal(settled.papers.length, 4);
  assert.equal(settled.hasMore, false);
});

test('a paper viewed too long ago for the filter is passed over and counts as received', () => {
  const answer = papers('new', 15);
  const settled = settleRecentPage({ papers: answer, skipsSeen: true }, new Set(), new Set(['new-3']));
  assert.deepEqual(ids(settled.papers), ids(answer).filter(id => id !== 'new-3'));
  assert.ok(settled.received.includes('new-3'));
  assert.equal(settled.hasMore, true);
});

test('a server that does not skip seen papers has the held ones dropped and pages on', () => {
  const answer = papers('new', 15);
  const settled = settleRecentPage({ papers: answer, skipsSeen: false }, new Set(['new-0', 'new-5', 'new-9']), new Set());
  assert.equal(settled.papers.length, 12);
  assert.equal(settled.hasMore, true);
});

test('a list opens new when the profile has loaded and the session kept no pages under its key', () => {
  const kept = createSessionCache<CustomFeedPages>();
  const key = recentPagesKey('account-a', ['cs.AI']);
  assert.equal(startsNewRecentList(key, true, kept), true);
  assert.equal(startsNewRecentList(key, false, kept), false);
  assert.equal(startsNewRecentList(null, true, kept), false);
  kept.set(key, { papers: papers('new', 15), page: 0, hasMore: true, loading: [] });
  assert.equal(startsNewRecentList(key, true, kept), false);
  assert.equal(startsNewRecentList(recentPagesKey('account-a', ['cs.AI', 'q-bio.NC']), true, kept), true);
});

test('each account has its own place in Most recent', () => {
  assert.equal(recentScrollKey('account-a'), 'recent:account-a');
  assert.notEqual(recentScrollKey('account-b'), recentScrollKey('account-a'));
});

test('the list is kept under a new key when the account or its topics change, not their order', () => {
  const key = recentPagesKey('account-a', ['cs.AI', 'q-bio.NC']);
  assert.equal(recentPagesKey('account-a', ['q-bio.NC', 'cs.AI']), key);
  assert.notEqual(recentPagesKey('account-b', ['cs.AI', 'q-bio.NC']), key);
  assert.notEqual(recentPagesKey('account-a', ['cs.AI']), key);
  assert.notEqual(recentPagesKey('account-a', ['cs.AI', 'q-bio.NC', 'math.AG']), key);
});
