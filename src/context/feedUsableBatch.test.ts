import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { CATEGORIES } from '../data/categoryTaxonomy.ts';
import { resolveWithin } from '../utils/asyncTiming.ts';
import { abstractsInFlight, notablePlaces, placeNotableCards, preserveFeedAbstracts, mergeOpenAlexEnrichment, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { createEmptyInteractionProfile, deserializeInteractionProfile, MAX_VIEWED_IDS, readProfileSignals, recordInteractionEvent, serializeInteractionProfile, viewedIds, type InteractionEvent } from '../utils/interactionProfile.ts';
import { clearUserScopedStorage, readSeenPaperIds, removeLegacySeenPaperIds, saveSeenPaperIds } from '../utils/userScopedStorage.ts';
import { rankPreferences } from '../utils/preferenceRanking.ts';
import { diversifiedWeightedShuffle, pickExplorationCategories } from '../utils/recommendationEngine.ts';
import { applyKnownPublicationTypes, classifyFeedPublications, dropUnreachedPublications } from '../services/feedPublicationService.ts';
import { isFeedPublication } from '../services/feedPublicationRules.ts';
import { abstractWaitIds, openAbstractWait } from '../utils/feedAbstractWait.ts';
import { mergeFreshFeedPage, splitFeedForReRank } from '../utils/feedReRankSplit.ts';

import { mergeEuropePmcEnrichment } from '../services/europePmcRecords.ts';
import { mergeICiteEnrichment } from '../services/iCiteRecords.ts';
import { fetchCorpusPage } from '../services/paperStoreService.ts';

// Execute the actual loader callback with provider and React-state boundaries
// injected. Source-pattern tests cannot catch an excluded page ending the feed.
const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('async (reset = false, mode?: string | null, pageOverride?: number,');
const end = source.indexOf('\n  }, [\n    userPreferences, page, papers, loading, feedMode,', start);
assert.ok(start >= 0 && end > start, 'the feed loader callback must exist');
const callback = stripTypeScriptTypes(source.slice(start, end) + '\n  }');
// The follow-up the loader and a snapshot restore share, run the same way.
function componentCallback(name: string, deps: string) {
  const from = source.indexOf(`const ${name} = useCallback(`);
  const to = source.indexOf(`\n  }, [${deps}]);`, from);
  assert.ok(from >= 0 && to > from, `${name} must exist`);
  return stripTypeScriptTypes(source.slice(from + `const ${name} = useCallback(`.length, to) + '\n  }');
}
const followCallback = componentCallback('followShownPapers', 'scheduleFeedSnapshotWrite');
const restoreCallback = componentCallback('restoreFeedSnapshot', 'followShownPapers');
const notInterestedCallback = componentCallback('markNotInterested', 'withInteractionId, reRankFeed, recordProfileEvent, user?.uid');
const refreshCallback = componentCallback('refreshFeed', '');
const ref = <T>(current: T) => ({ current });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A separate instance of the publication service: its own Crossref cache.
const freshPublications = (name: string) => import(new URL(`../services/feedPublicationService.ts?${name}`, import.meta.url).href) as Promise<typeof import('../services/feedPublicationService.ts')>;
type FeedRecord = Pick<Paper, 'id' | 'title' | 'authors' | 'primaryCategory'> & Partial<Paper>;
const records = (prefix: string, count = 15): FeedRecord[] => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  title: `${prefix} scientific research finding number ${index}`,
  authors: [{ name: `${prefix} Researcher ${index}` }],
  primaryCategory: 'cs.AI',
}));

function deferred() {
  let resolve!: (papers: FeedRecord[]) => void;
  const promise = new Promise<FeedRecord[]>(done => { resolve = done; });
  return { promise, resolve };
}

// The feed's papers come from the paper corpus (fetchCorpusPage). These tests
// stand it in with the scope's per-category double, asked at the page's start
// as arXiv was, followed by `slow`, the rest of the corpus's answer.
function withCorpusStandIn<T extends { fetchPapers: unknown; restOfPage: () => Promise<FeedRecord[]>; PAGE_SIZE: number }>(scope: T) {
  const fetchPapers = scope.fetchPapers as (...args: unknown[]) => Promise<FeedRecord[]>;
  return {
    fetchCorpusPage: async ({ categories, page, pageSize, order }: { categories: string[]; page: number; pageSize: number; order: string }) => (
      [...await fetchPapers(categories, page * scope.PAGE_SIZE, pageSize, order), ...await scope.restOfPage()]
    ),
    selectSemanticProfilePositiveIds: () => [], curatedIds: () => [], interactionProfile: ref(null),
    // A test that asks the corpus double itself sets these on the scope.
    ...scope,
  };
}

function feed({ fast = records('fast'), slow = [], known = [], seen = [], page = 0, papers = [] }: { fast?: FeedRecord[]; slow?: FeedRecord[] | Promise<FeedRecord[]>; known?: string[]; seen?: string[]; page?: number; papers?: FeedRecord[] } = {}) {
  const state = { papers, page, loading: false, hasMore: true, error: null as string | null, continuations: [] as unknown[][], abstractWaits: [] as ReadonlyArray<ReadonlySet<string>> };
  const env = {
    userPreferences: ['cs.AI'], recommendationProfileReady: true, feedMode: 'top', PAGE_SIZE: 15,
    feedRequestId: ref(0), feedSessionId: ref(0), feedLoadInFlight: ref(false), loadAfterCommit: ref<object | null>(null),
    setLoading: (value: boolean) => { state.loading = value; }, setError: (value: string | null) => { state.error = value; },
    setPapers: (value: FeedRecord[] | ((previous: FeedRecord[]) => FeedRecord[])) => { state.papers = typeof value === 'function' ? value(state.papers) : value; },
    setPage: (value: number) => { state.page = value; }, setHasMore: (value: boolean) => { state.hasMore = value; },
    getAllLeafCategories: () => [{ id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' }],
    followedEntities: [], profileSignals: ref(readProfileSignals(null)), temporalPreference: ref(0),
    rankPreferences: <T>(values: T) => values, CATEGORIES: { cs: { subcategories: { 'cs.AI': 'Artificial Intelligence' } } } as Record<string, { subcategories: Record<string, string | { label: string }> }>,
    fetchPapers: (() => Promise.resolve(fast)) as (categories: string[], start?: number, count?: number, mode?: string) => Promise<FeedRecord[]>,
    restOfPage: () => Promise.resolve(slow), MAIN_CATEGORIES: 10,
    pickExplorationCategories,
    FEED_SOURCE_RENDER_BUDGET_MS: 5, OPTIONAL_SOURCE_RENDER_BUDGET_MS: 5,
    resolveWithin, PaperBuilder,
    classifyFeedPublications, isFeedPublication, applyKnownPublicationTypes, dropUnreachedPublications,
    visiblePaperIdRef: ref<string | null>(null),
    boredomLevel: ref(0), getBoredomThreshold: () => 5,
    likedPaperIdsRef: ref(new Set(known)), savedPaperIdsRef: ref(new Set()),
    readPaperIdsRef: ref(new Set()), notInterestedIdsRef: ref(new Set()),
    sessionSeenPapers: ref(new Set(seen)), isKnownPaper: (id: string) => known.includes(id),
    mergeFollowEntityMatches: (...groups: unknown[][]) => groups.flat(),
    diversifiedWeightedShuffle: <T>(values: T) => values, calculateAndAttachScore: () => 0,
    recommendationWeights: ref({}), mergeFreshFeedPage, notablePlaces, placeNotableCards, FOLLOWED_PER_PAGE: 6, NOTABLE_SPARE: 2,
    needsOpenAlexEnrichment: () => false, getOpenAlexEnrichmentId: () => '',
    enrichPapersBatch: () => Promise.resolve({}), OPENALEX_FEED_REQUEST_TIMEOUT_MS: 5,
    enrichPubmedIds: () => Promise.resolve(new Map()),
    recoverFeedAbstracts: (async () => []) as (papers: Paper[]) => Promise<Partial<Paper>[]>,
    mergeOpenAlexEnrichment, preserveFeedAbstracts, mergeFeedAbstracts, mergeEuropePmcEnrichment, mergeICiteEnrichment,
    abstractsInFlight, cardsGivenTopic: () => [], keepLateTopicsRef: ref(() => {}),
    openAbstractWait, setAbstractWaits: (update: (current: typeof state.abstractWaits) => typeof state.abstractWaits) => { state.abstractWaits = update(state.abstractWaits); },
    scheduleFeedSnapshotWrite: (() => {}) as (userId: string, key: string, snapshot: { papers: Paper[] }) => void,
    logRankingBatch: () => {}, saveSeenPaperIds: () => {}, activeUserId: ref('test-user'),
    autoRetryUsedRef: ref(false), feedCache: ref<Record<string, unknown>>({}), restoredFeedKeyRef: ref(''),
    feedPreferenceSignature: (values: string[]) => values.join('|'), pendingSnapshotWritesRef: ref(new Map()),
    writeFeedSnapshot: (() => {}) as (userId: string, key: string, snapshot: { papers: Paper[] }) => void,
    loadPapersRef: ref((...args: unknown[]) => { state.continuations.push(args); }),
  };
  const build = (code: string, scope: object) => new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
  const withFollowUp = () => ({ ...env, followShownPapers: build(followCallback, env) });
  const run = (...args: unknown[]) => {
    Object.assign(env, { papers: state.papers, page: state.page, loading: state.loading });
    return build(callback, withCorpusStandIn(withFollowUp()))(...args);
  };
  const restore = (snapshot: { papers: FeedRecord[]; page: number; hasMore: boolean }) => build(restoreCallback, withFollowUp())(snapshot, 'top', 'cs.AI');
  // Not interested in demo mode: nothing written to Firestore, no re-rank.
  const dismiss = (paper: FeedRecord) => build(notInterestedCallback, {
    ...env, user: null, IS_DEMO: true, demoSet: () => {}, withInteractionId: <T>(value: T) => value,
    setNotInterestedIds: () => {}, papersRef: ref(state.papers), recordProfileEvent: () => {}, reRankFeed: () => {},
  })(paper);
  // Pull to refresh, with its 800 ms minimum.
  const refresh = () => build(refreshCallback, {
    ...env, setIsRefreshing: () => {}, clearCache: () => {}, loadPapersRef: ref(run),
  })();
  const loadingAbstracts = () => abstractWaitIds(state.abstractWaits);
  return { state, env, run, restore, dismiss, refresh, loadingAbstracts };
}

test('an entirely excluded page advances pagination without restoring books through the seen bypass', async () => {
  const books = [{ ...records('book', 1)[0], publicationType: 'book' }];
  const { state, run } = feed({ fast: books });
  await run(true);
  await tick();
  assert.deepEqual(state.papers, []);
  assert.equal(state.continuations.length, 1);
});

for (const excludedCount of [13, 15]) {
  test(`a page with ${excludedCount} known papers waits for fresh papers beyond the first-paint budget`, async () => {
    const slow = deferred();
    const { state, run } = feed({ slow: slow.promise, known: records('fast', excludedCount).map(paper => paper.id) });
    const loading = run(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(state.papers.length, 0);
      assert.equal(state.loading, true);
    } finally {
      slow.resolve(records('slow'));
      await loading;
    }
    assert.equal(state.error, null);
    // Every paper of the answer the reader does not know.
    assert.equal(state.papers.length, 30 - excludedCount);
    assert.equal(state.hasMore, true);
    assert.ok(state.papers.every(paper => !records('fast', excludedCount).some(known => known.id === paper.id)));
  });
}

test('session-seen papers also do not satisfy the first-page readiness threshold', async () => {
  const { state, run } = feed({ slow: records('fresh'), seen: records('fast', 13).map(paper => paper.id) });
  await run(true);
  assert.equal(state.error, null);
  // The two fast papers not seen, and the fifteen fresh ones.
  assert.equal(state.papers.length, 17);
  assert.ok(state.papers.every(paper => !paper.id.startsWith('fast-') || Number(paper.id.split('-')[1]) >= 13));
});

test('an entirely known page advances instead of declaring provider exhaustion', async () => {
  const { state, run } = feed({ known: records('fast').map(paper => paper.id) });
  await run(true);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.hasMore, true);
  // A reset goes on as the same load, still a reset, on the next page.
  assert.deepEqual(state.continuations, [[true, 'top', 1, { keepThroughVisible: false, seenFallback: undefined }]]);
});

// A reload, as the feed's own effects start one: from the first page (arXiv
// start 0). Each page holds papers of its own.
function reload(t: import('node:test').TestContext, { seen = [] as string[], papers = [] as FeedRecord[], page = (start: number) => records(`page-${start / 15}`) } = {}) {
  t.mock.method(console, 'log', () => {});
  const loaded = feed({ seen, papers });
  const starts: number[] = [];
  loaded.env.fetchPapers = (_categories: string[], start = 0) => {
    starts.push(start);
    return Promise.resolve(page(start));
  };
  return { ...loaded, starts };
}
const pageIds = (...pages: number[]) => pages.flatMap(index => records(`page-${index}`)).map(paper => paper.id);
const pageOf = (start: number) => records(`page-${start / 15}`);
// The corpus sends a notable card only when the reader has not seen it, so a
// page whose other papers were all seen still holds its two.
const withUnseenNotable = (page: (start: number) => FeedRecord[]) => (start: number) => {
  const papers = page(start);
  return papers.length ? [...papers, ...records(`notable-${start / 15}`, 2).map(paper => ({ ...paper, _notable: true }))] : papers;
};
const notableVariants = [
  ['', (page: (start: number) => FeedRecord[]) => page],
  [', and every page holds unseen notable cards', withUnseenNotable],
] as const;

for (const [cards, withCards] of notableVariants) {
  test(`a reload whose first pages were all shown before shows unseen papers from the page after them${cards}`, async t => {
    const { state, env, run, starts } = reload(t, { seen: pageIds(0, 1), page: withCards(pageOf) });
    env.loadPapersRef.current = run;
    const steps: string[] = [];
    const { setLoading, setPapers } = env;
    env.setLoading = value => { steps.push(`loading ${value}`); setLoading(value); };
    env.setPapers = value => { setPapers(value); steps.push(`${state.papers.length} papers`); };
    await run(true, null);
    assert.equal(state.error, null);
    assert.deepEqual(starts, [0, 15, 30], 'one page on at a time, so no unseen paper is passed over');
    assert.deepEqual(state.papers.filter(paper => !paper._notable).map(paper => paper.id), pageIds(2));
    // Fourteen cards and the page's first notable one, then the fifteenth card.
    assert.deepEqual(state.papers.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : [])), cards ? [[14, 'notable-2-0']] : []);
    const shown = `${state.papers.length} papers`;
    assert.ok(steps.indexOf(shown) < steps.indexOf('loading false'),
      `the first screen stays loading until the later page is shown: ${steps.join(', ')}`);
  });
}

test('a refresh whose first page was all shown before replaces the cards on screen with unseen ones', async t => {
  const onScreen = records('page-0');
  const { state, env, run } = reload(t, { seen: pageIds(0), papers: onScreen });
  env.loadPapersRef.current = run;
  await run(true, null);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => id.startsWith('page-0-')), [],
    'the list is replaced, neither shown again nor extended');
});

for (const [name, page, asked] of [
  // The pagination ceiling stops the search at page 10.
  ['every later page was shown before too', pageOf, 11],
  ['no later page has papers', (start: number) => start === 0 ? records('page-0') : [], 2],
] as const) {
  for (const [cards, withCards] of notableVariants) {
    test(`a reload whose first page was all shown before still gets a feed when ${name}${cards}`, async t => {
      const everyPage = Array.from({ length: 30 }, (_, index) => records(`page-${index}`)).flat().map(paper => paper.id);
      const { state, env, run, starts } = reload(t, { seen: everyPage, page: withCards(page) });
      env.loadPapersRef.current = run;
      await run(true, null);
      assert.equal(state.error, null);
      assert.deepEqual(state.papers.map(paper => paper.id), pageIds(0), 'the feed is not empty: the first page is shown again, without notable cards');
      assert.equal(state.hasMore, true, 'the reader can scroll on');
      assert.equal(starts.length, asked, JSON.stringify(starts));
    });
  }
}

test('after a reload shows its seen first page because the next page was empty, scrolling asks for that page again', async t => {
  // Page 0 was shown before; page 1 is empty when the reload asks, and has
  // papers by the time the reader reaches the end of the list.
  let filled = false;
  const { state, env, run, starts } = reload(t, {
    seen: pageIds(0),
    page: start => (start === 0 ? records('page-0') : start === 15 && filled ? records('page-1') : []),
  });
  env.loadPapersRef.current = run;
  await run(true, null);
  assert.deepEqual(state.papers.map(paper => paper.id), pageIds(0));
  assert.equal(state.hasMore, true);
  filled = true;
  await run(false);
  assert.equal(state.error, null);
  assert.deepEqual(starts, [0, 15, 15]);
  assert.deepEqual(state.papers.map(paper => paper.id), pageIds(0, 1));
});

// The later page is rarely in the Worker's edge cache, so it is the one that
// waits for a seat at arXiv and can be refused.
for (const status of [429, 502]) {
  test(`a reload whose first page was all shown before shows those papers when arXiv answers the next page with ${status}`, async t => {
    const { state, env, run, starts } = reload(t, { seen: pageIds(0) });
    env.loadPapersRef.current = run;
    env.fetchPapers = (_categories: string[], start = 0) => {
      starts.push(start);
      return start === 0
        ? Promise.resolve(records('page-0'))
        : Promise.reject(Object.assign(new Error(`arXiv API error: ${status}`), { status }));
    };
    // Every timer the loader sets fires at once, so a retry would already have run.
    Object.assign(env, { setTimeout: (callback: () => void) => setTimeout(callback, 0) });
    await run(true, null);
    await wait(20);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), pageIds(0), 'the first page is shown again');
    assert.equal(state.hasMore, true, 'the reader can scroll on');
    assert.deepEqual(starts, [0, 15], 'no request after the refused one');
  });
}

test('a reload whose first page has unseen papers asks for no other page', async t => {
  // A source returns a wider pool than a page: 20 papers, 5 shown before.
  const { state, run, starts } = reload(t, {
    seen: records('page-0', 5).map(paper => paper.id),
    page: start => records(`page-${start / 15}`, 20),
  });
  await run(true, null);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(starts, [0]);
  assert.deepEqual(state.continuations, []);
});

// What "seen" means once it follows the reader. A card counts only after it
// was on screen (a view or a skip writes its interaction document); a card a
// load merely brought in is remembered in memory, so this session does not
// offer it twice, and is forgotten by the next load.
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; },
  };
}
const callbackIn = (code: string, scope: object) => new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
const paperRecord = (id: string): FeedRecord => ({ id, title: `${id} scientific research`, authors: [], primaryCategory: 'cs.AI' });
const viewedEvent = (paperId: string, kind = 'viewTime') => ({ paperId, kind, category: 'cs.AI', viewTime: 4 });
// The real callbacks over one browser's storage; `user` is the signed-in account
// and `seen` the feed's in-memory set. `auth` is Firebase's own current user.
function viewing({ user = 'test-user' as string | null, seen = ref(new Set<string>()), storage = memoryStorage(), traverseAndExpandNetwork = (() => {}) as (paper: FeedRecord) => void, recordProfileEvent = (() => {}) as (event: InteractionEvent) => void } = {}) {
  const scope = {
    sessionSeenPapers: seen, activeUserId: ref(user), viewedIds, auth: { currentUser: user ? { uid: user } as { uid: string } | null : null },
    readSeenPaperIds: (userId: string | null) => readSeenPaperIds(userId, storage),
    saveSeenPaperIds: (userId: string | null, ids: Iterable<string>) => saveSeenPaperIds(userId, ids, storage),
  };
  const markPaperViewed = callbackIn(componentCallback('markPaperViewed', ''), scope) as (paperId: string, viewerId: string | null | undefined) => void;
  const carryViewedPapers = callbackIn(componentCallback('carryViewedPapers', ''), scope) as (profile: ReturnType<typeof createEmptyInteractionProfile>) => void;
  const tracking = {
    markPaperViewed, user: user ? { uid: user } : null, IS_DEMO: true,
    boredomLevel: ref(0), profileSignals: ref(readProfileSignals(null)), temporalPreference: ref(0),
    countEngagement: () => {}, recordProfileEvent, scheduleReRank: () => {}, traverseAndExpandNetwork,
    dedupeInteractionPapers: <T>(papers: T[]) => papers,
  };
  const trackViewTime = callbackIn(componentCallback('trackViewTime', 'markPaperViewed, scheduleReRank, recordProfileEvent, countEngagement, user?.uid'), tracking) as (paper: FeedRecord, seconds: number) => Promise<void>;
  const trackSkips = callbackIn(componentCallback('trackSkips', 'markPaperViewed, scheduleReRank, recordProfileEvent, countEngagement, user?.uid'), tracking) as (papers: FeedRecord[]) => Promise<void>;
  return { scope, markPaperViewed, carryViewedPapers, trackViewTime, trackSkips, stored: (userId = user) => [...readSeenPaperIds(userId, storage)] };
}

test('a load remembers the papers it shows for this session, not in the reader\'s viewed list', async t => {
  t.mock.method(console, 'log', () => {});
  const { state, env, run } = feed();
  const writes: unknown[][] = [];
  env.saveSeenPaperIds = (...args: unknown[]) => { writes.push(args); };
  await run(true);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(writes, [], 'no card nobody viewed is written to the list kept across loads');
  assert.ok(state.papers.every(paper => env.sessionSeenPapers.current.has(paper.id)), 'but this session does not offer it twice');
});

// Reading a card for ten seconds used to walk its citation network: an OpenAlex
// call (and a Semantic Scholar one) for a reader who did nothing. In the PAP-86
// audit's model those walks were about a tenth of a signed-in session's
// OpenAlex units; nothing was measured. A like, a save or an opened PDF still
// expands the graph; a passive read only ranks.
test('a ten-second read no longer walks the citation network', async () => {
  const walked: string[] = [];
  const { trackViewTime, stored } = viewing({ traverseAndExpandNetwork: (paper: FeedRecord) => { walked.push(paper.id); } });
  await trackViewTime(paperRecord('read-for-a-while'), 12);
  assert.deepEqual(walked, []);
  assert.deepEqual(stored(), ['read-for-a-while'], 'the view itself still counts');
});

test('a card the reader views or skips joins the list kept across loads, a loaded one does not', async () => {
  const { markPaperViewed, trackViewTime, trackSkips, stored } = viewing({ seen: ref(new Set(['loaded-only'])) });
  await trackViewTime(paperRecord('viewed'), 4);
  await trackViewTime(paperRecord('glanced-under-1s'), 0.5);
  await trackSkips([paperRecord('skip-1'), paperRecord('skip-2')]);
  assert.deepEqual(stored(), ['viewed', 'skip-1', 'skip-2']);
  // Viewing again moves the paper to the end instead of repeating it.
  markPaperViewed('viewed', 'test-user');
  assert.deepEqual(stored(), ['skip-1', 'skip-2', 'viewed']);
});

test('the viewed list is the signed-in account\'s own, and keeps the last 500', () => {
  const storage = memoryStorage();
  const accountA = viewing({ user: 'account-a', storage });
  for (let index = 0; index < 520; index += 1) accountA.markPaperViewed(`paper-${index}`, 'account-a');
  const accountB = viewing({ user: 'account-b', storage });
  accountB.markPaperViewed('b-paper', 'account-b');

  assert.equal(accountA.stored().length, 500);
  assert.equal(accountA.stored()[0], 'paper-20');
  assert.deepEqual(accountB.stored(), ['b-paper']);
  // A guest has no list to write to.
  const guest = viewing({ user: null, storage });
  guest.markPaperViewed('guest-paper', undefined);
  assert.deepEqual(guest.stored(), []);
});

test('a card that reports after the account changed was not viewed by the new account', async () => {
  const storage = memoryStorage();
  const accountA = viewing({ user: 'account-a', storage });
  await accountA.trackViewTime(paperRecord('before'), 4);
  // The feed switches to B while A's last card is still reporting.
  accountA.scope.activeUserId.current = 'account-b';
  await accountA.trackViewTime(paperRecord('late-card'), 4);
  await accountA.trackSkips([paperRecord('late-skip')]);

  assert.deepEqual(accountA.stored('account-a'), ['before']);
  assert.deepEqual(accountA.stored('account-b'), []);
  assert.equal(accountA.scope.sessionSeenPapers.current.has('late-card'), false);
});

// Signing out: AuthContext sweeps the account's storage once Firebase has
// signed out, and React commits the signed-out state later. The card on screen
// reports from its cleanup before the feed's own account effect resets
// activeUserId, so the report still names the account that signed out.
test('a card that reports while signing out does not write the swept viewed list back', async () => {
  const storage = memoryStorage();
  const accountA = viewing({ user: 'account-a', storage });
  await accountA.trackViewTime(paperRecord('before'), 4);
  assert.deepEqual(accountA.stored(), ['before']);
  accountA.scope.auth.currentUser = null;
  clearUserScopedStorage('account-a', storage);
  await accountA.trackViewTime(paperRecord('card-on-screen-at-sign-out'), 4);
  await accountA.trackSkips([paperRecord('skipped-at-sign-out')]);

  assert.equal(storage.getItem('papertok_viewedIds:account-a'), null, 'nothing is written back after the sweep');
});

// Device A's reader went through every paper of page 1 and nothing else; the
// browser of device B has nothing of its own, only the aggregate B reads.
function deviceBReadingAGroup(papers: FeedRecord[]) {
  const deviceA = createEmptyInteractionProfile();
  papers.forEach(paper => recordInteractionEvent(deviceA, viewedEvent(paper.id)));
  return deserializeInteractionProfile(serializeInteractionProfile(deviceA))!;
}

test('what the reader viewed on another device is not shown again here, even on the first screen', async t => {
  const deviceB = deviceBReadingAGroup(records('page-0'));
  const { state, env, run, starts } = reload(t);
  viewing({ seen: env.sessionSeenPapers }).carryViewedPapers(deviceB);
  env.loadPapersRef.current = run;
  await run(true, null);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => pageIds(0).includes(id)), [], 'nothing A viewed comes back');
  assert.deepEqual(starts, [0, 15], 'the reload skipped past A\'s page');
});

test('a short pool the other device viewed whole still gives a feed', async t => {
  const pool = records('page-0', 6);
  const deviceB = deviceBReadingAGroup(pool);
  const { state, env, run } = reload(t, { page: start => start === 0 ? pool : [] });
  viewing({ seen: env.sessionSeenPapers }).carryViewedPapers(deviceB);
  env.loadPapersRef.current = run;
  await run(true, null);
  assert.equal(state.error, null);
  assert.deepEqual(state.papers.map(paper => paper.id), pool.map(paper => paper.id), 'the feed is not empty: the viewed pool is shown again');
  assert.equal(state.hasMore, true);
});

// After a browser reload the snapshot's cards are on screen again, but the
// reader's viewed list names only the ones that reported a view: the card on
// screen when the tab closed never ran its cleanup.
test('a refresh after a reload does not offer the restored cards again', async t => {
  const { state, env, run, restore, starts } = reload(t);
  env.loadPapersRef.current = run;
  const restored = records('page-0').map(paper => ({ ...paper, abstract: 'Source text.', sources: { primary: 'arxiv', enrichedBy: [] } }));
  restore({ papers: restored, page: 1, hasMore: true });
  await run(true, null);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => pageIds(0).includes(id)), [], 'no restored card comes back');
  assert.deepEqual(starts, [0, 15], 'the refresh skipped past the restored page');
});

// The start of the effect that runs when the signed-in account changes, up to
// where a guest returns: it replaces the seen set and resets the aggregate.
const accountSwitchStart = source.indexOf('    removeLegacySeenPaperIds(null, userId);\n    activeUserId.current = userId;\n    sessionSeenPapers.current');
const accountSwitch = stripTypeScriptTypes(source.slice(accountSwitchStart, source.indexOf('\n    if (!userId) {', accountSwitchStart)));
function switchAccount(viewer: ReturnType<typeof viewing>, storage: ReturnType<typeof memoryStorage>, interactionProfile: { current: ReturnType<typeof createEmptyInteractionProfile> }, userId: string) {
  const noop = () => {};
  const scope = {
    ...viewer.scope, interactionProfile, createEmptyInteractionProfile, readProfileSignals, emptyEngagementWindow: () => null,
    removeLegacySeenPaperIds: (_storage: null, id: string) => removeLegacySeenPaperIds(storage, id), loadedProfileUserId: ref<string | null>(viewer.scope.activeUserId.current),
    setLikedPaperIds: noop, setNotInterestedIds: noop, setSavedPaperIds: noop, setReadPaperIds: noop, setPersonalLibrary: noop,
    profileSignals: ref(null), relatedCandidates: ref([]), personalCandidates: ref([]), engagementWindow: ref(null),
    interactionProfileHydrated: ref(true), personalLibraryStatus: ref(null),
  };
  assert.ok(accountSwitchStart >= 0, 'the account-change effect must exist');
  new Function(...Object.keys(scope), 'userId', accountSwitch)(...Object.values(scope), userId);
}

test("switching accounts forgets what the previous account viewed, in memory, and keeps each account's list apart", () => {
  const storage = memoryStorage();
  const accountA = viewing({ user: 'account-a', storage });
  accountA.markPaperViewed('a-viewed-here', 'account-a');
  const aggregateA = deviceBReadingAGroup([paperRecord('a-viewed-elsewhere')]);
  accountA.carryViewedPapers(aggregateA);
  const interactionProfile = ref(aggregateA);
  switchAccount(accountA, storage, interactionProfile, 'account-b');

  assert.deepEqual([...accountA.scope.sessionSeenPapers.current], [], 'B does not skip what A viewed');
  assert.deepEqual(viewedIds(interactionProfile.current), [], "B's aggregate does not carry A's ring");
  assert.deepEqual(accountA.stored('account-a'), ['a-viewed-here'], 'A finds its list when it signs back in');
  assert.deepEqual(accountA.stored('account-b'), []);
});

// The list this browser kept before the release named every paper a load
// showed, including every paper the reader viewed.
test("an account's first load after the release skips what this browser had kept for it", () => {
  const storage = memoryStorage();
  storage.setItem('papertok_seenIds:account-b', JSON.stringify(['b-viewed-before-release']));
  const guest = viewing({ user: null, storage });
  switchAccount(guest, storage, ref(createEmptyInteractionProfile()), 'account-b');

  assert.deepEqual([...guest.scope.sessionSeenPapers.current], ['b-viewed-before-release']);
  assert.deepEqual(guest.stored('account-b'), ['b-viewed-before-release']);
});

test('a short screen schedules its next page and preserves papers when it fills', async () => {
  const { state, env, run } = feed({ fast: records('fast', 2) });
  await run(true);
  await tick();
  assert.equal(state.papers.length, 2);
  assert.deepEqual(state.continuations, [[false, 'top', 1]]);
  const firstIds = state.papers.map(paper => paper.id);
  env.fetchPapers = () => Promise.resolve(records('next', 13));
  await run(...state.continuations.shift()!);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.slice(0, 2).map(paper => paper.id), firstIds);
  assert.deepEqual(state.continuations, []);
});

test('an empty later page ends the feed without scheduling another page', async () => {
  const { state, run } = feed({ fast: [], page: 3, papers: records('shown', 5) });
  await run(false);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.hasMore, false);
  assert.deepEqual(state.continuations, []);
});

test('an empty first page is an error with a retry, not an empty feed', async t => {
  t.mock.method(console, 'error', () => {});
  const timers: Array<() => void> = [];
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => { timers.push(callback); return 0; });
  const empty = feed({ fast: [] });
  await empty.run(true);
  assert.equal(empty.state.error, 'FEED_LOAD_FAILED');
  assert.equal(timers.length, 1, 'one automatic retry is scheduled');
});

for (const knownCount of [0, 2]) {
  for (const guard of ['feedRequestId', 'feedSessionId'] as const) {
    test(`changing ${guard} cancels a scheduled continuation with ${knownCount} excluded papers`, async () => {
      const { state, env, run } = feed({ fast: records('fast', 2), known: records('fast', knownCount).map(paper => paper.id) });
      // A later page: a reset load whose page is all excluded goes on at once.
      await run(false);
      env[guard].current += 1;
      await tick();
      assert.equal(state.error, null);
      assert.deepEqual(state.continuations, []);
    });
  }
}

test('automatic top-up respects the existing pagination ceiling', async () => {
  const { state, run } = feed({ fast: records('fast', 2), page: 10 });
  await run(false);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 2);
  assert.deepEqual(state.continuations, []);
});

// The provider's hooks as React runs them: every render closes over that
// render's state, and a commit publishes the render's loadPapers.
function hookBody(anchor: string) {
  const from = source.indexOf(anchor);
  const to = source.indexOf('\n  }, [', from);
  assert.ok(from >= 0 && to > from, `the hook at ${JSON.stringify(anchor)} must exist`);
  return stripTypeScriptTypes(source.slice(source.indexOf('() => {', from), to) + '\n  }');
}
const loadMoreCallback = hookBody('const loadMore = useCallback(');
const publishCallback = hookBody('useLayoutEffect(() => {\n    loadPapersRef.current = loadPapers;');
const compile = (code: string, scope: object) => new Function(...Object.keys(scope), `return (${code});`)(...Object.values(scope));
type Loader = ReturnType<typeof feed>;
function renders(state: Loader['state'], env: Loader['env'], sources: object) {
  return () => {
    const scope = withCorpusStandIn({ ...env, ...sources, followShownPapers: compile(followCallback, env), loading: state.loading, papers: state.papers, page: state.page, hasMore: state.hasMore });
    const loadPapers = compile(callback, scope);
    return {
      loadPapers,
      loadMore: compile(loadMoreCallback, { ...scope, loadPapers }),
      // `timers` can replace the effect's setTimeout, to choose when its callback runs.
      commit: (timers = {}) => compile(publishCallback, { ...scope, loadPapers, ...timers })(),
    };
  };
}

for (const commitFirst of [true, false]) {
  test(`only the reset load fills the first screen, and its short page continues when React commits it ${commitFirst ? 'before' : 'after'} the continuation fires`, async t => {
    t.mock.method(Math, 'random', () => 0.5);
    const { state, env } = feed();
    // commit() puts the real loader in loadPapersRef. A reset load that fails
    // after paint schedules a retry through it every 2.5 s, which would keep
    // the test process alive. A new session cancels its retries and continuations.
    t.after(() => { env.feedSessionId.current += 1; });
    const requests: Array<{ categories: string[]; start?: number; painted: boolean }> = [];
    let open!: () => void;
    const answered = new Promise<void>(resolve => { open = resolve; });
    const sources = {
      // cs.LG is the nearby category that exploration adds.
      getAllLeafCategories: () => [
        { id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' },
        { id: 'cs.LG', label: 'Machine Learning', area: 'cs' },
      ],
      // Five papers before anything is shown, twelve after.
      fetchPapers: async (categories: string[], start: number) => {
        const painted = state.papers.length > 0;
        requests.push({ categories, start, painted });
        await answered;
        if (categories.includes('cs.LG')) return records('nearby', 2);
        return painted ? records('next', 12) : records('first', 5);
      },
    };
    const render = renders(state, env, sources);

    const mounted = render();
    mounted.commit();
    // The preferences effect starts the reset load. While the corpus is
    // pending, the scroll sentinel from the same render reports itself in view
    // before React commits the reset load's `loading`.
    const resetLoad = mounted.loadPapers(true, null);
    mounted.loadMore();
    render().commit();
    open();
    await resetLoad;

    const firstPage = records('first', 5).map(paper => paper.id);
    const firstWave = requests.filter(request => !request.painted);
    assert.equal(firstWave.length, 1, 'one corpus request before the first page is shown');
    assert.equal(firstWave[0].start, 0, 'the reset load asks for the first page');
    assert.ok(!firstWave[0].categories.includes('cs.LG'), 'no exploration request before the first page is shown');
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), firstPage);

    // Five cards are a short page, so the reset load has scheduled the next one.
    const shown = render();
    if (commitFirst) shown.commit();
    await tick();
    if (!commitFirst) shown.commit();
    await wait(100);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.slice(0, firstPage.length).map(paper => paper.id), firstPage, 'the first page stays where it is');
    assert.ok(state.papers.slice(firstPage.length).some(paper => paper.id.startsWith('next-')), 'the next page follows it');
    assert.ok(requests.some(request => request.painted && request.categories.includes('cs.LG')), 'exploration comes with the next page');
  });
}

for (const change of ['a reset load runs', 'the account changes'] as const) {
  test(`a continuation stored for the next commit is dropped when ${change} before its timer fires`, async t => {
    t.mock.method(Math, 'random', () => 0.5);
    const { state, env } = feed();
    // As above: cancels what the real loader in loadPapersRef still has scheduled.
    t.after(() => { env.feedSessionId.current += 1; });
    const starts: number[] = [];
    const render = renders(state, env, {
      // Five papers on the first load's first page, and fifteen on every later request.
      fetchPapers: async (_categories: string[], start: number) => {
        starts.push(start);
        return starts.length === 1 ? records('first', 5) : records(`page-${start / 15}`, 15);
      },
    });

    const mounted = render();
    mounted.commit();
    const firstLoad = mounted.loadPapers(true, null);
    render().commit();
    await firstLoad;
    // The short page's continuation reaches the closure rendered during the
    // load, which stores it; the painted render's commit schedules it.
    await tick();
    const scheduled: Array<() => void> = [];
    render().commit({ setTimeout: (callback: () => void) => { scheduled.push(callback); } });
    assert.equal(scheduled.length, 1, 'the painted render schedules the stored continuation');

    const reset = change === 'a reset load runs';
    if (reset) {
      await render().loadPapers(true, null);
      render().commit();
    } else {
      // What the account effect does when the user changes.
      env.feedSessionId.current += 1;
    }
    scheduled[0]();
    await wait(20);
    // The first feed's next page, 1, starts at 15.
    assert.deepEqual(starts, reset ? [0, 0] : [0], 'no request for the stored page');
    assert.deepEqual(state.papers.map(paper => paper.id), (reset ? records('page-0', 15) : records('first', 5)).map(paper => paper.id));
    assert.equal(state.page, 1);
  });
}

for (const category of ['econ.EM', 'q-fin.RM', 'q-fin.GN']) {
  test(`the personalized feed displays arXiv papers for ${category}`, async () => {
    const { state, env, run } = feed({ fast: [] });
    env.userPreferences = [category];
    env.CATEGORIES = CATEGORIES;
    env.fetchPapers = async (categories) => categories.map((id: string) => ({
      ...records(id, 1)[0], primaryCategory: id,
    }));

    await run(true);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.primaryCategory), [category]);
  });
}

for (const [name, preference, boredom] of [
  ['nearby', 'q-fin.RM', 0],
  ['random', 'econ.EM', 8],
] as const) {
  test(`the ${name} exploration branch can add a General Finance paper`, async () => {
    const { state, env, run } = feed({ fast: [], page: 1 });
    env.userPreferences = [preference];
    env.CATEGORIES = CATEGORIES;
    env.boredomLevel.current = boredom;
    env.getAllLeafCategories = () => [
      { id: preference, label: 'Selected topic', area: preference.split('.')[0] },
      { id: 'q-fin.GN', label: 'General Finance', area: 'q-fin' },
    ];
    env.fetchPapers = async (categories) => categories.map((id: string) => ({
      ...records(id, 1)[0], primaryCategory: id,
    }));

    await run(false);
    assert.equal(state.error, null);
    assert.ok(state.papers.some(paper => paper.primaryCategory === 'q-fin.GN'),
      'the finance paper must reach the displayed batch');
  });
}

// Trimmed OpenAlex W2020715063: no abstract in the record, linked to arXiv 1109.5103.
const electron = { ...records('electron', 1)[0], id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', arxivId: '1109.5103', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
function pendingRecords() {
  let resolve!: (records: Partial<Paper>[]) => void;
  const promise = new Promise<Partial<Paper>[]>(done => { resolve = done; });
  return { promise, resolve };
}

test('a restored snapshot asks again for the abstract and the type its session had not received', async t => {
  const visible = { ...records('visible', 1)[0], abstract: 'Source text.', sources: { primary: 'arxiv', enrichedBy: [] } };
  const unchecked = { ...records('unchecked', 1)[0], id: 'W568341909', doi: '10.1007/978-3-540-76956-9', publicationType: 'article', abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } };
  const snapshot = { papers: [visible, electron, unchecked], page: 1, hasMore: true };
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: 'book' })) } });
  });
  const { state, env, restore, loadingAbstracts } = feed();
  Object.assign(env, await freshPublications('restored-snapshot'));
  env.visiblePaperIdRef.current = visible.id;
  const recovery = pendingRecords();
  let recoveryRequests = 0;
  env.recoverFeedAbstracts = () => { recoveryRequests += 1; return recovery.promise; };
  let saved: Paper[] = [];
  env.scheduleFeedSnapshotWrite = (_uid, _key, written) => { saved = written.papers; };

  restore(snapshot);
  restore(snapshot);
  await wait(20);
  assert.deepEqual(state.papers.map(paper => paper.id), [visible.id, electron.id, unchecked.id]);
  assert.deepEqual([...loadingAbstracts()], [electron.id]);
  assert.equal(recoveryRequests, 1, 'the second restore of the same snapshot sends nothing');

  recovery.resolve([{ arxivId: '1109.5103', abstract: 'Recovered source text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
  await tick();
  assert.equal(state.papers[1].abstract, 'Recovered source text.');
  assert.deepEqual([...loadingAbstracts()], []);

  answer();
  await wait(20);
  // Crossref calls the third card a book; the reader is on the first.
  assert.deepEqual(state.papers.map(paper => paper.id), [visible.id, electron.id]);
  assert.deepEqual(saved.map(paper => paper.abstract), ['Source text.', 'Recovered source text.']);
});

test('a restored snapshot is written again only when a late answer changes a card, and keeps its save time', async () => {
  // The real writer, not a stub: it sets the save time that the next cold open
  // checks. It writes at once, without the 500 ms debounce, into a stand-in
  // for localStorage.
  const from = source.indexOf('function feedSnapshotKey(');
  const to = source.indexOf('// ── Demo mode storage helpers', from);
  assert.ok(from >= 0 && to > from, 'the snapshot helpers must exist');
  const snapshotWriter = (localStorage: { setItem: (key: string, value: string) => void }) => new Function(
    'localStorage', 'FEED_SNAPSHOT_MAX_PAPERS', `${stripTypeScriptTypes(source.slice(from, to))}; return writeFeedSnapshot;`,
  )(localStorage, 30);
  // Synthetic PubMed letter: Europe PMC has its record, and the card already carries it.
  const letter = PaperBuilder.create({ id: 'pmid:1', pmid: '1', title: 'Synthetic letter', authors: [], abstract: '', citationCount: 3, sources: { primary: 'pubmed', enrichedBy: ['europepmc'] } });
  for (const [record, rewritten] of [
    [{ pmid: '1', citationCount: 3 }, false],
    [{ pmid: '1', citationCount: 3, abstract: 'Europe PMC source text.' }, true],
  ] as const) {
    const { state, env, restore } = feed();
    env.enrichPubmedIds = async () => new Map([['1', record]]);
    const writes: Array<{ papers: Paper[]; savedAt: number }> = [];
    env.scheduleFeedSnapshotWrite = snapshotWriter({ setItem: (_key, value) => { writes.push(JSON.parse(value)); } });
    const snapshot = { papers: [letter], page: 1, hasMore: true, savedAt: 1_000 };
    restore(snapshot);
    await wait(20);
    assert.equal(state.papers === snapshot.papers, !rewritten);
    assert.deepEqual(writes.map(write => [write.papers[0].abstract, write.savedAt]), rewritten ? [['Europe PMC source text.', 1_000]] : []);
  }
});

// What each load asks arXiv for: categories and order.
function arxivQueries(env: ReturnType<typeof feed>['env']) {
  const asked: Array<{ categories: string[]; mode: string }> = [];
  env.fetchPapers = ((...args: unknown[]) => {
    const [categories, start, count, mode] = args as [string[], number, number, string];
    // Exploration asks for a handful from nearby categories; the main lane asks for a page.
    if (count === env.PAGE_SIZE) asked.push({ categories, mode });
    return Promise.resolve(records(`arxiv-${start}-${categories[0]}`));
  }) as typeof env.fetchPapers;
  return asked;
}

test('one skipped card keeps its interest in the first load', async () => {
  const interests = ['cs.AI', 'quant-ph', 'cs.LG', 'cond-mat.supr-con', 'cs.CV', 'cond-mat.str-el', 'cs.CL', 'cond-mat.mtrl-sci', 'cs.NE', 'cond-mat.mes-hall'];
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'skipped', kind: 'skip', category: 'cs.AI' });
  const { env, run } = feed();
  Object.assign(env, { userPreferences: interests, rankPreferences, CATEGORIES, profileSignals: ref(readProfileSignals(profile)) });
  const asked = arxivQueries(env);
  await run(true, null);
  assert.ok(asked[0].categories.includes('cs.AI'), `the first load asks for ${asked[0].categories}`);
});

test('a reader with no lean towards older papers gets the corpus newest first on every load', async t => {
  let draw = 0;
  t.mock.method(Math, 'random', () => draw);
  for (const [lean, preference, randomDraw, expected] of [
    ['none', 0, 0.01, 'recent'],
    ['none', 0, 0.99, 'recent'],
    ['older papers', -0.5, 0.01, 'relevance'],
  ] as const) {
    draw = randomDraw;
    const { env, run } = feed();
    env.temporalPreference.current = preference;
    const asked = arxivQueries(env);
    await run(true);
    assert.deepEqual(asked.map(query => query.mode), [expected], `lean ${lean}, Math.random() = ${draw}`);
  }
});

test('a page asks the corpus for the ranked categories with the likes, and a later page for nearby ones too', async t => {
  t.mock.method(Math, 'random', () => 0);
  for (const page of [0, 1]) {
    const asked: Array<Record<string, unknown>> = [];
    const { state, env, run } = feed({ page });
    Object.assign(env, {
      userPreferences: ['cs.AI'],
      getAllLeafCategories: () => [
        { id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' },
        { id: 'cs.LG', label: 'Machine Learning', area: 'cs' },
      ],
      selectSemanticProfilePositiveIds: () => ['2610.00001', 'pmid:41000001'],
      fetchCorpusPage: async (request: Record<string, unknown>) => {
        asked.push(request);
        return (request.categories as string[]).includes('cs.LG') ? records('nearby', 2) : records(`page-${page}`);
      },
    });
    await run(page === 0);
    assert.equal(state.error, null);
    // As many papers as the page shows: a paper asked for and not shown would
    // never come back, since the next page starts after it. It says what the
    // reader has seen, and asks for the unseen notable papers its places can
    // take, and two more for any the reader already knows: a first screen of
    // up to 21 cards has one place (the fifteenth), a later page of up to 31 two.
    const main = { categories: ['cs.AI'], positiveIds: ['2610.00001', 'pmid:41000001'], page, pageSize: 15, order: 'recent', seen: env.sessionSeenPapers.current, notable: page === 0 ? 3 : 4 };
    // A later page adds the reader's area's other category: five papers.
    assert.deepEqual(asked, page === 0 ? [main] : [main, { categories: ['cs.LG'], page: 0, pageSize: 5, order: 'recent' }]);
  }
});

const notableAt = (papers: FeedRecord[]) => papers.flatMap((paper, index) => (paper._notable ? [[index, paper.id]] : []));

test("the feed's fifteenth card is the corpus's notable one, counted from the cards already shown, and a seen one is not among the papers a feed falls back to", async () => {
  // The corpus's fifteen, and the two unseen notable papers it adds after them.
  const corpusPage = [...records('corpus', 15), ...records('notable', 2).map(paper => ({ ...paper, _notable: true }))];
  const shown = feed({ seen: ['viewed-yesterday'] });
  const asked: Array<{ seen?: Set<string> }> = [];
  Object.assign(shown.env, { fetchCorpusPage: async (request: { seen?: Set<string> }) => { asked.push(request); return corpusPage; } });
  await shown.run(true);
  assert.equal(asked[0].seen?.has('viewed-yesterday'), true);
  // Every paper of the corpus's page, and one notable card, fifteenth.
  assert.equal(shown.state.papers.length, 16);
  assert.deepEqual(notableAt(shown.state.papers), [[14, 'notable-0']]);

  // Ten cards on screen: the next page's fifth card is the feed's fifteenth.
  const later = feed({ papers: records('shown', 10), page: 1 });
  Object.assign(later.env, { fetchCorpusPage: async () => corpusPage });
  await later.run(false);
  assert.equal(later.state.papers.length, 26);
  assert.deepEqual(notableAt(later.state.papers), [[14, 'notable-0']]);

  // A refresh that keeps the reader's place counts from the cards it keeps,
  // through the visible one: the next notable card is fifteen after theirs.
  const kept = feed({ papers: records('shown', 20).map((paper, index) => ({ ...paper, _notable: index === 14 })) });
  kept.env.visiblePaperIdRef.current = 'shown-16';
  Object.assign(kept.env, { fetchCorpusPage: async () => corpusPage });
  await kept.run(true, 'top', undefined, { keepThroughVisible: true });
  assert.deepEqual(notableAt(kept.state.papers), [[14, 'shown-14'], [29, 'notable-0']]);

  // Every card seen: the papers shown again while later pages are tried leave the notable ones out.
  const allSeen = feed({ seen: corpusPage.map(paper => paper.id) });
  Object.assign(allSeen.env, { fetchCorpusPage: async () => corpusPage });
  await allSeen.run(true);
  const [[, , , { seenFallback }]] = allSeen.state.continuations as Array<[unknown, unknown, unknown, { seenFallback: { papers: FeedRecord[] } }]>;
  assert.equal(seenFallback.papers.length, 15);
  assert.ok(!seenFallback.papers.some(paper => paper._notable));
});

// The corpus offers a reader's unseen notable papers in one fixed order. Had
// a viewed notable card left `seen` with the 500-id viewed ring, the corpus
// would offer it again before any the reader never saw: in the re-review's
// probe, 100 notable places showed 34 distinct papers.
test('a notable card the reader viewed is not offered again, however many cards they viewed after it', async t => {
  t.mock.method(console, 'log', () => {});
  const storage = memoryStorage();
  const aggregate = createEmptyInteractionProfile();
  const deviceA = viewing({ storage, recordProfileEvent: event => { recordInteractionEvent(aggregate, event); } });
  await deviceA.trackViewTime({ ...paperRecord('notable-viewed'), _notable: true }, 4);
  await deviceA.trackSkips(Array.from({ length: MAX_VIEWED_IDS }, (_, index) => paperRecord(`viewed-after-${index}`)));

  // The next load: what this browser kept and the account's aggregate as stored.
  const { state, env, run } = feed({ seen: deviceA.stored() });
  viewing({ seen: env.sessionSeenPapers }).carryViewedPapers(deserializeInteractionProfile(serializeInteractionProfile(aggregate))!);
  const asked: Array<{ seen?: Set<string> }> = [];
  const corpusPage = [...records('corpus', 15), { ...paperRecord('notable-viewed'), _notable: true }];
  Object.assign(env, { fetchCorpusPage: async (request: { seen?: Set<string> }) => { asked.push(request); return corpusPage; } });
  await run(true);
  assert.equal(asked[0].seen?.has('notable-viewed'), true, 'the corpus is told the reader saw it');
  assert.equal(state.papers.length, 15);
  assert.ok(!state.papers.some(paper => paper.id === 'notable-viewed'), 'and the feed does not show it');
});

// A first screen of 21 cards and a later page of 31, placed as the loader
// places them: notable cards 15th, 30th and 45th of 55.
function feedWithNotableCards() {
  const card = (id: string, index: number) => ({ ...paperRecord(id), primaryCategory: ['cs.CV', 'cs.LG', 'cs.AI'][index % 3] });
  const notable = (id: string) => ({ ...paperRecord(id), _notable: true });
  const first = placeNotableCards(Array.from({ length: 21 }, (_, index) => card(`first-${index}`, index)), [notable('notable-0')]);
  return [...first, ...placeNotableCards(Array.from({ length: 31 }, (_, index) => card(`later-${index}`, index)), [notable('notable-1'), notable('notable-2')], first)];
}
// The same draws on every run: the shuffle weighs its picks with Math.random.
const seededRandom = () => { let seed = 7; return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; };

// The re-rank after a view, a like or a save shuffles the cards below the
// reader. Before, it shuffled the notable cards with them: in the review's
// probe, 500 of 500 re-ranks moved them and 292 left two fewer than 8 cards apart.
test('a re-rank and a related-papers insert keep a notable card at every fifteenth card', async t => {
  t.mock.method(Math, 'random', seededRandom());
  t.mock.method(console, 'log', () => {});
  const placed = [[14, 'notable-0'], [29, 'notable-1'], [44, 'notable-2']];
  const state = { papers: feedWithNotableCards() };
  assert.deepEqual(notableAt(state.papers), placed);
  const shuffling = {
    setPapers: (value: FeedRecord[] | ((previous: FeedRecord[]) => FeedRecord[])) => { state.papers = typeof value === 'function' ? value(state.papers) : value; },
    // The reader is on the 16th card, just past the first notable one.
    visiblePaperIdRef: ref<string | null>(state.papers[15].id),
    splitFeedForReRank, diversifiedWeightedShuffle, placeNotableCards, calculateAndAttachScore: () => 0, recommendationWeights: ref({}), logRankingBatch: () => {},
  };
  const reRankFeed = callbackIn(componentCallback('reRankFeed', 'calculateAndAttachScore'), {
    ...shuffling, startTransition: (update: () => void) => update(),
  }) as (sourcePaperId?: string | null) => void;
  const ids = new Set(state.papers.map(paper => paper.id));
  for (let run = 0; run < 20; run += 1) {
    reRankFeed(run % 2 ? 'first-3' : null);
    assert.deepEqual(notableAt(state.papers), placed, `re-rank ${run + 1}`);
    assert.deepEqual(new Set(state.papers.map(paper => paper.id)), ids);
  }

  // A like inserts the corpus's closest papers below the reader and shuffles the rest.
  const expand = callbackIn(componentCallback('traverseAndExpandNetwork', 'calculateAndAttachScore, isKnownPaper, userPreferences'), {
    ...shuffling, feedSessionId: ref(0), activeUserId: ref('test-user'), isTraversingNetwork: ref(false), userPreferences: ['cs.AI'], MAIN_CATEGORIES: 10,
    likedPaperIdsRef: ref(new Set()), savedPaperIdsRef: ref(new Set()), readPaperIdsRef: ref(new Set()), notInterestedIdsRef: ref(new Set()),
    sessionSeenPapers: ref(new Set(ids)), isKnownPaper: () => false,
    fetchCorpusPage: async () => records('related', 3),
  }) as (paper: FeedRecord) => Promise<void>;
  await expand(state.papers.find(paper => paper.id === 'later-0')!);
  assert.equal(state.papers.length, 58);
  assert.ok(records('related', 3).every(paper => state.papers.some(card => card.id === paper.id)));
  assert.deepEqual(notableAt(state.papers), placed);
});

// The corpus is told the papers the reader has seen, and leaves out only the
// likes and saves it ranks by. A paper the reader saved from elsewhere is
// unseen to it: the feed drops it (isAvailablePaper), and its place stayed
// empty on every page (2 of 3 places in the review's probe).
test('a notable paper the reader already saved leaves its place to an unseen one, and later pages tell the corpus it is known', async () => {
  // The corpus's notable papers in its one order, unseen ones first as many as asked.
  const order = ['saved-classic', 'notable-a', 'notable-b', 'notable-c', 'notable-d', 'notable-e'];
  const asked: boolean[] = [];
  const { state, env, run } = feed();
  env.savedPaperIdsRef.current = new Set(['saved-classic']);
  Object.assign(env, {
    fetchCorpusPage: async (request: { page: number; notable?: number; seen?: Set<string> }) => {
      asked.push(request.seen?.has('saved-classic') ?? false);
      const unseen = order.filter(id => !request.seen?.has(id)).slice(0, request.notable ?? 0);
      return [...records(`corpus-${request.page}`, 15), ...unseen.map(id => ({ ...paperRecord(id), _notable: true }))];
    },
  });
  await run(true);
  await run(false);
  await run(false);
  assert.equal(state.papers.length, 48);
  assert.deepEqual(notableAt(state.papers), [[14, 'notable-a'], [29, 'notable-b'], [44, 'notable-c']]);
  assert.deepEqual(asked, [false, true, true]);
});

// A like asks the corpus for papers like the one just liked (traverseAndExpandNetwork).
// The corpus may not have embedded that paper yet: the request says to wait
// for it, which the feed's own pages never do.
test('More like this asks the Worker to rank by the paper just liked once the corpus has it', async () => {
  const bodies: unknown[] = [];
  const fetchWorker = async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ papers: [] }), { status: 200 });
  };
  const expand = callbackIn(componentCallback('traverseAndExpandNetwork', 'calculateAndAttachScore, isKnownPaper, userPreferences'), {
    feedSessionId: ref(0), activeUserId: ref('test-user'), isTraversingNetwork: ref(false), userPreferences: ['cs.AI'], MAIN_CATEGORIES: 10,
    fetchCorpusPage: (request: Parameters<typeof fetchCorpusPage>[0]) => fetchCorpusPage(request, { fetchWorker, apiBase: 'https://api.example' }),
  }) as (paper: FeedRecord) => Promise<void>;
  await expand({ ...paperRecord('2610.00001'), primaryCategory: 'cs.LG' });
  assert.deepEqual(bodies, [{ categories: ['cs.LG', 'cs.AI'], follows: [], positiveIds: ['2610.00001'], page: 0, pageSize: 15, order: 'recent', waitForLikes: true }]);
});

const followedAuthor = { type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' };
// The follows' request as the loader makes it; `answer` stands in for the corpus.
const withFollows = (env: ReturnType<typeof feed>['env'], answer: (request: { page: number }) => FeedRecord[]) => Object.assign(env, {
  followedEntities: [followedAuthor],
  loadTopicRetrieval: async () => ({ getFollowedTopicCategoryIds: () => [] }),
  fetchFollowedEntityCandidates: async (_follows: unknown, request: { page: number }) => answer(request),
});

test("a page shows every paper it asked the corpus for: the reader's fifteen and the follows' six", async () => {
  const { state, env, run } = feed();
  withFollows(env, () => records('followed', 6));
  Object.assign(env, { fetchCorpusPage: async ({ pageSize }: { pageSize: number }) => records('main', pageSize) });
  await run(true);
  assert.equal(state.error, null);
  assert.deepEqual(state.papers.map(paper => paper.id).sort(), [...records('main'), ...records('followed', 6)].map(paper => paper.id).sort());
});

test("a pull to refresh asks for the corpus's first page, the follows' first page too", async t => {
  // Whatever Math.random draws: a refresh is no lottery over the first pages.
  t.mock.method(Math, 'random', () => 0.5);
  const asked: string[] = [];
  const { state, env, refresh } = feed();
  withFollows(env, ({ page }) => { asked.push(`follows ${page}`); return records('followed', 6); });
  Object.assign(env, {
    fetchCorpusPage: async ({ page }: { page: number }) => { asked.push(`main ${page}`); return records('main'); },
    // The refresh's 800 ms minimum, at once.
    setTimeout: (callback: () => void) => setTimeout(callback, 0),
  });
  await refresh();
  assert.equal(state.error, null);
  assert.deepEqual(asked.sort(), ['follows 0', 'main 0']);
});

// The follows the feed asks the corpus for, built from the stored follows.
const followedCandidates = (() => {
  const from = source.indexOf('async function fetchFollowedEntityCandidates(');
  const to = source.indexOf('\n}\n', from);
  assert.ok(from >= 0 && to > from, 'fetchFollowedEntityCandidates must exist');
  return stripTypeScriptTypes(source.slice(from, to + 2));
})();

test('followed authors and category topics come back as followed papers, each with the follows it matched', async () => {
  const asked: Array<Record<string, unknown>> = [];
  const author = { type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' };
  const topic = { type: 'topic', canonicalId: 'cs.LG', displayName: 'Machine Learning' };
  const fetchFollowed = new Function('fetchCorpusPage', 'FOLLOWED_PER_PAGE', 'mergeFollowEntityMatches', `${followedCandidates}; return fetchFollowedEntityCandidates;`)(
    async (request: Record<string, unknown>) => {
      asked.push(request);
      return [
        { ...records('by-author', 1)[0], _followedEntityMatches: [{ type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' }] },
        { ...records('in-topic', 1)[0], _fetchedFor: ['cs.LG'] },
      ];
    },
    6,
    (...groups: unknown[][]) => groups.flat().filter(Boolean),
  );
  const papers = await fetchFollowed([author, topic], {
    page: 2, order: 'recent', positiveIds: ['2610.00001'], categoryIdsOf: (follow: { canonicalId: string }) => (follow.canonicalId === 'cs.LG' ? ['cs.LG'] : []),
  });
  assert.deepEqual(asked, [{ categories: ['cs.LG'], follows: [author, topic], positiveIds: ['2610.00001'], page: 2, pageSize: 6, order: 'recent' }]);
  assert.deepEqual(papers.map((paper: Paper) => [paper.id, paper._type, (paper._followedEntityMatches as Array<{ canonicalId: string }>).map(match => match.canonicalId)]), [
    ['by-author-0', 'followed', ['A5023888391']],
    ['in-topic-0', 'followed', ['cs.LG']],
  ]);
});

test('a corpus that fails leaves the feed in its error state with one retry, not an empty end', async t => {
  t.mock.method(console, 'error', () => {});
  const { state, env, run } = feed();
  env.fetchPapers = () => Promise.reject(new Error('Paper store returned 503'));
  const timers: Array<() => void> = [];
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => { timers.push(callback); return 0; });
  await run(true);
  assert.equal(state.error, 'FEED_LOAD_FAILED');
  assert.deepEqual(state.papers, []);
  assert.equal(timers.length, 1, 'one automatic retry is scheduled');
});
