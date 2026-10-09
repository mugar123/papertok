import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PaperBuilder } from '../services/PaperBuilder.js';
import { fulfilledPaperLists, resolveWithin, settleSourcesForFirstPaint } from '../utils/asyncTiming.js';
import { lateSourceCandidates } from '../utils/feedLateCandidates.js';
import { takeFeedPage } from '../utils/feedEnrichment.js';
import { shouldAbortFeedLoad } from '../utils/feedLoadGuard.js';

// Execute the actual loader callback with provider and React-state boundaries
// injected. Source-pattern tests cannot catch an excluded page ending the feed.
const source = readFileSync(new URL('./FeedContext.jsx', import.meta.url), 'utf8');
const start = source.indexOf('async (reset = false, mode, randomizeStart = false, pageOverride,');
const end = source.indexOf('\n  }, [\n    userPreferences, page, papers, loading, feedMode,', start);
assert.ok(start >= 0 && end > start, 'the feed loader callback must exist');
const callback = source.slice(start, end) + '\n  }';
const ref = (current) => ({ current });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const records = (prefix, count = 15) => Array.from({ length: count }, (_, index) => ({
  id: `${prefix}-${index}`,
  title: `${prefix} scientific research finding number ${index}`,
  authors: [{ name: `${prefix} Researcher ${index}` }],
  primaryCategory: 'cs.AI',
}));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function feed({ fast = records('fast'), slow = [], known = [], seen = [], page = 0, papers = [] } = {}) {
  const state = { papers, page, loading: false, hasMore: true, error: null, continuations: [] };
  const env = {
    userPreferences: ['cs.AI'], recommendationProfileReady: true, feedMode: 'top', PAGE_SIZE: 15,
    feedRequestId: ref(0), feedSessionId: ref(0),
    openAlexEnrichmentAttempts: ref(new Set()), openAlexEnrichmentRequests: ref(new Map()),
    lateSourceCandidatesRef: ref([]), latePoolGenerationRef: ref(0),
    setLoading: value => { state.loading = value; }, setError: value => { state.error = value; },
    setPapers: value => { state.papers = typeof value === 'function' ? value(state.papers) : value; },
    setPage: value => { state.page = value; }, setHasMore: value => { state.hasMore = value; },
    getAllLeafCategories: () => [{ id: 'cs.AI', label: 'Artificial Intelligence', area: 'cs' }],
    followedEntities: [], categoryAffinities: ref({}), temporalPreference: ref(0),
    rankPreferences: values => values, CATEGORIES: { cs: { subcategories: { 'cs.AI': 'Artificial Intelligence' } } },
    fetchPapers: () => Promise.resolve(fast), PubmedAdapter: class {},
    OpenAlexAdapter: class { search() { return Promise.resolve(slow).then(papers => ({ papers })); } },
    fetchDomainPapers: () => Promise.resolve([]), relatedCandidates: ref([]),
    FEED_SOURCE_RENDER_BUDGET_MS: 5, OPTIONAL_SOURCE_RENDER_BUDGET_MS: 5,
    settleSourcesForFirstPaint: (promises, ms, ready) => settleSourcesForFirstPaint(promises, ms, ready, { allTimeoutMs: 200 }),
    resolveWithin, fulfilledPaperLists, PaperBuilder, lateSourceCandidates, shouldAbortFeedLoad,
    boredomLevel: ref(0), getBoredomThreshold: () => 5,
    likedPaperIdsRef: ref(new Set(known)), savedPaperIdsRef: ref(new Set()),
    readPaperIdsRef: ref(new Set()), notInterestedIdsRef: ref(new Set()),
    sessionSeenPapers: ref(new Set(seen)), isKnownPaper: id => known.includes(id),
    mergeFollowEntityMatches: (...groups) => groups.flat(),
    diversifiedWeightedShuffle: values => values, calculateAndAttachScore: () => 0,
    recommendationWeights: ref({}), takeFeedPage,
    needsOpenAlexEnrichment: () => false, getOpenAlexEnrichmentId: () => '',
    enrichPapersBatch: () => Promise.resolve({}), OPENALEX_FEED_REQUEST_TIMEOUT_MS: 5,
    fetchICiteMetrics: () => Promise.resolve({}), enrichPubmedIds: () => Promise.resolve(new Map()),
    awaitWithinGate: () => Promise.resolve([null, null, null]),
    logRankingBatch: () => {}, saveSeenPaperIds: () => {}, activeUserId: ref('test-user'),
    autoRetryUsedRef: ref(false), feedCache: ref({}),
    feedPreferenceSignature: values => values.join('|'), pendingSnapshotWritesRef: ref(new Map()),
    writeFeedSnapshot: () => {},
    loadPapersRef: ref((...args) => { state.continuations.push(args); }),
  };
  const run = (...args) => {
    Object.assign(env, { papers: state.papers, page: state.page, loading: state.loading });
    return new Function(...Object.keys(env), `return (${callback});`)(...Object.values(env))(...args);
  };
  return { state, env, run };
}

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
  await run(...state.continuations.shift());
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
  for (const guard of ['feedRequestId', 'feedSessionId']) {
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
