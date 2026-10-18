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
import { takeFeedPage } from '../utils/feedEnrichment.ts';
import { shouldAbortFeedLoad } from '../utils/feedLoadGuard.ts';
import { readProfileSignals } from '../utils/interactionProfile.ts';
import { pickExplorationCategories } from '../utils/recommendationEngine.ts';
import { classifyFeedPublications, isFeedPublication } from '../services/feedPublicationService.ts';

// Execute the actual loader callback with provider and React-state boundaries
// injected. Source-pattern tests cannot catch an excluded page ending the feed.
const source = readFileSync(new URL('./FeedContext.tsx', import.meta.url), 'utf8');
const start = source.indexOf('async (reset = false, mode?: string | null, randomizeStart = false, pageOverride?: number,');
const end = source.indexOf('\n  }, [\n    userPreferences, page, papers, loading, feedMode,', start);
assert.ok(start >= 0 && end > start, 'the feed loader callback must exist');
const callback = stripTypeScriptTypes(source.slice(start, end) + '\n  }');
const ref = <T>(current: T) => ({ current });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
type FeedRecord = Pick<Paper, 'id' | 'title' | 'authors' | 'primaryCategory'>;
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
  const state = { papers, page, loading: false, hasMore: true, error: null as string | null, continuations: [] as unknown[][] };
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
    classifyFeedPublications, isFeedPublication,
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
    awaitWithinGate: () => Promise.resolve([null, null, null]),
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
  return { state, env, run };
}

test('the signed-in loader excludes the video books and book review before display, including pagination', async t => {
  const video: Paper[] = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
    { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/review-feed', title: 'Synthetic scientific review', publicationType: 'review' },
  ].map(work => ({ publicationType: 'article', abstract: '', authors: [], sources: { primary: 'openalex', enrichedBy: [] }, ...work }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  for (const page of [0, 1]) {
    const { state, run } = feed({ fast: [], slow: video, page });
    await run(page === 0);
    assert.equal(state.error, null);
    assert.deepEqual(state.papers.map(paper => paper.id), ['W3029239115', 'scientific-review']);
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
