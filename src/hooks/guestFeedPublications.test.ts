import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { applyKnownPublicationTypes, classifyFeedPublications, dropUnreachedPublications, isFeedPublication } from '../services/feedPublicationService.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { buildGuestFeedPlan } from '../utils/guestFeedPlan.ts';
import { composeGuestPage, extendGuestPage } from '../utils/guestFeedComposition.ts';
import type { Paper } from '../models/Paper.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { fulfilledPaperLists } from '../utils/asyncTiming.ts';
import { guestPageReady } from '../utils/guestFeedComposition.ts';
import { awaitWithinGate } from '../utils/feedCitationGate.ts';
import { abstractsInFlight, getOpenAlexEnrichmentId, needsOpenAlexEnrichment, mergeFeedAbstracts, mergeOpenAlexEnrichment, preserveFeedAbstracts } from '../utils/feedEnrichment.ts';
import { mergeEuropePmcEnrichment } from '../services/europePmcService.ts';
import { abstractWaitIds, openAbstractWait } from '../utils/feedAbstractWait.ts';
import { dropPaperById } from './useGuestFeed.ts';

const source = readFileSync(new URL('./useGuestFeed.ts', import.meta.url), 'utf8');
const start = source.indexOf('function startGuestCandidateRequests(');
const end = source.indexOf('\nfunction dedupePapers', start);
assert.ok(start >= 0 && end > start);
const callback = stripTypeScriptTypes(source.slice(start, end));

test('guest candidate batches exclude known books and book reviews before composition without asking Crossref', async t => {
  const adapter = new OpenAlexAdapter();
  const papers = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013', type: 'book' },
    { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/guest-review', title: 'Synthetic scientific review', type: 'review' },
  ].map(work => ({ ...adapter.mapToStandard({ type: 'article', ...work })!, categories: ['math.AG'] }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  const env = {
    fetchPapers: async () => [], fetchDomainPapers: async () => [],
    OpenAlexAdapter: class { async search() { return { papers }; } },
    PubmedAdapter: class { async search() { return { papers: [] }; } },
    GUEST_PAGE_SIZE: 12, applyKnownPublicationTypes, isFeedPublication,
  };
  const requests = new Function(...Object.keys(env), `${callback}; return startGuestCandidateRequests;`)(...Object.values(env));
  const plan = buildGuestFeedPlan(['math']);
  const candidates = (await Promise.all(requests(plan))).flat();
  for (const composed of [composeGuestPage(candidates, plan, 12), extendGuestPage([], candidates, plan, 12)]) {
    // W568341909's type is unknown until Crossref answers after display.
    assert.deepEqual(composed.map(work => work.id).sort(), ['W3029239115', 'W568341909', 'scientific-review']);
    assert.equal(composed.find(work => work.id === 'scientific-review')?.publicationType, 'review');
  }
  assert.equal(fetch.mock.callCount(), 0);
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
function pendingRecords() {
  let resolve!: (records: Partial<Paper>[]) => void;
  const promise = new Promise<Partial<Paper>[]>(done => { resolve = done; });
  return { resolve, promise };
}
function guestLoader(batch: Paper[], late?: Promise<Paper[]>) {
  const state = { papers: [] as Paper[], loading: false, error: null as string | null, frames: [] as Paper[][], abstractWaits: [] as ReadonlyArray<ReadonlySet<string>> };
  const env = {
    requestIdRef: { current: 0 }, visiblePaperIdRef: { current: null as string | null },
    GUEST_PAGE_SIZE: 12, GUEST_SOURCE_BUDGET_MS: 5, CITATION_GATE_MAX_WAIT_MS: 200,
    setLoading: (value: boolean) => { state.loading = value; }, setIsRefreshing: () => {},
    setError: (value: string | null) => { state.error = value; },
    setPapers: (value: Paper[] | ((current: Paper[]) => Paper[])) => {
      state.papers = typeof value === 'function' ? value(state.papers) : value;
      state.frames.push(state.papers);
    },
    startGuestCandidateRequests: () => [],
    settleSourcesForFirstPaint: () => ({ first: Promise.resolve([{ status: 'fulfilled', value: batch }]), all: Promise.resolve(late || batch).then(value => [{ status: 'fulfilled', value }]) }),
    fulfilledPaperLists, PaperBuilder, guestPageReady, composeGuestPage, extendGuestPage,
    getOpenAlexEnrichmentId, needsOpenAlexEnrichment, mergeOpenAlexEnrichment, preserveFeedAbstracts, mergeFeedAbstracts,
    abstractsInFlight, mergeEuropePmcEnrichment,
    enrichPapersBatch: async () => ({}), enrichPubmedIds: (async () => new Map()) as (ids: string[]) => Promise<Map<string, Partial<Paper> & { pmid: string }>>,
    recoverFeedAbstracts: (async () => []) as (papers: Paper[]) => Promise<Partial<Paper>[]>,
    classifyFeedPublications, dropUnreachedPublications,
    openAbstractWait, setAbstractWaits: (update: (current: typeof state.abstractWaits) => typeof state.abstractWaits) => { state.abstractWaits = update(state.abstractWaits); },
    awaitWithinGate,
  };
  const run = () => new Function(...Object.keys(env), `${dedupeCode}; return (${loadCode});`)(...Object.values(env))(buildGuestFeedPlan(['math']));
  const loadingAbstracts = () => abstractWaitIds(state.abstractWaits);
  return { state, env, run, loadingAbstracts };
}
const electron = PaperBuilder.create({ id: 'W2020715063', title: 'Effective action for strongly correlated electron systems', arxivId: '1109.5103', categories: ['math.AG'], abstract: '', sources: { primary: 'openalex', enrichedBy: [] } });

// Synthetic text for the captured arXiv link of W2020715063.
const recovered = [{ arxivId: '1109.5103', abstract: 'Recovered source text.', sources: { primary: 'arxiv', enrichedBy: [] } }];

test('the first guest cards wait briefly for an abstract on its way, whichever batch they come from', async () => {
  for (const early of [true, false]) {
    const { state, env, run, loadingAbstracts } = guestLoader(early ? [electron] : [], early ? undefined : Promise.resolve([electron]));
    const pending = pendingRecords();
    env.recoverFeedAbstracts = async papers => papers.length ? pending.promise : [];
    const loading = run();
    await tick();
    assert.equal(state.papers.length, 0);
    pending.resolve(recovered);
    await loading;
    assert.equal(state.error, null);
    assert.equal(state.papers[0].abstract, 'Recovered source text.');
    assert.ok(state.frames.filter(frame => frame.length).every(frame => frame[0].abstract === 'Recovered source text.'));
    assert.equal(loadingAbstracts().size, 0);
  }
});

test('the first guest cards are shown after the short budget, saying their abstract is loading', async () => {
  const { state, env, run, loadingAbstracts } = guestLoader([electron]);
  const pending = pendingRecords();
  env.recoverFeedAbstracts = async papers => papers.length ? pending.promise : [];
  env.CITATION_GATE_MAX_WAIT_MS = 20;
  const loading = run();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(state.papers.map(paper => paper.id), [electron.id]);
  assert.deepEqual([...loadingAbstracts()], [electron.id]);
  pending.resolve(recovered);
  await loading;
  await tick();
  assert.equal(state.papers[0].abstract, 'Recovered source text.');
  assert.equal(loadingAbstracts().size, 0);
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
  const pending = pendingRecords();
  env.recoverFeedAbstracts = async () => pending.promise;
  const loading = run();
  await tick();
  env.requestIdRef.current += 1;
  pending.resolve([{ ...recovered[0], abstract: 'Stale source text.' }]);
  await loading;
  assert.equal(state.papers.length, 0);
});

test('late guest additions are shown at once below the first cards, and recovery runs once per paper', async () => {
  const late = pendingPapers();
  const recovery = pendingRecords();
  const other = { ...electron, id: 'other', arxivId: '2005.12542' };
  const { state, env, run, loadingAbstracts } = guestLoader([electron], late.promise);
  const batches: string[][] = [];
  env.recoverFeedAbstracts = async papers => {
    batches.push(papers.map(p => p.id));
    return papers.some(p => p.id === other.id) ? recovery.promise : recovered;
  };
  const loading = run();
  await tick();
  assert.equal(state.papers[0].abstract, 'Recovered source text.');
  const first = state.papers[0];
  late.resolve([electron, other]);
  await loading;
  assert.deepEqual(state.papers.map(p => p.id), [electron.id, other.id]);
  assert.equal(state.papers[0], first);
  assert.deepEqual([...loadingAbstracts()], [other.id]);
  recovery.resolve([{ arxivId: '2005.12542', abstract: 'Second source text.', sources: { primary: 'arxiv', enrichedBy: [] } }]);
  await tick();
  assert.equal(state.papers[0], first);
  assert.equal(state.papers[1].abstract, 'Second source text.');
  assert.equal(loadingAbstracts().size, 0);
  assert.deepEqual(batches, [[electron.id], [other.id]]);
});

test('a guest card confirmed as a book leaves only if the guest has not reached it', async t => {
  const article = (id: string) => PaperBuilder.create({ id, title: `Synthetic article ${id}`, doi: `10.5555/${id}`, categories: ['math.AG'], abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } });
  const page = [article('first'), article('second'), article('third'), { ...article('book'), doi: '10.1007/978-3-540-76956-9' }];
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  for (const [visible, kept] of [[null, ['first', 'second', 'third']], ['third', ['first', 'second', 'third', 'book']]] as const) {
    const publications = await import(new URL(`../services/feedPublicationService.ts?guest-${visible}`, import.meta.url).href) as typeof import('../services/feedPublicationService.ts');
    const { state, env, run } = guestLoader(page);
    Object.assign(env, publications);
    await run();
    assert.deepEqual(state.papers.map(paper => paper.id), ['first', 'second', 'third', 'book']);
    env.visiblePaperIdRef.current = visible;
    answer();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(state.papers.map(paper => paper.id), kept);
  }
});

test('a refreshed guest page drops the books the guest has not reached, though the ref still names a card of the old list', async t => {
  const article = (id: string, doi = `10.5555/${id}`) => PaperBuilder.create({ id, title: `Synthetic article ${id}`, doi, categories: ['math.AG'], abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } });
  const page = [article('first'), article('second'), article('third'), article('book', '10.1007/978-3-540-76956-9')];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const publications = await import(new URL('../services/feedPublicationService.ts?guest-refreshed', import.meta.url).href) as typeof import('../services/feedPublicationService.ts');
  const { state, env, run } = guestLoader(page);
  Object.assign(env, publications);
  env.visiblePaperIdRef.current = 'card-of-the-previous-plan';
  await run();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(state.papers.map(paper => paper.id), ['first', 'second', 'third']);
});

const dismissStart = source.indexOf('const dismissPaper = useCallback(');
const dismissEnd = source.indexOf('\n  }, []);', dismissStart);
assert.ok(dismissStart >= 0 && dismissEnd > dismissStart);
const dismissCode = stripTypeScriptTypes(source.slice(dismissStart + 'const dismissPaper = useCallback('.length, dismissEnd) + '\n  }');

test('a guest Skip before Crossref answers leaves the next card where the guest is, even if it is a book', async t => {
  const article = (id: string, doi = `10.5555/${id}`) => PaperBuilder.create({ id, title: `Synthetic article ${id}`, doi, categories: ['math.AG'], abstract: 'Publisher text.', sources: { primary: 'openalex', enrichedBy: [] } });
  const page = [article('first'), article('second'), article('third'), article('book', '10.1007/978-3-540-76956-9'), article('fourth'), article('later-book', '10.1007/978-3-319-04870-3')];
  let answer!: () => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    await new Promise<void>(resolve => { answer = resolve; });
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const publications = await import(new URL('../services/feedPublicationService.ts?guest-dismissed', import.meta.url).href) as typeof import('../services/feedPublicationService.ts');
  const { state, env, run } = guestLoader(page);
  Object.assign(env, publications);
  await run();
  assert.deepEqual(state.papers.map(paper => paper.id), page.map(paper => paper.id));
  env.visiblePaperIdRef.current = 'third';
  const dismissPaper = new Function(...Object.keys(env), 'dropPaperById', `return (${dismissCode});`)(...Object.values(env), dropPaperById);
  dismissPaper('third');
  answer();
  await new Promise(resolve => setTimeout(resolve, 20));
  // 'book' now fills the skipped card's place; 'later-book' is two cards further.
  assert.deepEqual(state.papers.map(paper => paper.id), ['first', 'second', 'book', 'fourth']);
});
