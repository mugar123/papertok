import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { classifyFeedPublications, isFeedPublication } from '../services/feedPublicationService.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { buildGuestFeedPlan } from '../utils/guestFeedPlan.ts';
import { composeGuestPage, extendGuestPage } from '../utils/guestFeedComposition.ts';
import type { Paper } from '../models/Paper.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { fulfilledPaperLists } from '../utils/asyncTiming.ts';
import { guestPageReady } from '../utils/guestFeedComposition.ts';
import { awaitWithinGate } from '../utils/feedCitationGate.ts';
import { hasUsableAIAbstract } from '../utils/aiExplanationAccess.ts';
import { getOpenAlexEnrichmentId, needsOpenAlexEnrichment, mergeOpenAlexEnrichment, preserveFeedAbstracts } from '../utils/feedEnrichment.ts';
import { mergeEuropePmcEnrichment } from '../services/europePmcService.ts';

const source = readFileSync(new URL('./useGuestFeed.ts', import.meta.url), 'utf8');
const start = source.indexOf('function startGuestCandidateRequests(');
const end = source.indexOf('\nfunction dedupePapers', start);
assert.ok(start >= 0 && end > start);
const callback = stripTypeScriptTypes(source.slice(start, end));

test('guest candidate batches exclude video books and book reviews before both early and late composition', async t => {
  const adapter = new OpenAlexAdapter();
  const papers = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
    { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/guest-review', title: 'Synthetic scientific review', type: 'review' },
  ].map(work => ({ ...adapter.mapToStandard({ type: 'article', ...work })!, categories: ['math.AG'] }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const env = {
    fetchPapers: async () => [], fetchDomainPapers: async () => [],
    OpenAlexAdapter: class { async search() { return { papers }; } },
    PubmedAdapter: class { async search() { return { papers: [] }; } },
    GUEST_PAGE_SIZE: 12, classifyFeedPublications, isFeedPublication,
  };
  const requests = new Function(...Object.keys(env), `${callback}; return startGuestCandidateRequests;`)(...Object.values(env));
  const plan = buildGuestFeedPlan(['math']);
  const candidates = (await Promise.all(requests(plan))).flat();
  for (const composed of [composeGuestPage(candidates, plan, 12), extendGuestPage([], candidates, plan, 12)]) {
    assert.deepEqual(composed.map(work => work.id).sort(), ['W3029239115', 'scientific-review']);
    assert.equal(composed.find(work => work.id === 'scientific-review')?.publicationType, 'review');
  }
});

const loadStart = source.indexOf('async (requestedPlan: GuestFeedPlan,');
const loadEnd = source.indexOf('\n  }, []);', loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart);
const loadCode = stripTypeScriptTypes(source.slice(loadStart, loadEnd) + '\n}');
const dedupeStart = source.indexOf('function dedupePapers');
const dedupeEnd = source.indexOf('\n/**', dedupeStart);
const dedupeCode = stripTypeScriptTypes(source.slice(dedupeStart, dedupeEnd));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function pendingPapers() {
  let resolve!: (papers: Paper[]) => void;
  const promise = new Promise<Paper[]>(done => { resolve = done; });
  return { resolve, promise };
}
function guestLoader(batch: Paper[], late?: Promise<Paper[]>) {
  const state = { papers: [] as Paper[], loading: false, error: null as string | null, frames: [] as Paper[][] };
  const env = {
    requestIdRef: { current: 0 }, GUEST_PAGE_SIZE: 12, GUEST_SOURCE_BUDGET_MS: 5,
    setLoading: (value: boolean) => { state.loading = value; }, setIsRefreshing: () => {},
    setError: (value: string | null) => { state.error = value; },
    setPapers: (value: Paper[] | ((current: Paper[]) => Paper[])) => {
      state.papers = typeof value === 'function' ? value(state.papers) : value;
      state.frames.push(state.papers);
    },
    startGuestCandidateRequests: () => [],
    settleSourcesForFirstPaint: () => ({ first: Promise.resolve([{ status: 'fulfilled', value: batch }]), all: Promise.resolve(late || batch).then(value => [{ status: 'fulfilled', value }]) }),
    fulfilledPaperLists, PaperBuilder, guestPageReady, composeGuestPage, extendGuestPage,
    getOpenAlexEnrichmentId, needsOpenAlexEnrichment, mergeOpenAlexEnrichment, preserveFeedAbstracts,
    hasUsableAIAbstract, mergeEuropePmcEnrichment,
    enrichPapersBatch: async () => ({}), enrichPubmedIds: (async () => new Map()) as (ids: string[]) => Promise<Map<string, Partial<Paper> & { pmid: string }>>,
    recoverFeedAbstracts: async (papers: Paper[]) => papers,
    awaitWithinGate,
  };
  const run = () => new Function(...Object.keys(env), `${dedupeCode}; return (${loadCode});`)(...Object.values(env))(buildGuestFeedPlan(['math']));
  return { state, env, run };
}
const electron = PaperBuilder.create({ id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', arxivId: '1109.5103', categories: ['math.AG'], abstract: '', sources: { primary: 'openalex', enrichedBy: [] } });

test('guest cards first appear with the recovered abstract, including a late candidate batch', async () => {
  for (const early of [true, false]) {
    const { state, env, run } = guestLoader(early ? [electron] : [], early ? undefined : Promise.resolve([electron]));
    const pending = pendingPapers();
    env.recoverFeedAbstracts = async papers => papers.length ? pending.promise : [];
    const loading = run();
    await tick();
    assert.equal(state.papers.length, 0);
    pending.resolve([{ ...electron, abstract: 'Recovered source text.' }]);
    await loading;
    assert.equal(state.error, null);
    assert.equal(state.papers[0].abstract, 'Recovered source text.');
    assert.ok(state.frames.filter(frame => frame.length).every(frame => frame[0].abstract === 'Recovered source text.'));
  }
});

test('guest PubMed enrichment precedes admission, runs once per paper and retains access metadata', async () => {
  const paper = { ...electron, id: 'pmid:123', pmid: '123', arxivId: undefined, sources: { primary: 'pubmed', enrichedBy: [] } };
  const { state, env, run } = guestLoader([paper]);
  const requests: string[][] = [];
  env.enrichPubmedIds = async ids => { if (ids.length) requests.push(ids); return new Map([['123', { pmid: '123', abstract: 'Europe PMC source abstract.', openAccess: true, landingPageUrl: 'https://europepmc.org/article/MED/123' }]]); };
  await run();
  assert.deepEqual(requests, [['123']]);
  assert.equal(state.papers[0].abstract, 'Europe PMC source abstract.');
  assert.equal(state.papers[0].openAccess, true);
  assert.ok(state.frames.filter(frame => frame.length).every(frame => frame[0].abstract === 'Europe PMC source abstract.'));
});

test('guest responses cannot publish after a changed interest, refresh or unmount invalidates the load', async () => {
  const { state, env, run } = guestLoader([electron]);
  const pending = pendingPapers();
  env.recoverFeedAbstracts = async () => pending.promise;
  const loading = run();
  await tick();
  env.requestIdRef.current += 1;
  pending.resolve([{ ...electron, abstract: 'Stale source text.' }]);
  await loading;
  assert.equal(state.papers.length, 0);
});

test('preparing late guest additions preserves the shown page and does not recover its papers twice', async () => {
  const late = pendingPapers();
  const recovery = pendingPapers();
  const other = { ...electron, id: 'other', arxivId: '2005.12542' };
  const { state, env, run } = guestLoader([electron], late.promise);
  const batches: string[][] = [];
  env.recoverFeedAbstracts = async papers => {
    batches.push(papers.map(p => p.id));
    return papers.some(p => p.id === other.id) ? recovery.promise : papers.map(p => ({ ...p, abstract: 'First source text.' }));
  };
  const loading = run();
  await tick();
  assert.equal(state.papers[0].abstract, 'First source text.');
  const first = state.papers[0];
  late.resolve([electron, other]);
  await tick();
  assert.deepEqual(state.papers, [first]);
  recovery.resolve([{ ...other, abstract: 'Second source text.' }]);
  await loading;
  assert.deepEqual(state.papers.map(p => p.id), [electron.id, other.id]);
  assert.equal(state.papers[0], first);
  assert.equal(state.papers[1].abstract, 'Second source text.');
  assert.deepEqual(batches, [[electron.id], [other.id]]);
});
