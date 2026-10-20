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
import { takeFeedPage, preserveFeedAbstracts, mergeOpenAlexEnrichment, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';
import { shouldAbortFeedLoad } from '../utils/feedLoadGuard.ts';
import { readProfileSignals } from '../utils/interactionProfile.ts';
import { pickExplorationCategories } from '../utils/recommendationEngine.ts';
import { classifyFeedPublications, isFeedPublication } from '../services/feedPublicationService.ts';

import { mergeEuropePmcEnrichment } from '../services/europePmcService.ts';
import { mergeICiteEnrichment } from '../services/iCiteService.ts';
import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';
import { awaitWithinGate, CITATION_GATE_MAX_WAIT_MS } from '../utils/feedCitationGate.ts';
import { fetchWorkingPapers } from '../services/domainSourceService.ts';
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
const ref = <T>(current: T) => ({ current });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
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
    fetchDomainPapers: () => Promise.resolve([]), fetchWorkingPapers: (() => Promise.resolve([])) as typeof fetchWorkingPapers,
    relatedCandidates: ref([]),
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
    awaitWithinGate, CITATION_GATE_MAX_WAIT_MS, hasUsableAIAbstract, recoverFeedAbstracts: async (papers: Paper[]) => papers,
    mergeOpenAlexEnrichment, preserveFeedAbstracts, mergeFeedAbstracts, mergeEuropePmcEnrichment, mergeICiteEnrichment,
    scheduleFeedSnapshotWrite: () => {},
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

for (const existing of [[], records('already-visible', 15)]) {
  test(`abstract recovery finishes before ${existing.length ? 'pagination' : 'first paint'} publishes the screenshot paper`, async () => {
    const record = { ...records('electron', 1)[0], id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
    const { state, env, run } = feed({ fast: [record], papers: existing });
    const pending = deferred();
    env.recoverFeedAbstracts = async () => await pending.promise as Paper[];
    let saved: Paper[] = [];
    Object.assign(env, { writeFeedSnapshot: (_uid: string, _key: string, snapshot: { papers: Paper[] }) => { saved = snapshot.papers; } });
    const loading = run(existing.length === 0);
    await tick();
    assert.deepEqual(state.papers, existing);
    pending.resolve([{ ...record, abstract: 'Recovered source text.' }]);
    await loading;
    assert.equal(state.error, null);
    assert.equal((state.papers.at(-1) as Paper).abstract, 'Recovered source text.');
    assert.equal(saved.at(-1)?.abstract, 'Recovered source text.');
  });
}

for (const stale of ['request', 'account'] as const) {
  test(`an abstract response from a stale ${stale} cannot publish its page`, async () => {
    const { state, env, run } = feed();
    const pending = deferred();
    env.recoverFeedAbstracts = async () => await pending.promise as Paper[];
    const loading = run(true);
    await tick();
    if (stale === 'request') env.feedRequestId.current += 1;
    else env.feedSessionId.current += 1;
    pending.resolve(records('stale'));
    await loading;
    assert.deepEqual(state.papers, []);
  });
}

test('signed-in Europe PMC recovery is visible on first paint and late responses cannot change text', async () => {
  for (const late of [false, true]) {
    const record = { ...records('pubmed', 1)[0], pmid: '123', abstract: '', sources: { primary: 'pubmed', enrichedBy: [] } };
    const { state, env, run } = feed({ fast: [record] });
    let deliver!: (records: Map<string, Partial<Paper> & { pmid: string }>) => void;
    const pending = new Promise<Map<string, Partial<Paper> & { pmid: string }>>(resolve => { deliver = resolve; });
    const response = new Map([['123', { pmid: '123', abstract: 'Europe PMC source text.', citationCount: 16, openAccess: true }]]);
    env.enrichPubmedIds = () => late ? pending : Promise.resolve(response);
    Object.assign(env, { awaitWithinGate: (promises: unknown[]) => awaitWithinGate(promises, { maxWaitMs: 10 }) });
    await run(true);
    assert.equal(state.error, null);
    const initial = state.papers[0].abstract;
    assert.equal(hasUsableAIAbstract(initial), !late);
    if (!late) assert.equal(initial, 'Europe PMC source text.');
    deliver(response);
    await tick();
    assert.equal(state.papers[0].abstract, initial);
    assert.equal(state.papers[0].citationCount, 16);
    assert.equal(state.papers[0].openAccess, true);
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
  // The economics search can find a series article too.
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
