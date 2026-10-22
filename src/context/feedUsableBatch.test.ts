import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { CATEGORIES } from '../data/categoryTaxonomy.ts';
import { resolveWithin } from '../utils/asyncTiming.ts';
import { abstractsInFlight, takeFeedPage, preserveFeedAbstracts, mergeOpenAlexEnrichment, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { createEmptyInteractionProfile, deserializeInteractionProfile, readProfileSignals, recordInteractionEvent, serializeInteractionProfile, viewedIds } from '../utils/interactionProfile.ts';
import { clearUserScopedStorage, readSeenPaperIds, removeLegacySeenPaperIds, saveSeenPaperIds } from '../utils/userScopedStorage.ts';
import { rankPreferences } from '../utils/preferenceRanking.ts';
import { pickExplorationCategories } from '../utils/recommendationEngine.ts';
import { applyKnownPublicationTypes, classifyFeedPublications, dropUnreachedPublications } from '../services/feedPublicationService.ts';
import { isFeedPublication } from '../services/feedPublicationRules.ts';
import { abstractWaitIds, openAbstractWait } from '../utils/feedAbstractWait.ts';
import { mergeFreshFeedPage } from '../utils/feedReRankSplit.ts';

import { mergeEuropePmcEnrichment } from '../services/europePmcRecords.ts';
import { mergeICiteEnrichment } from '../services/iCiteRecords.ts';

// Execute the actual loader callback with provider and React-state boundaries
// injected. Source-pattern tests cannot catch an excluded page ending the feed.
const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('async (reset = false, mode?: string | null, randomizeStart = false, pageOverride?: number,');
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
// as arXiv was, followed by `slow`, the rest of the corpus's answer. A main
// page asks for two pages' worth and is counted as one page.
function withCorpusStandIn<T extends { fetchPapers: unknown; restOfPage: () => Promise<FeedRecord[]>; PAGE_SIZE: number }>(scope: T) {
  const fetchPapers = scope.fetchPapers as (...args: unknown[]) => Promise<FeedRecord[]>;
  return {
    fetchCorpusPage: async ({ categories, page, pageSize, order }: { categories: string[]; page: number; pageSize: number; order: string }) => {
      const count = pageSize === scope.PAGE_SIZE * 2 ? scope.PAGE_SIZE : pageSize;
      return [...await fetchPapers(categories, page * scope.PAGE_SIZE, count, order), ...await scope.restOfPage()];
    },
    selectSemanticProfilePositiveIds: () => [], curatedIds: () => [], interactionProfile: ref(null),
    // A test that asks the corpus double itself sets these on the scope.
    ...scope,
  };
}

function feed({ fast = records('fast'), slow = [], known = [], seen = [], page = 0, papers = [] }: { fast?: FeedRecord[]; slow?: FeedRecord[] | Promise<FeedRecord[]>; known?: string[]; seen?: string[]; page?: number; papers?: FeedRecord[] } = {}) {
  const state = { papers, page, loading: false, hasMore: true, error: null as string | null, continuations: [] as unknown[][], abstractWaits: [] as ReadonlyArray<ReadonlySet<string>> };
  const env = {
    userPreferences: ['cs.AI'], recommendationProfileReady: true, feedMode: 'top', PAGE_SIZE: 15, RESET_START_PAGES: 5,
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
    recommendationWeights: ref({}), takeFeedPage, mergeFreshFeedPage,
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
    assert.equal(state.papers.length, 15);
    assert.equal(state.hasMore, true);
    assert.ok(state.papers.every(paper => !records('fast', excludedCount).some(known => known.id === paper.id)));
  });
}

test('session-seen papers also do not satisfy the first-page readiness threshold', async () => {
  const { state, run } = feed({ slow: records('fresh'), seen: records('fast', 13).map(paper => paper.id) });
  await run(true);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.ok(state.papers.every(paper => !paper.id.startsWith('fast-') || Number(paper.id.split('-')[1]) >= 13));
});

test('an entirely known page advances instead of declaring provider exhaustion', async () => {
  const { state, run } = feed({ known: records('fast').map(paper => paper.id) });
  await run(true);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.hasMore, true);
  // A reset goes on as the same load, still a reset, on the next page.
  assert.deepEqual(state.continuations, [[true, 'top', false, 1, { keepThroughVisible: false, seenFallback: undefined }]]);
});

// A reload starts on a random one of the first pages; Math.random() at 0.2
// makes it page 1 (arXiv start 15). Each page holds papers of its own.
function reloadOnPageOne(t: import('node:test').TestContext, { seen = [] as string[], papers = [] as FeedRecord[], page = (start: number) => records(`page-${start / 15}`) } = {}) {
  t.mock.method(Math, 'random', () => 0.2);
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

// The browser check of 2026-10-21: after five reloads every page a reload
// starts on (0 to 4) had been shown, and the sixth showed page 1 again.
test('a reload after every start page was shown shows unseen papers from a later page', async t => {
  const { state, env, run, starts } = reloadOnPageOne(t, { seen: pageIds(0, 1, 2, 3, 4) });
  env.loadPapersRef.current = run;
  const steps: string[] = [];
  const { setLoading, setPapers } = env;
  env.setLoading = value => { steps.push(`loading ${value}`); setLoading(value); };
  env.setPapers = value => { setPapers(value); steps.push(`${state.papers.length} papers`); };
  await run(true, null, true);
  assert.equal(state.error, null);
  assert.equal(starts[0], 15, 'the reload started on page 1');
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => pageIds(0, 1, 2, 3, 4).includes(id)), [],
    'no paper shown before is shown again');
  assert.equal(starts.length, 2, 'one more page was asked for');
  assert.ok(steps.indexOf('15 papers') < steps.indexOf('loading false'),
    `the first screen stays loading until the later page is shown: ${steps.join(', ')}`);
});

test('a refresh whose start page was all shown before replaces the cards on screen with unseen ones', async t => {
  const onScreen = records('page-1');
  const { state, env, run } = reloadOnPageOne(t, { seen: pageIds(1), papers: onScreen });
  env.loadPapersRef.current = run;
  await run(true, null, true);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => id.startsWith('page-1-')), [],
    'the list is replaced, neither shown again nor extended');
});

for (const [name, page] of [
  ['every later page was shown before too', (start: number) => records(`page-${start / 15}`)],
  ['no later page has papers', (start: number) => start === 15 ? records('page-1') : []],
] as const) {
  test(`a reload whose start page was all shown before still gets a feed when ${name}`, async t => {
    const everyPage = Array.from({ length: 30 }, (_, index) => records(`page-${index}`)).flat().map(paper => paper.id);
    const { state, env, run, starts } = reloadOnPageOne(t, { seen: everyPage, page });
    env.loadPapersRef.current = run;
    await run(true, null, true);
    assert.equal(state.error, null);
    assert.equal(state.papers.length, 15, 'the feed is not empty');
    assert.equal(state.hasMore, true, 'the reader can scroll on');
    assert.ok(starts.length <= 3, `at most two more pages are asked for: ${JSON.stringify(starts)}`);
  });
}

test('after a reload shows its seen start page because the later page was empty, scrolling goes on from the page after it', async t => {
  // Page 1 was shown before, pages 2 to 4 were not, and nothing comes after page 4.
  const { state, env, run, starts } = reloadOnPageOne(t, {
    seen: pageIds(1),
    page: start => start < 75 ? records(`page-${start / 15}`) : [],
  });
  env.loadPapersRef.current = run;
  await run(true, null, true);
  assert.deepEqual(state.papers.map(paper => paper.id), pageIds(1));
  assert.equal(state.hasMore, true);
  // The reader reaches the end of the list.
  await run(false);
  assert.equal(state.error, null);
  assert.deepEqual(starts, [15, 90, 30]);
  assert.deepEqual(state.papers.map(paper => paper.id), pageIds(1, 2));
});

// The later page is rarely in the Worker's edge cache, so it is the one that
// waits for a seat at arXiv and can be refused.
for (const status of [429, 502]) {
  test(`a reload whose start page was all shown before shows those papers when arXiv answers the later page with ${status}`, async t => {
    const { state, env, run, starts } = reloadOnPageOne(t, { seen: pageIds(0, 1, 2, 3, 4) });
    env.loadPapersRef.current = run;
    env.fetchPapers = (_categories: string[], start = 0) => {
      starts.push(start);
      return start === 15
        ? Promise.resolve(records('page-1'))
        : Promise.reject(Object.assign(new Error(`arXiv API error: ${status}`), { status }));
    };
    // Every timer the loader sets fires at once, so a retry would already have run.
    Object.assign(env, { setTimeout: (callback: () => void) => setTimeout(callback, 0) });
    await run(true, null, true);
    await wait(20);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), pageIds(1), 'the start page is shown again');
    assert.equal(state.hasMore, true, 'the reader can scroll on');
    assert.deepEqual(starts, [15, 90], 'no request after the refused one');
  });
}

test('a reload whose start page has unseen papers asks for no other page', async t => {
  // A source returns a wider pool than a page: 20 papers, 5 shown before.
  const { state, run, starts } = reloadOnPageOne(t, {
    seen: records('page-1', 5).map(paper => paper.id),
    page: start => records(`page-${start / 15}`, 20),
  });
  await run(true, null, true);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(starts, [15]);
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
function viewing({ user = 'test-user' as string | null, seen = ref(new Set<string>()), storage = memoryStorage(), traverseAndExpandNetwork = (() => {}) as (paper: FeedRecord) => void } = {}) {
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
    countEngagement: () => {}, recordProfileEvent: () => {}, scheduleReRank: () => {}, traverseAndExpandNetwork,
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
  const deviceB = deviceBReadingAGroup(records('page-1'));
  const { state, env, run, starts } = reloadOnPageOne(t);
  viewing({ seen: env.sessionSeenPapers }).carryViewedPapers(deviceB);
  env.loadPapersRef.current = run;
  await run(true, null, true);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => pageIds(1).includes(id)), [], 'nothing A viewed comes back');
  assert.deepEqual(starts, [15, 90], 'the reload skipped past A\'s page');
});

test('a short pool the other device viewed whole still gives a feed', async t => {
  const pool = records('page-1', 6);
  const deviceB = deviceBReadingAGroup(pool);
  const { state, env, run } = reloadOnPageOne(t, { page: start => start === 15 ? pool : [] });
  viewing({ seen: env.sessionSeenPapers }).carryViewedPapers(deviceB);
  env.loadPapersRef.current = run;
  await run(true, null, true);
  assert.equal(state.error, null);
  assert.deepEqual(state.papers.map(paper => paper.id), pool.map(paper => paper.id), 'the feed is not empty: the viewed pool is shown again');
  assert.equal(state.hasMore, true);
});

// After a browser reload the snapshot's cards are on screen again, but the
// reader's viewed list names only the ones that reported a view: the card on
// screen when the tab closed never ran its cleanup.
test('a refresh after a reload does not offer the restored cards again', async t => {
  const { state, env, run, restore, starts } = reloadOnPageOne(t);
  env.loadPapersRef.current = run;
  const restored = records('page-1').map(paper => ({ ...paper, abstract: 'Source text.', sources: { primary: 'arxiv', enrichedBy: [] } }));
  restore({ papers: restored, page: 1, hasMore: true });
  await run(true, null, true);
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.map(paper => paper.id).filter(id => pageIds(1).includes(id)), [], 'no restored card comes back');
  assert.deepEqual(starts, [15, 90], 'the refresh skipped past the restored page');
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
  assert.deepEqual(state.continuations, [[false, 'top', false, 1]]);
  const firstIds = state.papers.map(paper => paper.id);
  env.fetchPapers = () => Promise.resolve(records('next', 13));
  await run(...state.continuations.shift()!);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.length, 15);
  assert.deepEqual(state.papers.slice(0, 2).map(paper => paper.id), firstIds);
  assert.deepEqual(state.continuations, []);
});

test('genuinely empty providers end the feed without scheduling another page', async () => {
  const { state, run } = feed({ fast: [] });
  await run(true);
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.hasMore, false);
  assert.deepEqual(state.continuations, []);
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
    const resetLoad = mounted.loadPapers(true, null, true);
    mounted.loadMore();
    render().commit();
    open();
    await resetLoad;

    const firstPage = records('first', 5).map(paper => paper.id);
    const firstWave = requests.filter(request => !request.painted);
    assert.equal(firstWave.length, 1, 'one corpus request before the first page is shown');
    assert.notEqual(firstWave[0].start, 0, 'the reset load asks for its random start page');
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
    const random = t.mock.method(Math, 'random', () => 0.5);
    const { state, env } = feed();
    // As above: cancels what the real loader in loadPapersRef still has scheduled.
    t.after(() => { env.feedSessionId.current += 1; });
    const starts: number[] = [];
    const render = renders(state, env, {
      // Five papers on the first load's random start page, 2, and fifteen elsewhere.
      fetchPapers: async (_categories: string[], start: number) => {
        starts.push(start);
        return start === 30 ? records('first', 5) : records(`page-${start / 15}`, 15);
      },
    });

    const mounted = render();
    mounted.commit();
    const firstLoad = mounted.loadPapers(true, null, true);
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
      random.mock.mockImplementation(() => 0);
      await render().loadPapers(true, null, true);
      render().commit();
    } else {
      // What the account effect does when the user changes.
      env.feedSessionId.current += 1;
    }
    scheduled[0]();
    await wait(20);
    // The first feed's next page, 3, starts at 45.
    assert.deepEqual(starts, reset ? [30, 0] : [30], 'no request for the stored page');
    assert.deepEqual(state.papers.map(paper => paper.id), (reset ? records('page-0', 15) : records('first', 5)).map(paper => paper.id));
    assert.equal(state.page, reset ? 1 : 3);
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

test('one skipped card keeps its interest in the first load, whatever page that load starts on', async t => {
  const interests = ['cs.AI', 'quant-ph', 'cs.LG', 'cond-mat.supr-con', 'cs.CV', 'cond-mat.str-el', 'cs.CL', 'cond-mat.mtrl-sci', 'cs.NE', 'cond-mat.mes-hall'];
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'skipped', kind: 'skip', category: 'cs.AI' });
  let draw = 0;
  t.mock.method(Math, 'random', () => draw);
  const loads: Array<{ categories: string[]; nextPage: number }> = [];
  for (const randomDraw of [0, 0.3, 0.5, 0.7, 0.9]) {
    draw = randomDraw;
    const { state, env, run } = feed();
    Object.assign(env, { userPreferences: interests, rankPreferences, CATEGORIES, profileSignals: ref(readProfileSignals(profile)) });
    const asked = arxivQueries(env);
    // The feed's first load: loadPapers(true, null, true) starts on a random page.
    await run(true, null, true);
    loads.push({ categories: asked[0].categories, nextPage: state.page });
  }

  assert.equal(new Set(loads.map(load => load.nextPage)).size, loads.length, 'the first loads start on different pages');
  for (const load of loads) {
    assert.ok(load.categories.includes('cs.AI'), `the first load before page ${load.nextPage} asks for ${load.categories}`);
  }
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
    const main = { categories: ['cs.AI'], positiveIds: ['2610.00001', 'pmid:41000001'], page, pageSize: 30, order: 'recent' };
    // A later page adds the reader's area's other category: five papers' worth, twice over.
    assert.deepEqual(asked, page === 0 ? [main] : [main, { categories: ['cs.LG'], page: 0, pageSize: 10, order: 'recent' }]);
  }
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
