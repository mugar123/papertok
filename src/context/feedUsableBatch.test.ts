import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { ARXIV_FEED_AREAS } from '../services/arxivService.ts';
import { CATEGORIES } from '../data/categoryTaxonomy.ts';
import { fulfilledPaperLists, resolveWithin, settleSourcesForFirstPaint } from '../utils/asyncTiming.ts';
import { lateSourceCandidates } from '../utils/feedLateCandidates.ts';
import { abstractsInFlight, takeFeedPage, preserveFeedAbstracts, mergeOpenAlexEnrichment, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { shouldAbortFeedLoad } from '../utils/feedLoadGuard.ts';
import { readProfileSignals } from '../utils/interactionProfile.ts';
import { pickExplorationCategories } from '../utils/recommendationEngine.ts';
import { applyKnownPublicationTypes, classifyFeedPublications, dropUnreachedPublications, isFeedPublication } from '../services/feedPublicationService.ts';
import { abstractWaitIds, openAbstractWait } from '../utils/feedAbstractWait.ts';
import { mergeFreshFeedPage } from '../utils/feedReRankSplit.ts';
import { settleWithin } from '../test-support/deadlineHarness.ts';

import { mergeEuropePmcEnrichment } from '../services/europePmcService.ts';
import { mergeICiteEnrichment } from '../services/iCiteService.ts';
import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';
import { awaitWithinGate, CITATION_GATE_MAX_WAIT_MS } from '../utils/feedCitationGate.ts';
import { fetchOpenAlexTopicPapers, fetchWorkingPapers } from '../services/domainSourceService.ts';
import { openAlexClient } from '../services/openAlexClient.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { reviewStatusForPaper } from '../utils/paperStatus.ts';

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

function feed({ fast = records('fast'), slow = [], known = [], seen = [], page = 0, papers = [] }: { fast?: FeedRecord[]; slow?: FeedRecord[] | Promise<FeedRecord[]>; known?: string[]; seen?: string[]; page?: number; papers?: FeedRecord[] } = {}) {
  const state = { papers, page, loading: false, hasMore: true, error: null as string | null, continuations: [] as unknown[][], abstractWaits: [] as ReadonlyArray<ReadonlySet<string>> };
  const env = {
    userPreferences: ['cs.AI'], recommendationProfileReady: true, feedMode: 'top', PAGE_SIZE: 15,
    feedRequestId: ref(0), feedSessionId: ref(0), feedLoadInFlight: ref(false), loadAfterCommit: ref<object | null>(null),
    openAlexEnrichmentAttempts: ref(new Set()), openAlexEnrichmentRequests: ref(new Map()),
    lateSourceCandidatesRef: ref([]), latePoolGenerationRef: ref(0),
    setLoading: (value: boolean) => { state.loading = value; }, setError: (value: string | null) => { state.error = value; },
    setPapers: (value: FeedRecord[] | ((previous: FeedRecord[]) => FeedRecord[])) => { state.papers = typeof value === 'function' ? value(state.papers) : value; },
    setPage: (value: number) => { state.page = value; }, setHasMore: (value: boolean) => { state.hasMore = value; },
    getAllLeafCategories: () => [{ id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' }],
    followedEntities: [], profileSignals: ref(readProfileSignals(null)), temporalPreference: ref(0),
    rankPreferences: <T>(values: T) => values, CATEGORIES: { cs: { subcategories: { 'cs.AI': 'Artificial Intelligence' } } } as Record<string, { subcategories: Record<string, string | { label: string }> }>,
    ARXIV_FEED_AREAS, fetchPapers: (() => Promise.resolve(fast)) as (categories: string[]) => Promise<FeedRecord[]>, PubmedAdapter: class {},
    // `slow` stands for any later main source; the loader pools them alike.
    fetchDomainPapers: () => Promise.resolve(slow), fetchWorkingPapers: (() => Promise.resolve([])) as typeof fetchWorkingPapers,
    fetchOpenAlexTopicPapers: (() => Promise.resolve([])) as typeof fetchOpenAlexTopicPapers,
    relatedCandidates: ref([]),
    personalCandidates: ref([]), fetchPersonalPapers: () => Promise.resolve([]), PERSONAL_CANDIDATES_PER_PAGE: 5,
    pickExplorationCategories,
    FEED_SOURCE_RENDER_BUDGET_MS: 5, OPTIONAL_SOURCE_RENDER_BUDGET_MS: 5, OPENALEX_TOPIC_READY_LIMIT: 10,
    settleSourcesForFirstPaint: (promises: Iterable<unknown[]|PromiseLike<unknown[]>>, ms: number, ready: ((papers: unknown[]) => boolean)|undefined, options: Parameters<typeof settleSourcesForFirstPaint>[3] = {}) => settleSourcesForFirstPaint(promises, ms, ready, { ...options, allTimeoutMs: 200 }),
    resolveWithin, fulfilledPaperLists, PaperBuilder, lateSourceCandidates, shouldAbortFeedLoad,
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
    fetchICiteMetrics: () => Promise.resolve({}), enrichPubmedIds: () => Promise.resolve(new Map()),
    awaitWithinGate, CITATION_GATE_MAX_WAIT_MS, hasUsableAIAbstract,
    recoverFeedAbstracts: (async () => []) as (papers: Paper[]) => Promise<Partial<Paper>[]>,
    mergeOpenAlexEnrichment, preserveFeedAbstracts, mergeFeedAbstracts, mergeEuropePmcEnrichment, mergeICiteEnrichment,
    abstractsInFlight,
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
    return build(callback, withFollowUp())(...args);
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

test('the signed-in loader shows a page before Crossref answers, then drops only the books the reader has not reached', async t => {
  const video: Paper[] = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
    { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/review-feed', title: 'Synthetic scientific review', publicationType: 'review' },
  ].map(work => ({ publicationType: 'article', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, ...work }));
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const shown = ['W568341909', 'W93572185', 'W3029239115', 'scientific-review'];
  const read = records('read', 3);
  for (const [page, existing, kept] of [
    // On the first page the two books are the cards on screen, so they stay.
    [0, [], shown],
    [1, read, [...read.map(paper => paper.id), 'W3029239115', 'scientific-review']],
  ] as const) {
    const publications = await freshPublications(`signed-in-${page}`);
    const { state, env, run } = feed({ fast: [], slow: video, page, papers: [...existing] });
    Object.assign(env, publications);
    env.visiblePaperIdRef.current = existing[0]?.id ?? null;
    const loading = run(page === 0);
    await wait(100);
    assert.deepEqual(state.papers.map(paper => paper.id), [...existing.map(paper => paper.id), ...shown],
      'the bibliographic review is excluded at once and the unchecked DOIs are shown');
    answer();
    await loading;
    await wait(20);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), kept);
  }
});

test('a Crossref answer that lands during the first-screen wait keeps its books off the first paint', async t => {
  const page = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
  ].map(work => ({ publicationType: 'article', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, ...work }));
  const books = new Set(['W568341909', 'W93572185']);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  for (const [name, slow, shown] of [
    ['an article among books', page, ['W3029239115']],
    ['only books', page.filter(paper => books.has(paper.id)), []],
  ] as const) {
    const { state, env, run } = feed({ fast: [], slow: [...slow] });
    Object.assign(env, await freshPublications(`answered-during-wait-${shown.length}`));
    // Recovery is still running, so the first screen waits its whole budget.
    const recovery = pendingRecords();
    env.recoverFeedAbstracts = () => recovery.promise;
    env.CITATION_GATE_MAX_WAIT_MS = 300;
    const paints: string[][] = [];
    const setPapers = env.setPapers;
    env.setPapers = value => {
      setPapers(value);
      paints.push(state.papers.map(paper => paper.id));
    };
    await run(true);
    await wait(20);
    assert.equal(state.error, null, name);
    assert.ok(paints.every(ids => !ids.some(id => books.has(id))), `${name}: ${JSON.stringify(paints)}`);
    assert.deepEqual(state.papers.map(paper => paper.id), shown, name);
    // A short or emptied first page asks for the next one instead of ending the feed.
    assert.deepEqual(state.continuations, [[false, 'top', false, 1]], name);
    recovery.resolve([]);
  }
});

test('a card dismissed before Crossref answers leaves its successor where the reader is, even if it is a book', async t => {
  const page = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/review-feed', title: 'Synthetic scientific review', publicationType: 'review' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
  ].map(work => ({ publicationType: 'article', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, ...work }));
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const read = records('read', 3);
  const { state, env, run, dismiss } = feed({ fast: [], slow: page, page: 1, papers: [...read] });
  Object.assign(env, await freshPublications('dismissed-visible'));
  // The reader is on the last card of the first page when the next one is added.
  env.visiblePaperIdRef.current = read[2].id;
  const loading = run(false);
  await wait(100);
  assert.deepEqual(state.papers.map(paper => paper.id), [...read.map(paper => paper.id), ...page.map(paper => paper.id)]);
  await dismiss(read[2]);
  answer();
  await loading;
  await wait(20);
  // The first book now fills the dismissed card's place; the second is two cards further.
  assert.deepEqual(state.papers.map(paper => paper.id), ['read-0', 'read-1', 'W568341909', 'W3029239115', 'scientific-review']);
});

test('a refreshed page drops the books the reader has not reached, though the scroll reported a card of the old list', async t => {
  const page = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/review-feed', title: 'Synthetic scientific review', publicationType: 'review' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
  ].map(work => ({ publicationType: 'article', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, ...work }));
  const old = records('old', 8);
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const { state, env, refresh } = feed({ fast: [], slow: page, page: 2, papers: [...old] });
  Object.assign(env, await freshPublications('refreshed-page'));
  const refreshing = refresh();
  // FeedContainer's jump to the top reports the old list's first card.
  env.visiblePaperIdRef.current = old[0].id;
  await refreshing;
  assert.deepEqual(state.papers.map(paper => paper.id), page.map(paper => paper.id));
  answer();
  await wait(20);
  assert.deepEqual(state.papers.map(paper => paper.id), ['W568341909', 'W3029239115', 'scientific-review']);
});

test('an entirely excluded page advances pagination without restoring books through the seen bypass', async () => {
  const books = [{ ...records('book', 1)[0], publicationType: 'book' }];
  const { state, run } = feed({ fast: books });
  await run(true);
  await tick();
  assert.deepEqual(state.papers, []);
  assert.equal(state.continuations.length, 1);
});

test('a complete unseen page paints without waiting for a slower source', async () => {
  const slow = deferred();
  const { state, run } = feed({ slow: slow.promise });
  try {
    await run(true);
    assert.equal(state.error, null);
    assert.equal(state.papers.length, 15);
    assert.equal(state.hasMore, true);
    assert.equal(state.loading, false);
    await tick();
    assert.deepEqual(state.continuations, []);
  } finally {
    slow.resolve([]);
  }
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
  assert.equal(state.page, 1);
  assert.deepEqual(state.continuations, [[false, 'top', false, 1]]);
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
      await run(true);
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
    const scope = { ...env, ...sources, followShownPapers: compile(followCallback, env), loading: state.loading, papers: state.papers, page: state.page, hasMore: state.hasMore };
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
  test(`only the reset load fills the first screen, and its short page continues without a first screen's wait when React commits it ${commitFirst ? 'before' : 'after'} the continuation fires`, async t => {
    t.mock.method(Math, 'random', () => 0.5);
    const { state, env, loadingAbstracts } = feed();
    // commit() puts the real loader in loadPapersRef. A reset load that fails
    // after paint schedules a retry through it every 2.5 s, which would keep
    // the test process alive. A new session cancels its retries and continuations.
    t.after(() => { env.feedSessionId.current += 1; });
    const requests: Array<{ source: string; categories: string[]; start?: number; painted: boolean }> = [];
    const send = (source: string, categories: string[], start?: number) => {
      const painted = state.papers.length > 0;
      requests.push({ source, categories, start, painted });
      return painted;
    };
    let open!: () => void;
    const answered = new Promise<void>(resolve => { open = resolve; });
    // An OpenAlex card on the next page whose abstract recovery has not
    // answered. It answers when the test ends, so the abstract wait the card
    // holds open does not keep the test process alive for ABSTRACT_WAIT_MS.
    const awaiting = { ...records('awaiting', 1)[0], arxivId: '2401.00001', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
    const recovery = pendingRecords();
    t.after(() => recovery.resolve([]));
    const sources = {
      // cs.LG is the nearby category that exploration adds.
      getAllLeafCategories: () => [
        { id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' },
        { id: 'cs.LG', label: 'Machine Learning', area: 'cs' },
      ],
      CATEGORIES: { cs: { subcategories: { 'cs.AI': 'Artificial Intelligence', 'cs.LG': 'Machine Learning' } } },
      // Five papers before anything is shown. Twelve after, so the next page
      // of fifteen, filled in source order, still has room for the OpenAlex card.
      fetchPapers: async (categories: string[], start: number) => {
        const painted = send('arxiv', categories, start);
        await answered;
        if (categories.includes('cs.LG')) return records('nearby', 2);
        return painted ? records('next', 12) : records('first', 5);
      },
      // Counted, so a category-label search (gone since PAP-73) would show below.
      OpenAlexAdapter: class {
        search(_query: string, _page: number, { internalCategories }: { internalCategories: string[] }) {
          send('openalex', internalCategories);
          return Promise.resolve({ papers: [] });
        }
      },
      fetchDomainPapers: (categories: string[]) => {
        const painted = send('domain', categories);
        return Promise.resolve(painted ? [awaiting] : []);
      },
      recoverFeedAbstracts: (papers: Paper[]) => papers.some(paper => paper.id === awaiting.id) ? recovery.promise : Promise.resolve([]),
    };
    const render = renders(state, env, sources);

    const mounted = render();
    mounted.commit();
    // The preferences effect starts the reset load. While its sources are
    // pending, the scroll sentinel from the same render reports itself in view
    // before React commits the reset load's `loading`.
    const resetLoad = mounted.loadPapers(true, null, true);
    mounted.loadMore();
    render().commit();
    open();
    await resetLoad;

    const firstPage = records('first', 5).map(paper => paper.id);
    const firstWave = requests.filter(request => !request.painted);
    assert.deepEqual(['arxiv', 'openalex', 'domain'].map(source => firstWave.filter(request => request.source === source).length), [1, 0, 1],
      'one request per source before the first page is shown, and no OpenAlex search');
    assert.notEqual(firstWave.find(request => request.source === 'arxiv')?.start, 0, 'the reset load asks for its random start page');
    assert.ok(firstWave.every(request => !request.categories.includes('cs.LG')), 'no exploration request before the first page is shown');
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), firstPage);

    // Five cards are a short page, so the reset load has scheduled the next one.
    const shown = render();
    if (commitFirst) shown.commit();
    await tick();
    if (!commitFirst) shown.commit();
    // Run from the closure rendered during the reset load, whose `papers` are
    // empty, the next page would wait CITATION_GATE_MAX_WAIT_MS for recovery
    // as a first screen does.
    await wait(100);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.slice(0, firstPage.length).map(paper => paper.id), firstPage, 'the first page stays where it is');
    assert.ok(state.papers.slice(firstPage.length).some(paper => paper.id.startsWith('next-')), 'the next page follows it');
    assert.ok(state.papers.some(paper => paper.id === awaiting.id), 'with the card recovery has not answered for');
    assert.deepEqual([...loadingAbstracts()], [awaiting.id], 'which says its abstract is loading');
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

// PAP-73: the feed no longer asks OpenAlex for works matching the text of the
// reader's category labels ("Machine Learning" OR "Artificial Intelligence").
// The real adapter is injected, so any such search reaches the recorded relay.
function recordOpenAlexRequests(t: import('node:test').TestContext) {
  const realFetch = openAlexClient.fetchImpl;
  const urls: string[] = [];
  openAlexClient.clearMemoryCache();
  openAlexClient.fetchImpl = async (input) => {
    urls.push(decodeURIComponent(String(input)));
    return Response.json({ results: [], meta: { count: 0 } });
  };
  t.after(() => { openAlexClient.fetchImpl = realFetch; });
  return urls;
}
const searchedLabels = (urls: string[], leaves: Array<{ label: string }>) => urls.filter(url => leaves.some(leaf => url.includes(leaf.label)));

const AI_LEAVES = [
  { id: 'cs.LG', label: 'Machine Learning', area: 'cs' },
  { id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' },
  // The nearby category exploration adds, and one outside the reader's areas for boredom.
  { id: 'cs.CL', label: 'Computation and Language', area: 'cs' },
  { id: 'math.CO', label: 'Combinatorics', area: 'math' },
];
for (const [name, page, boredom, asked] of [
  ['the first page', 0, 0, [['cs.LG', 'cs.AI']]],
  ['a later page with its exploration', 1, 0, [['cs.LG', 'cs.AI'], ['cs.CL']]],
  ['a bored reader\'s later page', 1, 8, [['cs.LG', 'cs.AI'], ['cs.CL'], ['math.CO']]],
] as const) {
  test(`${name} sends OpenAlex no search for the reader's category labels`, async t => {
    const urls = recordOpenAlexRequests(t);
    const { state, env, run } = feed({ page });
    const arxivRequests: string[][] = [];
    Object.assign(env, {
      userPreferences: ['cs.LG', 'cs.AI'],
      CATEGORIES,
      getAllLeafCategories: () => AI_LEAVES,
      OpenAlexAdapter,
      fetchPapers: async (categories: string[]) => {
        arxivRequests.push(categories);
        return records(categories.join('+'));
      },
    });
    env.boredomLevel.current = boredom;
    await run(page === 0);
    assert.equal(state.error, null);
    assert.deepEqual(arxivRequests, asked, 'arXiv is still asked for the chosen, nearby and random categories');
    assert.deepEqual(searchedLabels(urls, AI_LEAVES), []);
  });
}

// PubMed is now a medicine reader's only main source. The OpenAlex label
// search beside it could answer first from its cache.
for (const [name, answered, shown, continuations] of [
  ['fills its first page from PubMed', 15, 15, []],
  ['shows a short first page from PubMed and asks for the next', 4, 4, [[false, 'top', false, 1]]],
] as const) {
  test(`a medicine reader ${name}, without an OpenAlex label search`, async t => {
    const urls = recordOpenAlexRequests(t);
    const leaves = [{ id: 'med.onco', label: 'Oncology', area: 'med' }];
    const { state, env, run } = feed({ fast: [] });
    Object.assign(env, {
      userPreferences: ['med.onco'],
      CATEGORIES,
      getAllLeafCategories: () => leaves,
      OpenAlexAdapter,
      // Past the 5 ms first-paint budget: the page waits for it.
      PubmedAdapter: class {
        search() { return wait(20).then(() => ({ papers: records('pubmed', answered) })); }
      },
    });
    await run(true);
    await tick();
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), records('pubmed', shown).map(paper => paper.id));
    assert.deepEqual(state.continuations, continuations);
    assert.deepEqual(searchedLabels(urls, leaves), []);
  });
}

// Plan A (PAP-73): the leaves arXiv does not serve ask OpenAlex for recent
// works by the topic IDs measured for them, once per page. Readers of arXiv's
// leaves, or of leaves whose topics were not measured, cost no request.
test("a biology reader's page asks OpenAlex once for its leaves' topics and shows the answer; other readers do not ask", async t => {
  // OpenAlex W7222916812 (trimmed), primary topic RNA Research and Splicing.
  const splicing = {
    id: 'https://openalex.org/W7222916812', doi: 'https://doi.org/10.1093/genetics/iyag290', type: 'article',
    title: 'A Novel CCMS Model Reveals a Critical Intronic Sequence in the Snrpb Gene that is Required for Normal Development',
    publication_date: '2026-10-20', publication_year: 2026, authorships: [], cited_by_count: 0,
    abstract_inverted_index: { Pathogenic: [0], variants: [1], in: [2], SNRPB: [3], cause: [4], Cerebrocostomandibular: [5], Syndrome: [6] },
    primary_location: { landing_page_url: 'https://doi.org/10.1093/genetics/iyag290', source: { id: 'https://openalex.org/S65932378', display_name: 'Genetics', type: 'journal' } },
    primary_topic: { id: 'https://openalex.org/T10604', display_name: 'RNA Research and Splicing', subfield: { id: 'https://openalex.org/subfields/1312', display_name: 'Molecular Biology' } },
  };
  // Crossref, asked for the card's type.
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: 'journal-article' })) } });
  });
  const realFetch = openAlexClient.fetchImpl;
  const urls: URL[] = [];
  openAlexClient.clearMemoryCache();
  openAlexClient.fetchImpl = async (input) => {
    urls.push(new URL(String(input)));
    return Response.json({ results: [splicing] });
  };
  t.after(() => { openAlexClient.fetchImpl = realFetch; });
  const load = async (preferences: string[]) => {
    urls.length = 0;
    const { state, env, run } = feed();
    Object.assign(env, {
      userPreferences: preferences,
      CATEGORIES,
      getAllLeafCategories: () => preferences.map(id => ({ id, label: id, area: id.split('.')[0] })),
      fetchOpenAlexTopicPapers,
      PubmedAdapter: class { search() { return Promise.resolve({ papers: [] }); } },
    });
    await run(true);
    assert.equal(state.error, null);
    return state.papers.map(paper => paper.id);
  };

  assert.ok((await load(['bio.mol'])).includes('openalex:W7222916812'), 'the topic match is on the page');
  assert.equal(urls.length, 1);
  assert.match(urls[0].searchParams.get('filter')!, /(^|,)primary_topic\.id:T\d+/);
  assert.equal(urls[0].searchParams.get('page'), '1');

  for (const reader of [['cs.LG', 'cs.AI'], ['med.gen']]) {
    await load(reader);
    assert.equal(urls.length, 0, `a reader of ${reader.join(' and ')} asks OpenAlex nothing`);
  }
});

// Plan G (PAP-73): the topic page often answers first, from the Worker's cache,
// with 25 papers. Counted whole, it made the first page alone; another lane that
// answers within the first-paint budget is on that page now.
test('a topic page that answers first waits for another lane before the first paint', async () => {
  const topics = records('topic', 25).map(paper => ({ ...paper, primaryCategory: undefined }));
  const pubmed = records('pubmed', 5);
  const { state, env, run } = feed({ fast: [] });
  Object.assign(env, {
    userPreferences: ['bio.mol'],
    CATEGORIES,
    getAllLeafCategories: () => [{ id: 'bio.mol', label: 'Molecular Biology', area: 'bio' }],
    fetchOpenAlexTopicPapers: () => Promise.resolve(topics),
    PubmedAdapter: class { search() { return wait(20).then(() => ({ papers: pubmed })); } },
    FEED_SOURCE_RENDER_BUDGET_MS: 500,
  });
  await run(true);
  assert.equal(state.error, null);
  const shown = state.papers.map(paper => paper.id);
  assert.equal(shown.length, 15);
  assert.ok(pubmed.every(paper => shown.includes(paper.id)), `the PubMed answer is on the first page: ${shown.join(' ')}`);
});

// Trimmed OpenAlex W2020715063: no abstract in the record, linked to arXiv 1109.5103.
const electron = { ...records('electron', 1)[0], id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', arxivId: '1109.5103', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
function pendingRecords() {
  let resolve!: (records: Partial<Paper>[]) => void;
  const promise = new Promise<Partial<Paper>[]>(done => { resolve = done; });
  return { promise, resolve };
}

test('a later page is shown without waiting for recovery, and its card says the abstract is loading until it arrives', async () => {
  const existing = records('already-visible', 15).map(paper => ({ ...paper, sources: { primary: 'arxiv', enrichedBy: [] } }));
  const { state, env, run, loadingAbstracts } = feed({ fast: [electron], papers: existing });
  const recovery = pendingRecords();
  env.recoverFeedAbstracts = () => recovery.promise;
  let saved: Paper[] = [];
  env.scheduleFeedSnapshotWrite = (_uid, _key, snapshot) => { saved = snapshot.papers; };
  const loading = run(false);
  await wait(100);
  assert.deepEqual(state.papers.map(paper => paper.id), [...existing.map(paper => paper.id), electron.id]);
  assert.equal(hasUsableAIAbstract(state.papers.at(-1)!.abstract), false);
  assert.deepEqual([...loadingAbstracts()], [electron.id]);
  // Synthetic text; the identifiers above are captured.
  recovery.resolve([{ arxivId: '1109.5103', abstract: 'Recovered source text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
  await loading;
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.at(-1)!.abstract, 'Recovered source text.');
  assert.equal(saved.at(-1)?.abstract, 'Recovered source text.');
  assert.deepEqual([...loadingAbstracts()], []);
});

for (const [name, args] of [
  ['a later page', [false, 'top', false, 1]],
  ['a follow change', [true, null, true, undefined, { keepThroughVisible: true }]],
] as const) {
  test(`${name} lands below the cards as answers during its load left them: the recovered abstract stays, the removed book stays out`, async t => {
    const first = { ...records('first', 1)[0], abstract: 'Source text.', sources: { primary: 'arxiv', enrichedBy: [] } };
    const book = { ...records('book', 1)[0], id: 'W568341909', doi: '10.1007/978-3-540-76956-9', publicationType: 'article', abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } };
    const article = { ...records('article', 1)[0], id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', publicationType: 'article', abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } };
    let answer!: () => void;
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      await new Promise<void>(resolve => { answer = resolve; });
      const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
      return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
    });
    const { state, env, run, loadingAbstracts } = feed({ fast: [], slow: [first, electron, book, article] });
    Object.assign(env, await freshPublications(`answers-during-${name}`));
    const recovery = pendingRecords();
    env.recoverFeedAbstracts = async papers => papers.some(paper => paper.id === electron.id) ? recovery.promise : [];
    env.CITATION_GATE_MAX_WAIT_MS = 20;
    await run(true);
    assert.deepEqual(state.papers.map(paper => paper.id), [first.id, electron.id, book.id, article.id]);
    assert.deepEqual([...loadingAbstracts()], [electron.id]);

    // The next cards come from a source that answers after the first page's recovery and Crossref.
    const next = deferred();
    env.fetchPapers = () => next.promise;
    let written: Paper[] = [];
    env.writeFeedSnapshot = (_uid, _key, snapshot) => { written = snapshot.papers; };
    const loading = run(...args);
    await tick();
    recovery.resolve([{ arxivId: '1109.5103', abstract: 'Recovered source text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
    answer();
    await wait(20);
    // The reader is on the first card, so the book two cards further leaves.
    const kept = [[first.id, 'Source text.'], [electron.id, 'Recovered source text.'], [article.id, 'Publisher text.']];
    assert.deepEqual(state.papers.map(paper => [paper.id, paper.abstract]), kept);
    assert.deepEqual([...loadingAbstracts()], []);

    next.resolve(records('next', 15));
    await loading;
    assert.equal(state.error, null);
    assert.deepEqual([...loadingAbstracts()], []);
    // The feed cache and the snapshot the next cold open restores hold the same list.
    const ids = [...kept.map(([id]) => id), ...records('next', 15).map(paper => paper.id)];
    for (const list of [state.papers, (env.feedCache.current.top as { papers: Paper[] }).papers, written]) {
      assert.deepEqual(list.map(paper => paper.id), ids);
      assert.deepEqual(list.slice(0, 3).map(paper => [paper.id, paper.abstract]), kept);
    }
  });
}

test('a card already shown with no abstract keeps it when a later page offers it again through the seen bypass', async t => {
  const existing = records('already-visible', 3).map(paper => ({ ...paper, sources: { primary: 'arxiv', enrichedBy: [] } }));
  const shown = [...existing, electron];
  const { state, env, run, loadingAbstracts } = feed({ fast: [electron], papers: shown, seen: shown.map(paper => paper.id) });
  t.mock.method(console, 'log', () => {});
  const recovery = pendingRecords();
  env.recoverFeedAbstracts = () => recovery.promise;
  const loading = run(false);
  await wait(100);
  assert.deepEqual(state.papers.map(paper => paper.id), shown.map(paper => paper.id));
  assert.deepEqual([...loadingAbstracts()], []);
  recovery.resolve([{ arxivId: '1109.5103', abstract: 'Late recovered text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
  await loading;
  await tick();
  assert.equal(state.error, null);
  assert.equal(state.papers.at(-1)!.abstract, '');
});

test('the first screen waits only its short budget for a missing abstract, then settles on none if recovery finds nothing', async () => {
  const { state, env, run, loadingAbstracts } = feed({ fast: [electron] });
  const recovery = pendingRecords();
  env.recoverFeedAbstracts = () => recovery.promise;
  env.CITATION_GATE_MAX_WAIT_MS = 40;
  assert.equal(await settleWithin(1_000, () => run(true)), 'resolved');
  assert.deepEqual(state.papers.map(paper => paper.id), [electron.id]);
  assert.deepEqual([...loadingAbstracts()], [electron.id]);
  recovery.resolve([]);
  await tick();
  assert.deepEqual([...loadingAbstracts()], []);
  assert.equal(hasUsableAIAbstract(state.papers[0].abstract), false);
});

for (const stale of ['request', 'account'] as const) {
  test(`an abstract response from a stale ${stale} cannot publish its page`, async () => {
    const { state, env, run } = feed();
    const pending = pendingRecords();
    env.recoverFeedAbstracts = () => pending.promise;
    const loading = run(true);
    await tick();
    if (stale === 'request') env.feedRequestId.current += 1;
    else env.feedSessionId.current += 1;
    pending.resolve([{ arxivId: '1109.5103', abstract: 'Stale source text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
    await loading;
    assert.deepEqual(state.papers, []);
  });
}

test('signed-in Europe PMC text is on the first paint when it is fast, and replaces the loading state when it is late', async () => {
  for (const late of [false, true]) {
    const record = { ...records('pubmed', 1)[0], pmid: '123', abstract: '', sources: { primary: 'pubmed', enrichedBy: [] } };
    const { state, env, run, loadingAbstracts } = feed({ fast: [record] });
    let deliver!: (records: Map<string, Partial<Paper> & { pmid: string }>) => void;
    const pending = new Promise<Map<string, Partial<Paper> & { pmid: string }>>(resolve => { deliver = resolve; });
    const response = new Map([['123', { pmid: '123', abstract: 'Europe PMC source text.', citationCount: 16, openAccess: true }]]);
    env.enrichPubmedIds = () => late ? pending : Promise.resolve(response);
    env.CITATION_GATE_MAX_WAIT_MS = 10;
    await run(true);
    assert.equal(state.error, null);
    assert.equal(hasUsableAIAbstract(state.papers[0].abstract), !late);
    assert.equal(loadingAbstracts().has(record.id), late);
    deliver(response);
    await tick();
    assert.equal(state.papers[0].abstract, 'Europe PMC source text.');
    assert.equal(state.papers[0].citationCount, 16);
    assert.equal(state.papers[0].openAccess, true);
    assert.equal(loadingAbstracts().size, 0);
  }
});

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

// PAP-53: the economics working-paper series reach a reader's page through one
// OpenAlex request per page, and only for a reader who follows economics or
// finance. Two works as OpenAlex returned them on 2026-10-19, trimmed.
const SERIES_ABSTRACT = 'Between 2000 and 2015, services offshoring reshaped local labour markets across regions.';
const invertedIndex = (text: string) => {
  const index: Record<string, number[]> = {};
  text.split(' ').forEach((word, position) => { (index[word] ||= []).push(position); });
  return index;
};
const seriesWork = (id: string, doi: string, type: string, source: { id: string; display_name: string }) => ({
  id: `https://openalex.org/${id}`,
  doi: `https://doi.org/${doi}`,
  title: `Working paper ${id}`,
  type,
  publication_date: '2026-10-14',
  publication_year: 2026,
  authorships: [{ author: { id: `https://openalex.org/A${id.slice(1)}`, display_name: `Author ${id}` }, institutions: [] }],
  abstract_inverted_index: invertedIndex(SERIES_ABSTRACT),
  primary_location: {
    landing_page_url: `https://doi.org/${doi}`,
    is_published: true,
    version: 'publishedVersion',
    source: { id: `https://openalex.org/${source.id}`, display_name: source.display_name, type: 'journal' },
  },
  locations: [],
  open_access: { is_oa: true, oa_url: null },
  cited_by_count: 0,
});
const frbsfPaper = seriesWork('W7221947410', '10.24148/wp2026-23', 'article', { id: 'S4306510381', display_name: 'Federal Reserve Bank of San Francisco, Working Paper Series' });
const cesifoReport = seriesWork('W7222541626', '10.65864/jochq5qfxv', 'report', { id: 'S7407053623', display_name: 'CESifo' });

// The OpenAlex client binds its fetch when it is built, so the relay is
// stubbed on the client. Crossref, which classifies OpenAlex DOIs before
// display, is stubbed on the global fetch.
function stubSeriesRelay(t: import('node:test').TestContext, works: unknown[] | null) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: 'report' })) } });
  });
  const realFetch = openAlexClient.fetchImpl;
  const seriesRequests: string[] = [];
  openAlexClient.clearMemoryCache();
  openAlexClient.fetchImpl = async (input) => {
    const url = decodeURIComponent(String(input));
    if (url.includes('primary_location.source.id:')) seriesRequests.push(url);
    return works ? Response.json({ results: works }) : new Response('{}', { status: 503 });
  };
  t.after(() => { openAlexClient.fetchImpl = realFetch; });
  return seriesRequests;
}

test('an economics reader gets each working paper once, not peer reviewed, and other readers do not ask', async t => {
  const seriesRequests = stubSeriesRelay(t, [frbsfPaper, cesifoReport]);
  // Another source on the page can return a series article too.
  const searched = new OpenAlexAdapter().mapToStandard(frbsfPaper)! as FeedRecord;
  const load = async (preferences: string[]) => {
    seriesRequests.length = 0;
    const { state, env, run } = feed({ fast: [], slow: [searched] });
    env.userPreferences = preferences;
    env.fetchWorkingPapers = fetchWorkingPapers;
    await run(true);
    assert.equal(state.error, null);
    return state.papers;
  };

  assert.deepEqual((await load(['cs.AI'])).map(paper => paper.id), [searched.id]);
  assert.equal(seriesRequests.length, 0, 'a reader without economics or finance interests does not ask');

  const page = await load(['econ.GN']);
  assert.equal(seriesRequests.length, 1);
  assert.deepEqual(page.map(paper => paper.id).sort(), ['openalex:W7221947410', 'openalex:W7222541626']);
  for (const paper of page) {
    assert.equal(paper.peerReviewed, false, `${paper.id} is a working paper`);
    assert.equal(reviewStatusForPaper(paper), 'workingPaper', `${paper.id} shows the Working paper tag`);
  }
});

test('a failed working-paper request leaves the page to the other sources', async t => {
  t.mock.method(console, 'warn', () => {});
  const seriesRequests = stubSeriesRelay(t, null);
  const searched = records('search', 4);
  const { state, env, run } = feed({ fast: [], slow: searched });
  env.userPreferences = ['econ.GN'];
  env.fetchWorkingPapers = fetchWorkingPapers;
  await run(true);
  assert.equal(seriesRequests.length, 1, 'the series were asked for');
  assert.equal(state.error, null);
  assert.deepEqual(state.papers.map(paper => paper.id), searched.map(paper => paper.id));
});

// Both ask OpenAlex, whose queue has two slots for requests without priority,
// and the page waits for the followed lookups but not for the series.
test('the working-paper series are asked for once the followed lookups settle, not ahead of them', async () => {
  const followed = deferred();
  const asked: string[] = [];
  const { state, env, run } = feed();
  Object.assign(env, {
    userPreferences: ['econ.GN'],
    followedEntities: [{ type: 'author', canonicalId: 'A5026475124', displayName: 'Martina Magli' }],
    fetchFollowedEntityCandidates: () => { asked.push('followed'); return followed.promise; },
    fetchWorkingPapers: () => { asked.push('series'); return Promise.resolve([]); },
    OPTIONAL_SOURCE_RENDER_BUDGET_MS: 1000,
  });
  const loading = run(true);
  await tick();
  assert.deepEqual(asked, ['followed'], 'no series request while a followed lookup runs');
  followed.resolve([]);
  await loading;
  assert.deepEqual(asked, ['followed', 'series']);
  assert.equal(state.error, null);
});
