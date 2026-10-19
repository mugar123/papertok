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
import { settleWithin } from '../test-support/deadlineHarness.ts';

import { mergeEuropePmcEnrichment } from '../services/europePmcService.ts';
import { mergeICiteEnrichment } from '../services/iCiteService.ts';
import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';
import { awaitWithinGate, CITATION_GATE_MAX_WAIT_MS } from '../utils/feedCitationGate.ts';

// Execute the actual loader callback with provider and React-state boundaries
// injected. Source-pattern tests cannot catch an excluded page ending the feed.
const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('async (reset = false, mode?: string | null, randomizeStart = false, pageOverride?: number,');
const end = source.indexOf('\n  }, [\n    userPreferences, page, papers, loading, feedMode,', start);
assert.ok(start >= 0 && end > start, 'the feed loader callback must exist');
const callback = stripTypeScriptTypes(source.slice(start, end) + '\n  }');
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
    feedRequestId: ref(0), feedSessionId: ref(0),
    openAlexEnrichmentAttempts: ref(new Set()), openAlexEnrichmentRequests: ref(new Map()),
    lateSourceCandidatesRef: ref([]), latePoolGenerationRef: ref(0),
    setLoading: (value: boolean) => { state.loading = value; }, setError: (value: string | null) => { state.error = value; },
    setPapers: (value: FeedRecord[] | ((previous: FeedRecord[]) => FeedRecord[])) => { state.papers = typeof value === 'function' ? value(state.papers) : value; },
    setPage: (value: number) => { state.page = value; }, setHasMore: (value: boolean) => { state.hasMore = value; },
    getAllLeafCategories: () => [{ id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' }],
    followedEntities: [], profileSignals: ref(readProfileSignals(null)), temporalPreference: ref(0),
    rankPreferences: <T>(values: T) => values, CATEGORIES: { cs: { subcategories: { 'cs.AI': 'Artificial Intelligence' } } } as Record<string, { subcategories: Record<string, string | { label: string }> }>,
    ARXIV_FEED_AREAS, fetchPapers: (() => Promise.resolve(fast)) as (categories: string[]) => Promise<FeedRecord[]>, PubmedAdapter: class {},
    OpenAlexAdapter: class { search() { return Promise.resolve(slow).then(papers => ({ papers })); } },
    fetchDomainPapers: () => Promise.resolve([]), relatedCandidates: ref([]),
    personalCandidates: ref([]), fetchPersonalPapers: () => Promise.resolve([]), PERSONAL_CANDIDATES_PER_PAGE: 5,
    pickExplorationCategories,
    FEED_SOURCE_RENDER_BUDGET_MS: 5, OPTIONAL_SOURCE_RENDER_BUDGET_MS: 5,
    settleSourcesForFirstPaint: (promises: Iterable<unknown[]|PromiseLike<unknown[]>>, ms: number, ready: ((papers: unknown[]) => boolean)|undefined) => settleSourcesForFirstPaint(promises, ms, ready, { allTimeoutMs: 200 }),
    resolveWithin, fulfilledPaperLists, PaperBuilder, lateSourceCandidates, shouldAbortFeedLoad,
    classifyFeedPublications, isFeedPublication, applyKnownPublicationTypes, dropUnreachedPublications,
    visiblePaperIdRef: ref<string | null>(null),
    boredomLevel: ref(0), getBoredomThreshold: () => 5,
    likedPaperIdsRef: ref(new Set(known)), savedPaperIdsRef: ref(new Set()),
    readPaperIdsRef: ref(new Set()), notInterestedIdsRef: ref(new Set()),
    sessionSeenPapers: ref(new Set(seen)), isKnownPaper: (id: string) => known.includes(id),
    mergeFollowEntityMatches: (...groups: unknown[][]) => groups.flat(),
    diversifiedWeightedShuffle: <T>(values: T) => values, calculateAndAttachScore: () => 0,
    recommendationWeights: ref({}), takeFeedPage,
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
    autoRetryUsedRef: ref(false), feedCache: ref({}),
    feedPreferenceSignature: (values: string[]) => values.join('|'), pendingSnapshotWritesRef: ref(new Map()),
    writeFeedSnapshot: () => {},
    loadPapersRef: ref((...args: unknown[]) => { state.continuations.push(args); }),
  };
  const run = (...args: unknown[]) => {
    Object.assign(env, { papers: state.papers, page: state.page, loading: state.loading });
    return new Function(...Object.keys(env), `return (${callback});`)(...Object.values(env))(...args);
  };
  const loadingAbstracts = () => abstractWaitIds(state.abstractWaits);
  return { state, env, run, loadingAbstracts };
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
