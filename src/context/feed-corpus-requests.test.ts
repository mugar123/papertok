import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import type { CategoryExposure, PositiveExample } from '../utils/interaction-profile.ts';
import type { InterestMemoryInput } from '../utils/interest-memory.ts';
import { awaitScreenSources, feedPlanFor, followedCorpusRequest, mainCorpusRequest, waitsAsFirstScreen } from './feed-corpus-requests.ts';
import { automaticRetry } from './feed-load-failure.ts';
import { fetchCorpusPage } from '../services/paper-store-service.ts';
import { getFollowedTopicCategoryIds } from '../services/topic-retrieval-service.ts';
import { createEmptyInteractionProfile, readProfileSignals, recordInteractionEvent } from '../utils/interaction-profile.ts';
import { feedReason } from '../utils/feed-reason.ts';
import { scorePaperForRecommendation } from '../utils/recommendation-engine.ts';

const memory = (input: Partial<InterestMemoryInput>): InterestMemoryInput => ({
  selected: [], deselected: [], added: [], examples: [], exposure: {}, affinities: {}, ...input,
});

const examples = (category: string, count: number) =>
  Array.from({ length: count }, (_, index): PositiveExample => ({ id: `${category}-${index}`, category }));

const shown = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).map(([category, count]): [string, CategoryExposure] => [category, { shown: count, engaged: 0 }]));

// The bodies the feed's requests send to /store/papers.
async function bodiesOf(...requests: Parameters<typeof fetchCorpusPage>[0][]) {
  const bodies: Array<{ categories: string[]; positiveIds: string[]; negativeIds?: string[]; excludedIds?: string[]; groups?: Array<{ categories: string[]; positiveIds: string[] }> }> = [];
  for (const request of requests) {
    await fetchCorpusPage(request, {
      apiBase: 'https://papertok-report-api.example',
      fetchWorker: async (_url, init) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ papers: [] }), { status: 200 });
      },
    });
  }
  return bodies;
}

const shared = { page: 0, order: 'recent', negativeIds: [], excludedIds: [] };

test('a followed topic fills only the follows request, ranked by the examples of the chosen areas', async () => {
  const physics = { type: 'topic', canonicalId: 'physics', displayName: 'Physics', followKey: 'topic:physics', metadata: {} } as FollowEntity;
  const physicsCategories = getFollowedTopicCategoryIds([physics]);
  assert.ok(physicsCategories.includes('quant-ph'), 'the follow stands for physics categories');
  const plan = feedPlanFor(null, 0, memory({
    selected: ['econ.EM', 'econ.GN', 'econ.TH'],
    // A like of physics, an area the reader never chose, ranks as it did
    // before groups (ENG-137, R18); it asks for no physics category.
    examples: [...examples('econ.EM', 2), ...examples('quant-ph', 1)],
  }));

  const [main, follows] = await bodiesOf(
    mainCorpusRequest(plan, shared),
    followedCorpusRequest(plan, [physics], follow => getFollowedTopicCategoryIds([follow]), shared).request,
  );

  assert.deepEqual(main.categories.filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(main.groups!.flatMap(group => group.categories).filter(category => physicsCategories.includes(category)), []);
  assert.deepEqual(follows.categories, physicsCategories);
  assert.deepEqual(main.positiveIds, ['econ.EM-0', 'econ.EM-1', 'quant-ph-0']);
  assert.deepEqual(follows.positiveIds, ['econ.EM-0', 'econ.EM-1', 'quant-ph-0']);
});

test('queued cards and later pages keep their request examples across an unlike and a new save', async () => {
  const profile = createEmptyInteractionProfile();
  const input = () => memory({ selected: ['cs.LG'], examples: readProfileSignals(profile).positiveExamples });
  recordInteractionEvent(profile, { paperId: 'old', kind: 'like', category: 'cs.LG' });
  const first = feedPlanFor(null, 0, input(), profile);
  const fetchPage = (request: Parameters<typeof fetchCorpusPage>[0], expectedIds: string[]) => fetchCorpusPage(request, {
    apiBase: 'https://store.example',
    fetchWorker: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { positiveIds: string[] };
      assert.deepEqual(body.positiveIds, expectedIds);
      return Response.json({ papers: [{ id: 'queued', _semanticScore: 0.9 }] });
    },
  }).then(answer => answer.papers[0]);
  const queued = fetchPage(mainCorpusRequest(first, shared), ['old']);
  recordInteractionEvent(profile, { paperId: 'old', kind: 'unlike', category: 'cs.LG' });
  recordInteractionEvent(profile, { paperId: 'new', kind: 'save', category: 'cs.LG' });
  const later = feedPlanFor(first, 1, input(), profile);
  const fresh = feedPlanFor(first, 0, input(), profile);
  const cardReason = (card: Awaited<typeof queued>) => {
    const score = scorePaperForRecommendation(card);
    return feedReason({ ...card, _debugScore: score }, null, 'feed', 'Research Paper')?.text;
  };
  const oldCard = await queued;
  assert.equal(cardReason(await fetchPage(followedCorpusRequest(later, [], () => [], shared).request, ['old'])), 'Similar to papers you liked');
  assert.equal(cardReason(await fetchPage(mainCorpusRequest(fresh, shared), ['new'])), 'Similar to papers you saved');
  assert.equal(cardReason(oldCard), 'Similar to papers you liked');
});

test("a list's later pages ask by the groups its first page planned", async () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], added: ['econ.EM'], examples: examples('quant-ph', 10) });
  // Economics showed the cards that make it a learned area before page 1.
  const atPageOne = { ...atReset, exposure: shown({ 'econ.EM': 60 }) };
  const replanned = feedPlanFor(null, 0, atPageOne).groups;

  const plan = feedPlanFor(null, 0, atReset);
  assert.notDeepEqual(plan.groups, replanned, 'the seen cards change the plan');
  const [first, second] = await bodiesOf(
    mainCorpusRequest(plan, shared),
    mainCorpusRequest(feedPlanFor(plan, 1, atPageOne), { ...shared, page: 1 }),
  );
  assert.deepEqual(second.groups, first.groups);
  assert.deepEqual(second.groups, plan.groups);

  // A new list plans again, and so does a page with no plan of this session (a restored snapshot).
  assert.deepEqual(feedPlanFor(plan, 0, atPageOne).groups, replanned);
  assert.deepEqual(feedPlanFor(null, 2, atPageOne).groups, replanned);
});

test('the scoring of a list reads the progress, removed and cold-added subareas its first page planned', () => {
  const atReset = memory({ selected: ['quant-ph', 'econ.EM'], deselected: ['hep-th'], added: ['econ.EM'], examples: examples('quant-ph', 10) });
  const plan = feedPlanFor(null, 0, atReset);

  assert.equal(plan.interestProgress['quant-ph'], 1);
  assert.equal(plan.interestProgress['econ.EM'], 0);
  assert.deepEqual(plan.dormantCategories, ['hep-th']);
  assert.deepEqual(plan.coldAdded, ['econ.EM']);

  // The cards the reader sees afterwards move the memory, not the list's plan.
  const later = feedPlanFor(plan, 1, { ...atReset, exposure: shown({ 'econ.EM': 60 }) });
  assert.equal(later.interestProgress, plan.interestProgress);
  assert.equal(later.dormantCategories, plan.dormantCategories);
  assert.equal(later.coldAdded, plan.coldAdded);
});

/*
 * ENG-137, ruling R18: only what the reader deselected sleeps. A card the
 * scoring reads with a list's plan is dormant only when every piece of area
 * evidence it carries was removed; an area the reader never picked scores as
 * it does on main.
 */
const NOW = Date.parse('2026-07-05T12:00:00Z');
// What the feed's scoring reads of a plan.
const scoringMemoryOf = ({ interestProgress, coldAdded, dormantCategories }: ReturnType<typeof feedPlanFor>) => ({ interestProgress, coldAdded, dormantCategories });
const learned = { 'cs.CR': 40, 'hep-th': 40, 'gr-qc': 40, physics: 40, 'quant-ph': 40 };
const cardIn = (primaryCategory: string) => ({
  id: `followed-${primaryCategory}`, primaryCategory, published: '2026-07-05T00:00:00Z', _semanticScore: 0.5, _type: 'followed' as const,
});
const scoreWithPlan = (primaryCategory: string, input: InterestMemoryInput) => scorePaperForRecommendation(cardIn(primaryCategory), {
  now: NOW, userPreferences: input.selected, categoryAffinities: learned, ...scoringMemoryOf(feedPlanFor(null, 0, input)),
});

test('a reader who never edited their interests is scored as on main, in every area', () => {
  const reader = memory({ selected: ['cs.LG', 'cs.AI'] });
  for (const category of ['cs.CR', 'hep-th', 'physics', 'cs.LG']) {
    const main = scorePaperForRecommendation(cardIn(category), { now: NOW, userPreferences: reader.selected, categoryAffinities: learned });
    assert.deepEqual(scoreWithPlan(category, reader), main, category);
  }
  const security = scoreWithPlan('cs.CR', reader);
  assert.deepEqual([security.corpusSimilarity, security.affinity], [50, 40]);
});

test('what the reader deselected sleeps, and the rest of its area does not', () => {
  const leftPhysics = memory({ selected: ['cs.LG'], deselected: ['quant-ph', 'hep-th'] });
  assert.equal(scoreWithPlan('hep-th', leftPhysics).corpusSimilarity, 0);
  assert.equal(scoreWithPlan('physics', leftPhysics).corpusSimilarity, 0, 'the area key, with no Physics subarea selected');
  assert.deepEqual([scoreWithPlan('gr-qc', leftPhysics).corpusSimilarity, scoreWithPlan('gr-qc', leftPhysics).affinity], [50, 40], 'a subarea never picked');

  const keptQuantum = memory({ selected: ['cs.LG', 'quant-ph'], deselected: ['hep-th'] });
  assert.equal(scoreWithPlan('hep-th', keptQuantum).corpusSimilarity, 0);
  assert.equal(scoreWithPlan('physics', keptQuantum).corpusSimilarity, 50, 'the area key, with a Physics subarea selected');
});

// ENG-116: a cold Worker answered a session's first requests after the 3.5 s
// deadline, so the feed failed and the automatic retry brought the papers.
type Source = 'main' | 'follows' | 'exploration';

// How a source answers one request: papers after a delay, or a 503.
type Answer = number | { refusesMs: number };

// A store that answers each of the feed's requests after its source's delay
// (never, without one; a list gives each of the source's requests in turn its
// own), and cuts it at the deadline the request was given. A request with no
// deadline, or one past the 10 s the feed relies on, fails. `sent` counts the
// requests of each source. With `tokenMs`, every request first waits that long
// for the ID token, and its delay and deadline count from then.
function slowStore(answerMs: Partial<Record<Source, Answer | Array<Answer | undefined>>>, tokenMs = 0) {
  const sent: Record<Source, number> = { main: 0, follows: 0, exploration: 0 };
  const fetchWorker = (_url: string, init: RequestInit, timeoutMs: number) => new Promise<Response>((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs > 10_000) {
      reject(new Error(`no bounded deadline: ${timeoutMs}`));
      return;
    }
    const body = JSON.parse(String(init.body)) as { follows?: unknown[]; groups?: unknown[] };
    const source: Source = body.follows?.length ? 'follows' : body.groups ? 'main' : 'exploration';
    const answers = answerMs[source];
    const delay = Array.isArray(answers) ? answers[sent[source]] : answers;
    sent[source] += 1;
    const answer = delay === undefined ? undefined : typeof delay === 'number'
      ? setTimeout(() => resolve(new Response(JSON.stringify({ papers: [{ id: source }] }), { status: 200 })), delay)
      : setTimeout(() => resolve(new Response(JSON.stringify({ code: 'PAPER_STORE_UNAVAILABLE' }), { status: 503 })), delay.refusesMs);
    setTimeout(() => {
      clearTimeout(answer);
      reject(new DOMException('The operation timed out.', 'TimeoutError'));
    }, timeoutMs);
  });
  const withToken = (url: string, init: RequestInit, timeoutMs: number) => new Promise<void>(resolve => { setTimeout(resolve, tokenMs); })
    .then(() => fetchWorker(url, init, timeoutMs));
  return { apiBase: 'https://papertok-report-api.example', fetchWorker: tokenMs ? withToken : fetchWorker, sent };
}

// Runs `work` on mocked timers, and says when it settled.
async function onTheClock<T>(t: TestContext, work: () => Promise<T>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let settled = false;
  const running = work().finally(() => { settled = true; });
  while (!settled) {
    for (let flush = 0; flush < 5; flush += 1) await new Promise(resolve => setImmediate(resolve));
    if (!settled) t.mock.timers.tick(50);
  }
  return { value: await running, at: Date.now() };
}

// The requests of one load, as the feed sends them, awaited as it awaits them
// (budgets: follows 3.5 s, exploration 4 s, feed-context.tsx).
function screen(load: Parameters<typeof waitsAsFirstScreen>[0], store: ReturnType<typeof slowStore>) {
  const plan = feedPlanFor(null, 0, memory({ selected: ['cs.LG'], examples: examples('cs.LG', 2) }));
  const author = { type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez' } as FollowEntity;
  const firstScreen = waitsAsFirstScreen(load);
  const loadShared = { ...shared, firstScreen };
  const ids = (answer: Promise<{ papers: Array<{ id: string }> }>) => answer.then(({ papers }) => papers.map(paper => paper.id));
  return awaitScreenSources(ids(fetchCorpusPage(mainCorpusRequest(plan, loadShared), store)), [
    { answer: ids(fetchCorpusPage(followedCorpusRequest(plan, [author], () => [], loadShared).request, store)), budgetMs: 3_500 },
    { answer: ids(fetchCorpusPage({ categories: ['cs.AI'], page: 0, pageSize: 2, firstScreen }, store)), budgetMs: 4_000 },
  ], firstScreen);
}

const coldEntry = { reset: true, hasPapers: false };
// A refresh, or a follow change, over the cards the reader is looking at.
const overShownCards = { reset: true, hasPapers: true };

test("a list's first screen keeps the follows and exploration that answered while its main page was awaited", async (t) => {
  const { value, at } = await onTheClock(t, () => screen(coldEntry, slowStore({ main: 5_000, follows: 4_000, exploration: 4_500 })));
  assert.deepEqual(value, { main: { value: ['main'] }, optional: [['follows'], ['exploration']] });
  assert.ok(at < 5_100, `shown when the main page answered, at ${at} ms`);
});

test('a source that has not answered when the main page does is left out, and does not hold the screen', async (t) => {
  const { value, at } = await onTheClock(t, () => screen(coldEntry, slowStore({ main: 5_000, follows: 6_000, exploration: 1_000 })));
  assert.deepEqual(value, { main: { value: ['main'] }, optional: [[], ['exploration']] });
  assert.ok(at < 5_100, `shown at ${at} ms`);
});

test('a source still has its own budget when the main page answers early', async (t) => {
  const { value, at } = await onTheClock(t, () => screen(coldEntry, slowStore({ main: 500, follows: 3_000, exploration: 4_500 })));
  assert.deepEqual(value, { main: { value: ['main'] }, optional: [['follows'], []] });
  assert.ok(at >= 4_000 && at < 4_100, `exploration's budget ran out at ${at} ms`);
});

test("follows that answered fill a first screen whose main page hangs, which still fails at 10 s", async (t) => {
  const { value, at } = await onTheClock(t, () => screen(coldEntry, slowStore({ follows: 4_000 })));
  assert.ok('error' in value.main);
  assert.equal((value.main.error as Error).name, 'TimeoutError');
  assert.deepEqual(value.optional, [['follows'], []]);
  assert.ok(at >= 10_000 && at < 10_100, `failed at ${at} ms`);
});

for (const firstScreen of [true, false]) {
  test(`a source that fails before the main page answers gives no papers and no unhandled rejection${firstScreen ? ', on a first screen' : ', over shown cards'}`, async (t) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => { process.off('unhandledRejection', onUnhandled); });
    const after = <T>(ms: number, settle: (resolve: (value: T) => void, reject: (error: Error) => void) => void) =>
      new Promise<T>((resolve, reject) => { setTimeout(() => { settle(resolve, reject); }, ms); });
    const { value } = await onTheClock(t, () => awaitScreenSources(after<string[]>(5_000, resolve => { resolve(['main']); }), [
      // The follows' request answers 503 at 1 s.
      { answer: after<string[]>(1_000, (_, reject) => { reject(new Error('follows 503')); }), budgetMs: 3_500 },
      // The topic retrieval chunk failed to load before the screen was awaited.
      { answer: Promise.reject(new Error('chunk 404')), budgetMs: 4_000 },
    ], firstScreen));
    assert.deepEqual(value, { main: { value: ['main'] }, optional: [[], []] });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  });
}

// Pablo, 2026-10-30: late follows and exploration are kept for first screens
// only. A 1 s token, the main page at 4.4 s, the follows at 3.6 s (past their
// 3.5 s) and exploration at 4.2 s (past its 4 s).
const lateSources = () => slowStore({ main: 3_400, follows: 2_600, exploration: 3_200 }, 1_000);

test('a first screen keeps the follows and exploration that answered past their budgets while its main page was awaited', async (t) => {
  const { value, at } = await onTheClock(t, () => screen(coldEntry, lateSources()));
  assert.deepEqual(value, { main: { value: ['main'] }, optional: [['follows'], ['exploration']] });
  assert.ok(at >= 4_400 && at < 4_500, `shown at ${at} ms`);
});

test('a refresh over shown cards and a next page leave out the follows and exploration that answered past their budgets', async (t) => {
  for (const [load, name] of [[overShownCards, 'a refresh or a follow change over shown cards'], [{ reset: false, hasPapers: true }, 'More']] as const) {
    const { value, at } = await onTheClock(t, () => screen(load, lateSources()));
    assert.deepEqual(value, { main: { value: ['main'] }, optional: [[], []] }, name);
    assert.ok(at >= 4_400 && at < 4_500, `${name}: shown at ${at} ms`);
    t.mock.timers.reset();
  }
});

// Pablo, 2026-10-30: a refresh over shown cards keeps main's 3.5 s.
test('only a load over no shown cards waits the first screen deadline', async (t) => {
  assert.equal(waitsAsFirstScreen(coldEntry), true, 'a cold entry, Try again, or a list emptied for an interests edit or a mode switch');
  assert.equal(waitsAsFirstScreen({ reset: false, hasPapers: true }), false, 'More');
  assert.equal(waitsAsFirstScreen(overShownCards), false, 'a refresh or a follow change over shown cards');
  const { value, at } = await onTheClock(t, () => screen(overShownCards, slowStore({ main: 5_000, follows: 5_000 })));
  assert.ok('error' in value.main);
  assert.equal((value.main.error as Error).name, 'TimeoutError');
  assert.ok(at >= 3_500 && at < 3_600, `gave up at ${at} ms`);
});

test('a follow change over a feed with no cards waits as the first screen it is', async (t) => {
  // For You ended in the error, the reader followed an author and came back:
  // the reload is the screen they wait on.
  const overNothing = { ...overShownCards, hasPapers: false };
  assert.equal(waitsAsFirstScreen(overNothing), true);
  const { value, at } = await onTheClock(t, () => screen(overNothing, slowStore({ main: 6_000 })));
  assert.deepEqual(value.main, { value: ['main'] });
  assert.ok(at >= 6_000 && at < 6_100, `shown at ${at} ms`);
});

test('a load follows what its caller put on screen, not the list of the render that started it', () => {
  // For You ended in the error, and the reader changed interests to a set
  // with a saved page: the cards are back before the replacing load.
  assert.equal(waitsAsFirstScreen({ ...coldEntry, listShown: true }), false, 'an interests edit that restored a saved page');
  // A mode switch, or an interests edit with no saved page, emptied the list.
  assert.equal(waitsAsFirstScreen({ ...overShownCards, listShown: false }), true, 'a list emptied just before');
});

// A load and its one automatic retry, as the feed runs them (loadPapers in
// feed-context.tsx): the load fails when its main page failed and no other
// source gave a paper, and the retry follows automaticRetry's pause and wait.
async function loadWithRetry(load: Parameters<typeof waitsAsFirstScreen>[0], store: ReturnType<typeof slowStore>) {
  const first = await screen(load, store);
  if (!('error' in first.main) || first.optional.some(papers => papers.length > 0)) return first;
  const retry = automaticRetry(first.main.error, waitsAsFirstScreen(load));
  await new Promise(resolve => setTimeout(resolve, retry.pauseMs));
  return screen({ ...load, retriesTimeout: retry.retriesTimeout }, store);
}

// Pablo, 2026-10-29: the 10 s first screen and its retry, waiting 10 s again
// after a 2.5 s pause, showed the error 22.5 s after the token.
test('a store that never answers shows the error 13.5 s after the token, after one retry', async (t) => {
  const store = slowStore({});
  const { value, at } = await onTheClock(t, () => loadWithRetry(coldEntry, store));
  assert.ok('error' in value.main);
  assert.equal((value.main.error as Error).name, 'TimeoutError');
  assert.ok(at >= 13_500 && at < 13_600, `the error at ${at} ms`);
  assert.deepEqual(store.sent, { main: 2, follows: 2, exploration: 2 }, 'the load and its one retry');
});

test('a cold store that answers the first screen in 6 s shows papers, with no retry', async (t) => {
  const store = slowStore({ main: 6_000 });
  const { value, at } = await onTheClock(t, () => loadWithRetry(coldEntry, store));
  assert.deepEqual(value.main, { value: ['main'] });
  assert.ok(at >= 6_000 && at < 6_100, `shown at ${at} ms`);
  assert.equal(store.sent.main, 1);
});

test('the retry of a first screen that timed out goes at once, and a store that answers it in 2 s shows papers', async (t) => {
  const store = slowStore({ main: [undefined, 2_000], follows: [undefined, 1_000], exploration: [undefined, 1_000] });
  const { value, at } = await onTheClock(t, () => loadWithRetry(coldEntry, store));
  assert.deepEqual(value.main, { value: ['main'] });
  assert.ok(at >= 12_000 && at < 12_100, `shown at ${at} ms`);
});

test('the retry of a first screen the store refused keeps the pause and the 10 s wait', async (t) => {
  // The 503 at 1 s, the screen held for exploration's 4 s budget, the 2.5 s
  // pause, and a retry answered in 6 s.
  const store = slowStore({ main: [{ refusesMs: 1_000 }, 6_000] });
  const { value, at } = await onTheClock(t, () => loadWithRetry(coldEntry, store));
  assert.deepEqual(value.main, { value: ['main'] });
  assert.ok(at >= 12_500 && at < 12_600, `shown at ${at} ms`);
});

test('the retry of a refresh or follow change over shown cards that timed out keeps the pause and its 3.5 s wait', async (t) => {
  const store = slowStore({ main: [undefined, 3_000], follows: [undefined, 1_000], exploration: [undefined, 1_000] });
  const { value, at } = await onTheClock(t, () => loadWithRetry(overShownCards, store));
  assert.deepEqual(value.main, { value: ['main'] });
  // The 3.5 s deadline, the 2.5 s pause, and a retry answered in 3 s.
  assert.ok(at >= 9_000 && at < 9_100, `shown at ${at} ms`);
});

test('a full plan leaves room for every rejection and exclusion a request carries', async () => {
  const id = (prefix: string, index: number) => `10.1000/${prefix}.${index}.`.padEnd(40, 'x');
  const selected = ['cs.LG', 'cs.AI', 'cs.CV', 'cs.RO', 'quant-ph', 'hep-th', 'math.PR', 'stat.ML', 'econ.EM', 'econ.GN'];
  const plan = feedPlanFor(null, 0, memory({
    selected,
    added: ['econ.EM', 'econ.GN'],
    examples: selected.flatMap(category => Array.from({ length: 3 }, (_, index) => ({ id: id(category, index), category }))).slice(0, 24),
  }));
  const negativeIds = Array.from({ length: 24 }, (_, index) => id('negative', index));
  const excludedIds = Array.from({ length: 130 }, (_, index) => id('excluded', index));
  const [body] = await bodiesOf(mainCorpusRequest(plan, { page: 0, order: 'recent', negativeIds, excludedIds }));
  assert.equal(body.negativeIds?.length, 24);
  assert.equal(body.excludedIds?.length, 130);
});

// One area each: eight areas send eight groups.
const eightAreas = [['quant-ph', 'cond-mat.str-el'], ['cs.RO', 'cs.CR'], ['cs.AI', 'cs.LG'], ['math.AG', 'math.CO'], ['stat.ML', 'stat.ME'], ['econ.EM', 'econ.GN'], ['q-fin.ST', 'q-fin.CP'], ['eess.SP', 'eess.SY']];

// The For You main request of a first page, with every rejection, exclusion
// and seen paper a reader can carry.
async function fullMainBody(plan: ReturnType<typeof feedPlanFor>) {
  const negativeIds = Array.from({ length: 24 }, (_, index) => `openalex:W99${String(index).padStart(8, '0')}`);
  const excludedIds = Array.from({ length: 200 }, (_, index) => `arxiv:2511.${10000 + index}`);
  const seen = new Set(Array.from({ length: 2000 }, (_, index) => `arxiv:2510.${10000 + index}`));
  const [body] = await bodiesOf({ ...mainCorpusRequest(plan, { page: 0, order: 'recent', negativeIds, excludedIds, seen }), notable: 5 });
  return body;
}

test('a reader of eight areas with likes in each keeps every rejection and exclusion in the request', async () => {
  const body = await fullMainBody(feedPlanFor(null, 0, memory({
    selected: eightAreas.flat(),
    examples: eightAreas.flatMap(([leaf], area) => [0, 1].map(index => ({ id: `openalex:W4${area}${index}0000000`, category: leaf }))),
  })));
  assert.equal(body.groups?.length, 8);
  assert.equal(body.positiveIds.length, 16);
  assert.equal(body.negativeIds?.length, 24);
  assert.equal(body.excludedIds?.length, 200);
});

test('a reader of seven areas with a like of no area keeps every rejection and exclusion in the request', async () => {
  const sevenAreas = [['quant-ph', 'cond-mat.str-el'], ['cs.AI', 'cs.LG'], ['math.AG', 'math.CO'], ['stat.ML', 'stat.ME'], ['econ.EM', 'econ.GN'], ['q-fin.ST', 'q-fin.CP'], ['eess.SP', 'eess.SY']];
  const body = await fullMainBody(feedPlanFor(null, 0, memory({
    selected: sevenAreas.flat(),
    examples: [
      ...sevenAreas.flatMap(([leaf], area) => [0, 1].map(index => ({ id: `openalex:W4${area}${index}0000000`, category: leaf }))),
      // Stored before examples had a category (profiles from before October 17).
      { id: 'openalex:W4900000000', category: '' },
    ],
  })));
  assert.equal(body.groups?.length, 7);
  assert.equal(body.positiveIds.length, 15);
  assert.equal(body.negativeIds?.length, 24);
  assert.equal(body.excludedIds?.length, 200);
});

test('a reader of ten areas sends every like of an area they never picked, and keeps every rejection and exclusion', async () => {
  const tenAreas = [...eightAreas, ['bio.gen', 'bio.mol'], ['med.gen', 'med.onco']];
  // DOI-length ids, twice as long as arXiv and OpenAlex ones.
  const likes = Array.from({ length: 24 }, (_, index) => `10.1000/like.${index}.`.padEnd(40, 'x'));
  const body = await fullMainBody(feedPlanFor(null, 0, memory({
    selected: tenAreas.flat(),
    examples: likes.map(id => ({ id, category: 'chem.anal' })),
  })));
  assert.equal(body.groups?.length, 10);
  assert.deepEqual([...body.positiveIds].sort(), [...likes].sort());
  assert.equal(body.negativeIds?.length, 24);
  assert.equal(body.excludedIds?.length, 200);
});

test('every page of one list ranks by the same likes and rejections when the request is trimmed', async () => {
  const tenAreas = [...eightAreas, ['bio.gen', 'bio.mol'], ['med.gen', 'med.onco']];
  const likes = Array.from({ length: 24 }, (_, index) => `10.1000/like.${index}.`.padEnd(40, 'x'));
  const plan = feedPlanFor(null, 0, memory({ selected: tenAreas.flat(), examples: likes.map(id => ({ id, category: 'chem.anal' })) }));
  const negativeIds = Array.from({ length: 24 }, (_, index) => `openalex:W99${String(index).padStart(8, '0')}`);
  const seen = new Set(Array.from({ length: 2000 }, (_, index) => `arxiv:2510.${10000 + index}`));
  const inputs = (body: Awaited<ReturnType<typeof bodiesOf>>[number]) =>
    ({ positiveIds: body.positiveIds, negativeIds: body.negativeIds, groups: body.groups?.map(group => group.positiveIds) });
  // One exclusion a character longer at a time moves the request across the
  // 43 bytes of a like's copy, which is what the trim drops first, so at some
  // length the bytes of `continues`, or the one byte of a two-digit page or
  // `notable`, would drop one more copy.
  for (let extra = 0; extra < 45; extra += 1) {
    const excludedIds = Array.from({ length: 200 }, (_, index) => `arxiv:2511.${10000 + index}${index === 0 ? 'v'.repeat(extra) : ''}`);
    const request = (page: number, notable: number, continues: boolean) =>
      ({ ...mainCorpusRequest(plan, { page, order: 'recent', negativeIds, excludedIds, seen }), notable, continues });
    const [first, resumed, next, tenth] = await bodiesOf(request(0, 5, false), request(0, 5, true), request(1, 12, false), request(10, 5, false));
    assert.ok(first.groups!.every(group => group.positiveIds.length < 24), 'the request is trimmed');
    assert.deepEqual(inputs(resumed), inputs(first), `a first page that continues the walk, ${extra} characters longer`);
    assert.deepEqual(inputs(next), inputs(first), `the second page, with a two-digit notable, ${extra} characters longer`);
    assert.deepEqual(inputs(tenth), inputs(first), `the eleventh page, ${extra} characters longer`);
  }
});

test('a page ranked by the reader’s publications alone names no reason on its cards (ENG-251)', async () => {
  const profile = createEmptyInteractionProfile();
  const plan = feedPlanFor(null, 0, { ...memory({ selected: ['cs.LG'] }), publications: [{ id: 'openalex:W1', category: 'cs.LG' }] }, profile);
  assert.deepEqual(plan.groups[0].positiveIds, ['openalex:W1']);
  const card = (await fetchCorpusPage(mainCorpusRequest(plan, shared), {
    apiBase: 'https://store.example',
    fetchWorker: async () => Response.json({ papers: [{ id: 'near', _semanticScore: 0.9 }] }),
  })).papers[0];
  assert.equal(card._semanticExampleKinds, undefined);
  assert.equal(feedReason({ ...card, _debugScore: scorePaperForRecommendation(card) }, null, 'feed', 'Research Paper'), null);

  // Beside a like, the Worker may have scored the card by the publication, so
  // the page names no reason either; the like comes first in the request.
  recordInteractionEvent(profile, { paperId: 'liked', kind: 'like', category: 'cs.LG' });
  const withLike = feedPlanFor(null, 0, {
    ...memory({ selected: ['cs.LG'], examples: readProfileSignals(profile).positiveExamples }),
    publications: [{ id: 'openalex:W1', category: 'cs.LG' }],
  }, profile);
  assert.deepEqual([...withLike.exampleKindsById!.keys()], ['liked']);
  let sent: string[] = [];
  const mixed = (await fetchCorpusPage(mainCorpusRequest(withLike, shared), {
    apiBase: 'https://store.example',
    fetchWorker: async (_url, init) => {
      sent = (JSON.parse(String(init.body)) as { positiveIds: string[] }).positiveIds;
      return Response.json({ papers: [{ id: 'near', _semanticScore: 0.9 }] });
    },
  })).papers[0];
  assert.deepEqual(sent, ['liked', 'openalex:W1']);
  assert.equal(mixed._semanticExampleKinds, undefined);
  assert.equal(feedReason({ ...mixed, _debugScore: scorePaperForRecommendation(mixed) }, null, 'feed', 'Research Paper'), null);

  // A Worker that marks the papers a publication scored best: the others name the like, as before.
  let seeds: unknown;
  const marked = (await fetchCorpusPage(mainCorpusRequest(withLike, shared), {
    apiBase: 'https://store.example',
    fetchWorker: async (_url, init) => {
      seeds = (JSON.parse(String(init.body)) as { seedIds?: string[] }).seedIds;
      return Response.json({ seedsScored: true, papers: [{ id: 'near-like', _semanticScore: 0.9 }, { id: 'near-pub', _semanticScore: 0.9, _semanticFromSeed: true }] });
    },
  })).papers;
  assert.deepEqual(seeds, ['openalex:W1']);
  const reasonOf = (card: (typeof marked)[number]) => feedReason({ ...card, _debugScore: scorePaperForRecommendation(card) }, null, 'feed', 'Research Paper')?.text ?? null;
  assert.deepEqual(marked.map(reasonOf), ['Similar to papers you liked', null]);
});

test('the reader’s examples come before their publications in the request, across groups and when it is trimmed (ENG-251)', async () => {
  const profile = createEmptyInteractionProfile();
  const long = (name: string) => `${name}-${'x'.repeat(900)}`;
  // Physics holds nine publications; economics, a later group, holds two
  // likes, and a like of no area belongs to no group, which the request
  // trimmed first before publications existed.
  for (const id of [long('like-a'), long('like-b')]) recordInteractionEvent(profile, { paperId: id, kind: 'like', category: 'econ.EM' });
  recordInteractionEvent(profile, { paperId: long('like-c'), kind: 'like', category: '' });
  const publications = Array.from({ length: 9 }, (_, index) => ({ id: long(`pub-${index}`), category: 'quant-ph' }));
  const plan = feedPlanFor(null, 0, {
    ...memory({ selected: ['quant-ph', 'econ.EM'], examples: readProfileSignals(profile).positiveExamples }),
    publications,
  }, profile);
  assert.deepEqual(plan.positiveIds.slice(0, 3).map(id => id.slice(0, 6)).sort(), ['like-a', 'like-b', 'like-c']);
  const [body] = await bodiesOf({ ...mainCorpusRequest(plan, shared), exampleKindsById: plan.exampleKindsById });
  const likes = body.positiveIds.filter(id => id.startsWith('like-'));
  const kept = body.positiveIds.filter(id => id.startsWith('pub-'));
  // The request was too long: publications went first, and every like stayed.
  assert.ok(kept.length < publications.length, 'the request was trimmed');
  assert.equal(likes.length, 3);
  assert.deepEqual(body.positiveIds.slice(0, 3), likes);
});

test('marking publications takes nothing from the ranking inputs a long request keeps (ENG-251)', async () => {
  const long = (name: string) => `${name}-${'x'.repeat(600)}`;
  const groups = [{ categories: ['cs.LG'], exampleCategories: ['cs.LG'], positiveIds: [long('like'), ...Array.from({ length: 4 }, (_, index) => long(`pub-${index}`))], weight: 1 }];
  const negativeIds = Array.from({ length: 24 }, (_, index) => long(`rejected-${index}`));
  const request = { ...shared, groups, positiveIds: [], negativeIds, pageSize: 15 };
  const everyExample = new Map(groups[0].positiveIds.map(id => [id, ['liked' as const]]));
  const likeOnly = new Map([[long('like'), ['liked' as const]]]);
  const [plain, seeded] = await bodiesOf({ ...request, exampleKindsById: everyExample }, { ...request, exampleKindsById: likeOnly });
  assert.ok((plain.negativeIds?.length ?? 0) < negativeIds.length, 'the request was trimmed');
  const { seedIds, ...rest } = seeded as typeof seeded & { seedIds?: string[] };
  assert.deepEqual(seedIds, groups[0].positiveIds.slice(1));
  assert.deepEqual(rest, plain);
});
