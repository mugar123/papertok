import type { PaperFollowMatch } from '../src/models/paper.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import type { FollowEntity } from '../src/utils/following.ts';
import type { FeedPlan } from '../src/context/feed-corpus-requests.ts';
import type { PaperStoreError } from './paper-store.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers, quantize } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { fetchFollowedEntityCandidates } from '../src/context/feed-follows.ts';
import { followedCorpusRequest } from '../src/context/feed-corpus-requests.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_PACE_PERIOD_MS, ARXIV_UPSTREAM_TIMEOUT_MS, handleHarvestArxiv } from './arxiv-api.ts';
import { handleRequest } from './router.ts';
import { feedSeenFilter, feedSeenIds } from '../src/utils/seen-paper-filter.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';

// Synthetic, in the shape the arXiv harvest stores.
const stored = arxivRecordPaper({
  arxivId: '2610.11111', title: 'Sparse attention for long documents', abstract: 'We make attention sparse.', authors: ['Ana Pérez'],
  categories: ['cs.CL'], doi: null, journalRef: null, comments: null,
  published: new Date(Date.now() - 86_400_000).toISOString(), updated: '',
});

function store() {
  const { binding, db } = testD1();
  const runs: unknown[] = [];
  const env = {
    PAPER_STORE: binding,
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
    PAPER_HARVEST: { create: async (options: unknown) => { runs.push(options); return {}; } },
  } as unknown as WorkerEnv;
  const ask = (body: unknown, uid = 'reader-1', later?: (work: Promise<unknown>) => void) => handleCorpusFeed(new Request('https://papertok.internal/store/papers', { method: 'POST', body: JSON.stringify(body) }), env, { uid }, later);
  return { env, db, runs, ask };
}

test("the corpus's copy of a paper comes back by any id the app holds for it, in the order asked", async () => {
  const { env, ask } = store();
  await ingestPapers(env, [{ paper: stored, lanes: [] }]);
  const { papers } = await ask({ ids: ['arxiv:2610.11111v2', '2610.11111'] });
  assert.deepEqual(papers.map(paper => paper.id), ['2610.11111', '2610.11111']);
  assert.equal(papers[0].title, 'Sparse attention for long documents');
  await assert.rejects(ask({ categories: [] }), { code: 'LANES_REQUIRED' });
});

test("a reader's new follows are harvested at once up to 20 a day, however many a request brings; past them the follow waits for the nightly run, and no reader is recorded with it", async () => {
  const { db, runs, ask } = store();
  // Authors known by name only: each is an arXiv search, which spends no share of OpenAlex.
  const author = (index: number) => ({ type: 'author', canonicalId: `name-${index}`, displayName: `Author ${index}` });
  await ask({ follows: Array.from({ length: 20 }, (_, index) => author(index)) });
  assert.equal(runs.length, 1);
  assert.equal((runs[0] as { params: { lanes: string[] } }).params.lanes.length, 20);
  // The same reader's 21st new follow of the day answers as usual and starts no run.
  assert.deepEqual(await ask({ follows: [author(20)] }), { papers: [] });
  assert.equal(runs.length, 1);
  // Another reader's still starts one.
  await ask({ follows: [author(21)] }, 'reader-2');
  assert.equal(runs.length, 2);
  assert.deepEqual((runs[1] as { params: { lanes: string[] } }).params.lanes, ['author-name:author 21']);
  // The 21st is registered too: the nightly run harvests what followed_lanes holds.
  const lanes = db.prepare('SELECT * FROM followed_lanes').all() as Array<Record<string, unknown>>;
  assert.equal(lanes.length, 22);
  assert.ok(lanes.some(row => row.lane === 'author-name:author 20'));
  assert.deepEqual(Object.keys(lanes[0]).sort(), ['failed_turns', 'lane', 'registered_at', 'requested_at', 'retry_at']);
});

test('a reader writes at most 40 followed lanes a day, new or asked for again; past them a new follow is served from what the corpus has and is not registered', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T12:00:00Z') });
  const { db, ask } = store();
  const searches = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'topic', canonicalId: `query-${from + index}`, displayName: `Search ${from + index}`, metadata: { query: `search ${from + index}` },
  }));
  const registered = () => (db.prepare('SELECT COUNT(*) AS n FROM followed_lanes').get() as { n: number }).n;
  await ask({ follows: searches(0, 20) });
  await ask({ follows: searches(20, 20) });
  assert.equal(registered(), 40);
  assert.deepEqual(await ask({ follows: searches(40, 1) }), { papers: [] });
  assert.equal(registered(), 40);
  // Another reader's new follow is still registered.
  await ask({ follows: searches(40, 1) }, 'reader-2');
  assert.equal(registered(), 41);

  // A week later, 20 of the reader's lanes asked for again are written again and leave them 20 new ones.
  t.mock.timers.setTime(Date.parse('2026-10-29T12:00:01Z'));
  await ask({ follows: searches(0, 20) });
  await ask({ follows: searches(41, 20) });
  assert.deepEqual(await ask({ follows: searches(61, 1) }), { papers: [] });
  assert.equal(registered(), 61);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM followed_lanes WHERE requested_at = '2026-10-29T12:00:01.000Z'").get() as { n: number }).n, 40);
});

// Every write of a lane, new or asked for again, counts in the app's 4,000 a
// day. Were a lane asked for daily written daily, 4,000 lanes asked for every
// morning would spend the app's day every day, and a lane asked for later in
// the day would never be written again: the nightly run drops a lane 14 days
// after its last write (paper-harvest.ts).
test("a lane asked for daily stays followed while other readers ask daily, before it, for 4,000 lanes", async t => {
  const day = 86_400_000;
  const start = Date.parse('2026-11-02T00:10:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { db, ask } = store();
  const searches = (name: string, count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'topic', canonicalId: `query-${name}-${index}`, displayName: `${name} ${index}`, metadata: { query: `${name} ${index}` },
  }));
  const lastWrite = () => (db.prepare("SELECT requested_at FROM followed_lanes WHERE lane = 'query:narrow 0'").get() as { requested_at: string } | undefined)?.requested_at;
  await ask({ follows: searches('narrow', 1) }, 'late-reader');
  for (let days = 0; days <= 14; days += 1) {
    // Ten minutes later each morning, so every lane is more than a day past its last write.
    const morning = start + days * (day + 10 * 60_000);
    t.mock.timers.setTime(morning);
    for (let reader = 0; reader < 200; reader += 1) await ask({ follows: searches(`reader ${reader}`, 20) }, `reader-${reader}`);
    t.mock.timers.setTime(morning + 30 * 60_000);
    await ask({ follows: searches('narrow', 1) }, 'late-reader');
    assert.ok(Date.parse(lastWrite() ?? '') > Date.now() - 14 * day, `day ${days}: last written ${lastWrite()}`);
  }
});

// The app sends every follow with each page, so new lanes the allowance refused
// all together would come back refused in every request that day.
test("a reader near the day's allowances still adds, and has harvested at once, the new lanes that fit", async () => {
  const { db, runs, ask } = store();
  const authors = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'author', canonicalId: `name-${from + index}`, displayName: `Author ${from + index}`,
  }));
  const lanesOf = (run: unknown) => (run as { params: { lanes: string[] } }).params.lanes;
  const registered = () => db.prepare('SELECT lane FROM followed_lanes').all().map(row => (row as { lane: string }).lane);

  await ask({ follows: authors(0, 19) });
  // Two new lanes and one run lane left: the first is harvested at once, both are added.
  await ask({ follows: authors(19, 2) });
  assert.equal(runs.length, 2);
  assert.deepEqual(lanesOf(runs[1]), ['author-name:author 19']);
  assert.equal(registered().length, 21);

  await ask({ follows: authors(21, 18) });
  // Two new lanes and one registration left: the first is added.
  await ask({ follows: authors(39, 2) });
  assert.equal(registered().length, 40);
  assert.ok(registered().includes('author-name:author 39'));
  assert.equal(registered().includes('author-name:author 40'), false);
});

test('two follows that name one lane count once against the allowances and are harvested once', async () => {
  const { db, runs, ask } = store();
  // Two authors known by the same name: one arXiv search.
  await ask({ follows: [
    { type: 'author', canonicalId: 'name-g1', displayName: 'Author G' },
    { type: 'author', canonicalId: 'name-g2', displayName: 'Author G' },
  ] });
  assert.deepEqual((runs[0] as { params: { lanes: string[] } }).params.lanes, ['author-name:author g']);
  // 39 more new lanes fit the reader's 40.
  const searches = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'topic', canonicalId: `query-${from + index}`, displayName: `Search ${from + index}`, metadata: { query: `search ${from + index}` },
  }));
  await ask({ follows: searches(0, 20) });
  await ask({ follows: searches(20, 19) });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM followed_lanes').get() as { n: number }).n, 40);
});

test('the page answers before a liked paper without a vector is embedded, and the Worker embeds it afterwards', async t => {
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  // Identity Toolkit knows the token; nothing else is reachable.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'identitytoolkit.googleapis.com') return Response.json({ users: [{ localId: 'reader-1' }] });
    throw new Error(`unexpected request to ${url.hostname}`);
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  const { env } = store();
  let embeddings = 0;
  Object.assign(env, {
    FIREBASE_WEB_API_KEY: 'firebase-test-key',
    AI: { run: async (_model: string, { text }: { text: string[] }) => {
      embeddings += 1;
      return { data: text.map(() => Array.from({ length: 1024 }, (_, dimension) => Math.sin(dimension))) };
    } },
  });
  await ingestPapers(env, [{ paper: stored, lanes: [] }]);
  const afterAnswer: Array<Promise<unknown>> = [];
  const response = await handleRequest(new Request('https://api.papertok.app/store/papers', {
    method: 'POST',
    headers: { authorization: `Bearer ${fakeIdToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ categories: ['cs.CL'], positiveIds: ['2610.11111'] }),
  }), env, { waitUntil: work => { afterAnswer.push(work); } });
  assert.equal(response.status, 200);
  assert.equal(embeddings, 0, 'nothing is embedded before the answer');
  await Promise.all(afterAnswer);
  assert.equal(embeddings, 1, 'the liked paper is embedded after it');
});

// arXiv's Atom answer for one id, as `parseArxivAtom` reads it (synthetic).
const SLOW_LIKE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2610.55555v1</id>
    <published>${new Date(Date.now() - 86_400_000).toISOString()}</published>
    <updated>${new Date(Date.now() - 86_400_000).toISOString()}</updated>
    <title>A liked paper arXiv answers slowly</title>
    <summary>We wait for it.</summary>
    <author><name>Ana Pérez</name></author>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
  </entry>
</feed>`;

test('a liked paper arXiv answers after 2 s is still filed by the lookup after the page, while an inline lookup keeps its 2 s', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  let arxivAsked = 0;
  // arXiv answers three seconds after it is asked.
  globalThis.fetch = (async () => {
    arxivAsked += 1;
    await new Promise(resolve => setTimeout(resolve, 3_000));
    return new Response(SLOW_LIKE, { headers: { 'content-type': 'application/atom+xml' } });
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  const asked = async (count: number) => {
    for (let turn = 0; arxivAsked < count; turn += 1) {
      if (turn > 1_000) throw new Error('arXiv was never asked');
      await new Promise(resolve => setImmediate(resolve));
    }
  };

  // After the page, the lookup waits for the answer. (Each case has its own
  // store: arXiv's beat would make the second request wait for a seat.)
  const later = store();
  Object.assign(later.env, { AI: { run: async (_model: string, { text }: { text: string[] }) => ({ data: text.map(() => Array.from({ length: 1024 }, () => 0.5)) }) } });
  await ingestPapers(later.env, [{ paper: stored, lanes: [] }]);
  const afterAnswer: Array<Promise<unknown>> = [];
  const request = new Request('https://papertok.internal/store/papers', { method: 'POST', body: JSON.stringify({ categories: ['cs.CL'], positiveIds: ['2610.55555'] }) });
  await handleCorpusFeed(request, later.env, { uid: 'reader-1' }, work => { afterAnswer.push(work); });
  await asked(1);
  t.mock.timers.tick(3_000);
  await Promise.all(afterAnswer);
  assert.equal(later.db.prepare("SELECT COUNT(*) AS n FROM work_keys WHERE key = 'arxiv:2610.55555'").get()?.n, 1);

  // `{ ids }` answers inline, so it waits 2 s at most.
  const inline = store();
  const answer = inline.ask({ ids: ['2610.55555'] });
  await asked(2);
  t.mock.timers.tick(2_000);
  assert.deepEqual((await answer).papers, []);
  t.mock.timers.tick(1_000);
});

test("the lookup after the page files what arXiv sends at the end of the route's longest seat wait and upstream deadline", async t => {
  // The route reads its cache, then waits up to ARXIV_PACE_MAX_WAIT_MS for a
  // seat on arXiv's beat, then up to ARXIV_UPSTREAM_TIMEOUT_MS for arXiv. Here
  // the cache read takes 0.3 s (in production, that read and the beat's
  // ledger round trips), the seat comes 0.1 s inside the longest wait, and
  // arXiv answers 0.1 s inside its deadline.
  const cacheReadMs = 300;
  const period = ARXIV_PACE_PERIOD_MS;
  const seatAsked = Math.floor(Date.now() / period) * period + 2 * period - ARXIV_PACE_MAX_WAIT_MS + 100;
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: seatAsked - 2 * cacheReadMs });
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  let arxivAsked = 0;
  globalThis.fetch = (async () => {
    arxivAsked += 1;
    await new Promise(resolve => setTimeout(resolve, ARXIV_UPSTREAM_TIMEOUT_MS - 100));
    return new Response(SLOW_LIKE, { headers: { 'content-type': 'application/atom+xml' } });
  });
  (globalThis as TestGlobals).caches = { default: {
    match: async (key: Request) => {
      if (new URL(key.url).pathname.startsWith('/cache/arxiv')) await new Promise(resolve => setTimeout(resolve, cacheReadMs));
      return null;
    },
    put: async () => undefined,
  } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  // The ledger hashes subjects off the event loop; let it answer between ticks.
  const flush = async () => {
    for (let turn = 0; turn < 50; turn += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const run = async (work: Promise<unknown>, limitMs: number) => {
    let settled = false;
    work.then(() => { settled = true; }, () => { settled = true; });
    for (let elapsed = 0; !settled && elapsed <= limitMs; elapsed += 100) {
      await flush();
      t.mock.timers.tick(100);
    }
    await flush();
    return work;
  };

  const { env, db } = store();
  Object.assign(env, { AI: { run: async (_model: string, { text }: { text: string[] }) => ({ data: text.map(() => Array.from({ length: 1024 }, () => 0.5)) }) } });
  await ingestPapers(env, [{ paper: stored, lanes: [] }]);
  // Two in-process arXiv searches take this period's seat and the next one:
  // the first goes to arXiv, the second waits for its seat.
  const searches = ['all:attention', 'all:sparsity'].map(query => handleHarvestArxiv(new Request(`https://papertok.internal/arxiv?search_query=${encodeURIComponent(query)}`), env));
  await flush();
  t.mock.timers.tick(cacheReadMs);
  for (let turn = 0; arxivAsked < 1; turn += 1) {
    if (turn > 10_000) throw new Error('the first search never reached arXiv');
    await new Promise(resolve => setImmediate(resolve));
  }
  await flush();

  const afterAnswer: Array<Promise<unknown>> = [];
  const request = new Request('https://papertok.internal/store/papers', { method: 'POST', body: JSON.stringify({ categories: ['cs.CL'], positiveIds: ['2610.55555'] }) });
  await handleCorpusFeed(request, env, { uid: 'reader-1' }, work => { afterAnswer.push(work); });
  await run(Promise.all([...afterAnswer, ...searches]), 15_000);
  assert.equal(arxivAsked, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_keys WHERE key = 'arxiv:2610.55555'").get()?.n, 1);
});

// This location's cache, where a reader's ranking is kept for their next pages.
// As in Cloudflare's, an entry is gone once its `max-age` has passed.
function rankingCaches(t: TestContext) {
  const entries = new Map<string, Response>();
  const expiries = new Map<string, number>();
  const realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: {
    match: async (request: Request) => ((expiries.get(request.url) ?? 0) > Date.now() ? entries.get(request.url)?.clone() : undefined),
    put: async (request: Request, response: Response) => {
      const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0);
      entries.set(request.url, response);
      expiries.set(request.url, Date.now() + maxAge * 1_000);
    },
  } };
  t.after(() => { (globalThis as { caches?: unknown }).caches = realCaches; });
  return entries;
}

test("a reader's ranking is kept for their next pages under their own key, never another reader's", async t => {
  const entries = rankingCaches(t);
  const { env, ask } = store();
  await ingestPapers(env, [{ paper: stored, lanes: [] }]);
  await ask({ categories: ['cs.CL'] }, 'reader-1');
  assert.equal(entries.size, 1);
  await ask({ categories: ['cs.CL'], page: 1 }, 'reader-1');
  assert.equal(entries.size, 1, 'the next page reads the order the first one kept');
  await ask({ categories: ['cs.CL'], page: 1 }, 'reader-2');
  assert.equal(entries.size, 2, "another reader's identical request ranks for them");
});

const DAY_MS = 86_400_000;
const paper = (arxivId: string, title: string, daysAgo: number) => arxivRecordPaper({
  arxivId, title, abstract: `${title}.`, authors: ['Ana Pérez'], categories: ['cs.CL'], doi: null, journalRef: null, comments: null,
  published: new Date(Date.now() - daysAgo * DAY_MS).toISOString(), updated: '',
});
const embed = (db: ReturnType<typeof store>['db'], arxivId: string, values: number[]) => db
  .prepare('INSERT INTO work_vectors (work_id, embedding) SELECT work_id, ? FROM work_keys WHERE key = ?')
  .run(Buffer.from(quantize(values).buffer), `arxiv:${arxivId}`);
// Workers AI's embedding model, answering every text with one direction.
const embeddingModel = () => ({
  run: async (_model: string, { text }: { text: string[] }) => ({ data: text.map(() => Array.from({ length: 1024 }, (_, index) => (index === 0 ? 1 : 0))) }),
});

const ids = (papers: Array<{ id: string }>) => papers.map(item => item.id);

test('the corpus route excludes seen and rejected aliases, and transports negative relevance', async t => {
  rankingCaches(t);
  const { env, db, ask } = store();
  await ingestPapers(env, [
    { paper: paper('2610.40001', 'Rejected paper', 4), lanes: [] },
    { paper: paper('2610.40002', 'Near copy of rejected paper', 2), lanes: [] },
    { paper: paper('2610.40003', 'Distant topic', 2), lanes: [] },
    { paper: paper('2610.40004', 'Already viewed', 1), lanes: [] },
  ]);
  embed(db, '2610.40001', [1, 0]);
  embed(db, '2610.40002', [1, 0]);
  embed(db, '2610.40003', [0, 1]);
  const request = { categories: ['cs.CL'], negativeIds: ['arxiv:2610.40001v2'], excludedIds: ['arxiv:2610.40004v2'], pageSize: 2 };
  const { papers } = await ask(request);
  assert.deepEqual(ids(papers), ['2610.40003', '2610.40002']);
  assert.equal(papers[0]._semanticScore, 0);
  assert.equal(papers[1]._semanticScore, -1);
  const changed = await ask({ ...request, negativeIds: ['2610.40003'], page: 1, pageSize: 1 });
  assert.deepEqual(ids(changed.papers), ['2610.40001'], 'changing feedback or page size cannot reuse the previous cached ranking');
});

test('a next page asked while the lookup after the first still runs goes on after the ranks the first served', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  // Workers AI answers only when the test lets it.
  let answer = () => {};
  const model = embeddingModel();
  Object.assign(env, { AI: { run: async (name: string, input: { text: string[] }) => {
    await new Promise<void>(resolve => { answer = resolve; });
    return model.run(name, input);
  } } });
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'The paper liked, not embedded yet', 10), lanes: [] },
    { paper: paper('2610.20001', 'Newer paper', 1), lanes: [] },
    { paper: paper('2610.20002', 'Older paper', 2), lanes: [] },
  ]);
  const request = (page: number) => ({ categories: ['cs.CL'], positiveIds: ['2610.30001'], page, pageSize: 1 });
  const after: Array<Promise<unknown>> = [];
  assert.deepEqual(ids((await ask(request(0), 'reader-1', work => { after.push(work); })).papers), ['2610.20001']);
  // A paper the harvest files while that lookup waits for Workers AI.
  await ingestPapers(env, [{ paper: paper('2610.20003', 'Newest paper', 0.5), lanes: [] }]);
  assert.deepEqual(ids((await ask(request(1))).papers), ['2610.20003']);
  assert.deepEqual(ids((await ask(request(2))).papers), ['2610.20002']);
  answer();
  await Promise.all(after);
});

test('an empty first page keeps no order, so papers that arrive after it start on the next page', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  assert.deepEqual((await ask({ categories: ['cs.CL'], pageSize: 1 })).papers, []);
  await ingestPapers(env, [{ paper: paper('2610.20001', 'Newer paper', 1), lanes: [] }, { paper: paper('2610.20002', 'Older paper', 2), lanes: [] }]);
  assert.deepEqual(ids((await ask({ categories: ['cs.CL'], page: 1, pageSize: 1 })).papers), ['2610.20001']);
  assert.deepEqual(ids((await ask({ categories: ['cs.CL'], page: 2, pageSize: 1 })).papers), ['2610.20002']);
});

// Where Worker versions before KeptRanking keep a reader's order, and where a
// rollback to one reads it: a plain list of ranks, under a digest of the uid
// and the request, which they slice for the next page.
async function previousWorkerKey(uid: string, request: { lanes: string[]; positives: string[]; order: string }) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${uid}\n${JSON.stringify(request)}`));
  return `https://papertok.internal/cache/store-ranking/${Buffer.from(digest).toString('hex')}`;
}

test("this Worker and earlier versions never read each other's kept orders, so after a rollback or a deploy the next page is ranked again", async t => {
  const entries = rankingCaches(t);
  const { env, db, ask } = store();
  await ingestPapers(env, [{ paper: paper('2610.80001', 'Newer paper', 1), lanes: [] }, { paper: paper('2610.80002', 'Older paper', 2), lanes: [] }]);
  const request = (page: number) => ({ categories: ['cs.CL'], page, pageSize: 1 });
  const asked = { lanes: ['cs.CL'], positives: [], order: 'recent' };
  assert.deepEqual(ids((await ask(request(0), 'reader-1')).papers), ['2610.80001']);
  assert.equal(entries.size, 1, 'the order is kept');
  assert.equal(entries.get(await previousWorkerKey('reader-1', asked)), undefined, 'after a rollback, the next page finds no order to slice');
  // The order an earlier version kept for a reader's first page, as it keeps
  // it: in an order this one would not serve.
  const workId = (arxivId: string) => (db.prepare('SELECT work_id FROM work_keys WHERE key = ?').get(`arxiv:${arxivId}`) as { work_id: number }).work_id;
  const previousKey = await previousWorkerKey('reader-2', asked);
  const previousList = ['2610.80002', '2610.80001'].map(arxivId => ({ workId: workId(arxivId), lanes: ['cs.CL'] }));
  entries.set(previousKey, new Response(JSON.stringify(previousList)));
  assert.deepEqual(ids((await ask(request(1), 'reader-2')).papers), ['2610.80002'], 'ranked again, newest first');
  assert.deepEqual(await entries.get(previousKey)?.json(), previousList, 'an earlier version still serving finds the list it kept');
});

// `count` cs.CL papers, an hour apart, newest first.
const recent = (count: number) => Array.from({ length: count }, (_, index) => paper(`2610.6${String(index).padStart(4, '0')}`, `Recent paper ${index}`, (index + 1) / 24));

test("a reload is one request for the reader's next unseen papers, and the next page goes on past the ones it showed, from the order the reload kept", async t => {
  const entries = rankingCaches(t);
  const { env, db, ask } = store();
  const papers = recent(60);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  // Two pages an earlier session showed.
  const shown = ids(papers.slice(0, 30));
  const reload = await ask({ categories: ['cs.CL'], page: 0, pageSize: 15, seen: feedSeenFilter(shown), skipsSeen: true });
  assert.deepEqual(ids(reload.papers), ids(papers.slice(30, 45)));
  assert.equal(reload.skipsSeen, true, 'the answer says the filter was applied');
  // Whatever the lanes hold now, the next page reads the order the reload kept.
  db.exec('DELETE FROM work_lanes');
  const next = await ask({ categories: ['cs.CL'], page: 1, pageSize: 15, seen: feedSeenFilter([...shown, ...ids(reload.papers)]), skipsSeen: true });
  assert.deepEqual(ids(next.papers), ids(papers.slice(45, 60)));
  // Each filter is its request's own: both read one kept order, which holds neither.
  assert.equal(entries.size, 1);
  const kept = await [...entries.values()][0].clone().text();
  assert.ok(!kept.includes(feedSeenFilter(shown)), 'the filter is not kept');
});

test('a reload keeps the same order and count of ranks served whether the reader had seen most of their ranking or none of it', async t => {
  const entries = rankingCaches(t);
  const { env, ask } = store();
  // More ranks than the walk's first read of ids, which the reader with
  // most seen passes.
  const papers = recent(600);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const reload = (uid: string, seen: string[]) => ask({ categories: ['cs.CL'], page: 0, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true }, uid);
  assert.deepEqual(ids((await reload('reader-1', ids(papers.slice(0, 400)))).papers), ids(papers.slice(400, 415)));
  assert.deepEqual(ids((await reload('reader-2', [])).papers), ids(papers.slice(0, 15)));
  // Each reader's order, under their own key. The ids each walk read differ
  // (KeptRanking says how far they tell); the order and `served` do not.
  type Kept = { ranks: Array<{ workId: number } | null>; served: number; final: boolean };
  const shape = ({ ranks, served, final }: Kept) => ({ ranks: ranks.map(rank => rank?.workId), served, final });
  const [seenMost, seenNone] = await Promise.all([...entries.values()].map(async entry => shape(await entry.clone().json<Kept>())));
  assert.deepEqual(seenMost, seenNone);
});

test("a reader who has seen every paper of their ranking gets the page they asked for again, and an app without the filter keeps page numbers", async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(20);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const request = (page: number, seen: string[]) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true });
  // All but two seen: those two, with no seen paper added.
  const twoLeft = await ask(request(0, ids(papers.slice(0, 18))));
  assert.deepEqual([ids(twoLeft.papers), twoLeft.skipsSeen], [ids(papers.slice(18)), true]);
  // All seen: the pages the request names, as without the filter, so the feed is not empty.
  const all = ids(papers);
  const again = await ask(request(0, all));
  assert.deepEqual([ids(again.papers), again.skipsSeen], [ids(papers.slice(0, 15)), true]);
  assert.deepEqual(ids((await ask(request(1, all))).papers), ids(papers.slice(15)));
  assert.deepEqual((await ask(request(2, all))).papers, []);
  // An app that sends no filter.
  const numbered = await ask({ categories: ['cs.CL'], page: 1, pageSize: 15 }, 'reader-2');
  assert.deepEqual(ids(numbered.papers), ids(papers.slice(15)));
  assert.equal('skipsSeen' in numbered, false);
});

// The bundles of PAP-99's second part send the filter with every main page,
// for notable papers only, and go one page on while a page holds no unseen
// paper. They do not add the papers they leave out to it.
test('an app that sends the filter without asking to skip seen papers keeps page numbers', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(45);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  // The first page, all seen.
  const seen = feedSeenFilter(ids(papers.slice(0, 15)));
  const first = await ask({ categories: ['cs.CL'], page: 0, pageSize: 15, seen, notable: 3 });
  assert.deepEqual(ids(first.papers), ids(papers.slice(0, 15)), 'the page it names');
  assert.equal('skipsSeen' in first, false, 'so the app goes one page on');
  assert.deepEqual(ids((await ask({ categories: ['cs.CL'], page: 1, pageSize: 15, seen, notable: 3 })).papers), ids(papers.slice(15, 30)));
});

// The same bundles through a session: each card they show joins the filter,
// they place one notable card a page, and a like goes with every page after it.
test('an app that sends the filter only for notable papers keeps page numbers through a like, and gets each notable paper until it places it', async t => {
  rankingCaches(t);
  const { env, db, ask } = store();
  const papers = recent(60);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  const notable = Array.from({ length: 8 }, (_, index) => `1901.${String(index).padStart(5, '0')}`);
  notable.forEach((id, index) => {
    const listed = new Date(Date.UTC(2024, 0, 1) - index * 3_600_000).toISOString();
    insertWork.run(10_000 + index, JSON.stringify({ id, title: `Notable paper ${index}`, authors: [] }), listed, '2099-01-01T00:00:00.000Z');
    insertLane.run('notable:cs.CL', 10_000 + index, listed);
  });
  const seen = new Set<string>();
  const pages: string[][] = [];
  const offers: string[][] = [];
  for (let page = 0; page < 4; page += 1) {
    // Filed by the harvest after the second page, newer than any before.
    if (page === 2) await ingestPapers(env, [{ paper: paper('2610.69999', 'A paper filed during the session', 0.01), lanes: [] }]);
    const answer = await ask({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), notable: 3, positiveIds: page >= 2 ? ['2610.99999'] : [] });
    assert.equal('skipsSeen' in answer, false, `page ${page}`);
    const shown = ids(answer.papers.filter(item => !item._notable));
    const offered = ids(answer.papers.filter(item => item._notable));
    [...shown, offered[0]].forEach(id => seen.add(id));
    pages.push(shown);
    offers.push(offered);
  }
  assert.deepEqual(pages, [ids(papers.slice(0, 15)), ids(papers.slice(15, 30)), ['2610.69999', ...ids(papers.slice(30, 44))], ids(papers.slice(44, 59))]);
  assert.deepEqual(offers, [notable.slice(0, 3), notable.slice(1, 4), notable.slice(2, 5), notable.slice(3, 6)]);
});

test('a request with a hundred and twenty follows, the likes and the filter fits the body cap', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  await ingestPapers(env, [{ paper: paper('2610.70001', "A followed author's paper", 1), lanes: ['author:A5000000000'] }]);
  // No bundle sends this request: bundles before this one send every follow
  // as stored but no filter with them, and this one sends at most 20 follows.
  // It pins the cap above the 16 KB the route took before.
  const follows = Array.from({ length: 120 }, (_, index) => ({
    type: 'author', canonicalId: `https://openalex.org/A${5_000_000_000 + index}`, displayName: `Followed author number ${index}`, metadata: {},
  }));
  const positiveIds = Array.from({ length: 24 }, (_, index) => `openalex:W${7_000_000_000 + index}`);
  const seen = feedSeenFilter(Array.from({ length: 2_000 }, (_, index) => `2610.${String(index).padStart(5, '0')}`));
  const body = { categories: [], follows, positiveIds, page: 0, pageSize: 6, order: 'recent', seen, skipsSeen: true };
  assert.ok(JSON.stringify(body).length > 16_384, 'the request is longer than the 16 KB the route took before the filter');
  assert.deepEqual(ids((await ask(body)).papers), ['2610.70001']);
});

// PAP-107: a journal article of a whole area, as its OpenAlex lane lists it (synthetic).
const physicsArticle = mapOpenAlexWork({
  id: 'https://openalex.org/W7223244690',
  doi: 'https://doi.org/10.7566/jpsj.95.111002',
  title: 'High-harmonic Generation Spectroscopy in van der Waals Materials',
  type: 'article',
  publication_date: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10),
  authorships: [{ author: { id: 'https://openalex.org/A5102845839', display_name: 'Kento Uchida' }, institutions: [] }],
  abstract_inverted_index: { 'High-harmonic': [0], generation: [1], probes: [2], 'electron dynamics in crystalline solids.': [3] },
  primary_location: { is_oa: false, landing_page_url: 'https://doi.org/10.7566/jpsj.95.111002', source: { id: 'https://openalex.org/S119212824', display_name: 'Journal of the Physical Society of Japan', type: 'journal' } },
  open_access: { is_oa: false, oa_status: 'closed', oa_url: null },
  primary_topic: {
    id: 'https://openalex.org/T10566', display_name: 'Laser-Matter Interactions and Applications',
    subfield: { id: 'https://openalex.org/subfields/3107', display_name: 'Atomic and Molecular Physics, and Optics' },
    field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' },
  },
})!;

test("the app's follows' page for follows with no lane of their own reads no area lane, and answers no papers where nothing is followed by lane or category", async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const quantum = arxivRecordPaper({
    arxivId: '2610.00021', title: 'A quantum error-correcting code', abstract: 'A code.', authors: ['Ana Pérez'], categories: ['quant-ph'],
    doi: null, journalRef: null, comments: null, published: new Date(Date.now() - 2 * DAY_MS).toISOString(), updated: '',
  });
  await ingestPapers(env, [{ paper: quantum, lanes: [] }, { paper: physicsArticle, lanes: ['area:physics'] }]);
  // The app's request, answered by this route as the router answers it.
  const fetchWorker = async (_url: string, init: RequestInit) => {
    try {
      return Response.json(await ask(JSON.parse(String(init.body))));
    } catch (error) {
      return Response.json({ code: (error as PaperStoreError).code }, { status: (error as PaperStoreError).status });
    }
  };
  const plan: FeedPlan = { groups: [], unassignedPositiveIds: [], positiveIds: [], dormantCategories: [], interestProgress: {}, coldAdded: [] };
  const followsPage = (follows: FollowEntity[]) => fetchFollowedEntityCandidates(followedCorpusRequest(
    plan,
    follows,
    follow => (follow.canonicalId === 'quant-ph' ? ['quant-ph'] : []),
    { page: 0, order: 'recent', negativeIds: [], excludedIds: [], seen: new Set() },
  ), { fetchWorker, apiBase: 'https://worker.example' });
  // A reader whose only follow is one of the app's categories: the page is
  // that category's papers, not the area's journal articles, which match no follow.
  const categoryOnly = await followsPage([{ type: 'topic', canonicalId: 'quant-ph', displayName: 'Quantum Physics' }]);
  assert.deepEqual(categoryOnly.map(item => item.id), ['2610.00021']);
  // A reader who follows only an institution known by its ROR id, which no lane serves.
  assert.deepEqual(await followsPage([{ type: 'institution', canonicalId: '00f54p054', displayName: 'Stanford University' }]), []);
});

test("a reader's next pages from the kept order read each stored id once, however far they scroll", async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(450);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const binding = env.PAPER_STORE as D1Database;
  const prepare = binding.prepare.bind(binding);
  let idReads = 0;
  t.mock.method(binding, 'prepare', (sql: string) => {
    if (sql.includes("paper ->> '$.id'")) idReads += 1;
    return prepare(sql);
  });
  const shown: string[] = [];
  for (let page = 0; page < 30; page += 1) {
    const answer = await ask({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(shown), skipsSeen: true });
    assert.deepEqual(ids(answer.papers), ids(papers.slice(page * 15, (page + 1) * 15)), `page ${page}`);
    shown.push(...ids(answer.papers));
  }
  assert.ok(idReads <= 3, `${idReads} reads of stored ids for thirty pages`);
});

// A filter that holds nothing shows where a walk starts. A first page that
// says it continues (a follow change, FeedContext) goes on with the walk the
// reader's order kept; one that does not, as every bundle before it asks,
// starts a new walk from the top, as does one whose order is gone.
test('a first page that continues goes on with the walk of the order kept for the reader, and one that does not starts from the top', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(60);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const request = (page: number, seen: string[], extra: object = {}) => ({ categories: ['cs.CL'], excludedIds: ['2609.99999'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, ...extra });
  await ask(request(0, []));
  await ask(request(1, ids(papers.slice(0, 15))));
  assert.deepEqual(ids((await ask(request(0, [], { continues: true }))).papers), ids(papers.slice(15, 30)));
  assert.deepEqual(ids((await ask(request(0, []))).papers), ids(papers.slice(0, 15)));
  await ask(request(1, ids(papers.slice(0, 15))));
  assert.deepEqual(ids((await ask(request(0, [], { continues: 'true' }))).papers), ids(papers.slice(0, 15)), 'only true continues');
  assert.deepEqual(ids((await ask(request(0, [], { continues: true }), 'reader-2')).papers), ids(papers.slice(0, 15)), 'no order kept for this reader');
  assert.deepEqual(ids((await ask(request(0, [], { continues: true, excludedIds: [] }))).papers), ids(papers.slice(0, 15)), 'no order kept for these exclusions');
});

// The load a follow change starts plans the interest groups again (ENG-137),
// and their weights move as the reader sees cards: the groups rank the order
// again, after the ranks the walk passed, rather than start a new walk.
test('a first page that continues goes on with the walk when the load planned other interest groups', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(60);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const groups = (weight: number) => [{ categories: ['cs.CL'], exampleCategories: ['cs.CL'], positiveIds: [], weight }];
  const request = (page: number, seen: string[], extra: object = {}) => ({ groups: groups(1), page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, ...extra });
  await ask(request(0, []));
  await ask(request(1, ids(papers.slice(0, 15))));
  assert.deepEqual(ids((await ask(request(0, [], { groups: groups(2), continues: true }))).papers), ids(papers.slice(15, 30)));
});

// A rejection or a like since the last page ranks again after the ranks the
// walk passed; the papers it excludes leave those too. Here the reader has seen
// every paper, so the page is the one its number names, papers seen before.
test('a page that goes on with a walk after the reader rejected its first papers sends none of them, though the reader has seen every paper', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(45);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const request = (page: number, seen: string[], extra: object = {}) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, ...extra });
  assert.deepEqual(ids((await ask(request(0, []))).papers), ids(papers.slice(0, 15)));
  assert.deepEqual(ids((await ask(request(1, ids(papers.slice(0, 15))))).papers), ids(papers.slice(15, 30)));
  // The reader rejects the first page's papers, has seen the rest elsewhere, then follows someone.
  const rejected = { negativeIds: ids(papers.slice(0, 15)) };
  const continued = await ask(request(0, ids(papers), { ...rejected, continues: true }));
  assert.deepEqual(ids(continued.papers), ids(papers.slice(15, 30)));
  assert.deepEqual(ids((await ask(request(0, ids(papers), rejected), 'reader-2')).papers), ids(papers.slice(15, 30)), 'as without the kept order');
});

// Counted in Workers Logs (worker/README.md): a later page of a walk whose
// order this data center does not hold, after a move to another one, an early
// eviction or a break of more than two hours.
test('a later page of a walk with no order kept logs a line that names neither the reader nor a paper', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(30);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const logged = t.mock.method(console, 'log', () => {});
  const walk = (page: number) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter([]), skipsSeen: true });
  await ask(walk(0));
  await ask(walk(1));
  await ask({ categories: ['cs.CL'], page: 1, pageSize: 15 }, 'reader-2');
  assert.equal(logged.mock.callCount(), 0, 'a first page, a page of a kept order, and a page asked by number');
  await ask(walk(1), 'reader-3');
  await ask(walk(4), 'reader-4');
  const lines = logged.mock.calls.map(call => call.arguments.join(' '));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1], 'the same line for every reader');
  assert.ok(!lines[0].includes('reader-') && !lines[0].includes('2610.'), lines[0]);
});

// A first page that continues (a follow change) goes on with a walk too: when
// its order is gone, the walk starts again from the top, which the line counts
// as it does for a later page.
test('a first page that continues a walk with no order kept logs the line of a later page', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(30);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const logged = t.mock.method(console, 'log', () => {});
  const walk = (page: number, extra: object = {}) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter([]), skipsSeen: true, ...extra });
  await ask(walk(0));
  await ask(walk(0, { continues: true }));
  assert.equal(logged.mock.callCount(), 0, 'a first page that starts a walk, and one that continues a walk whose order is kept');
  await ask(walk(0, { continues: true }), 'reader-2');
  await ask(walk(1), 'reader-3');
  const lines = logged.mock.calls.map(call => call.arguments.join(' '));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1], 'the line a later page logs');
});

// How long a reader's order is kept (privacy.html): a walk's, two hours from
// its last page; one paged by number, 15 minutes. Without it, a page is
// ranked from the top, where a paper filed since comes first.
test('a walk 90 minutes after its last page goes on past the papers it sent, while a page asked by number 20 minutes after its last one is ranked from the top', async t => {
  rankingCaches(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { env, ask } = store();
  const papers = recent(60);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const byNumber = (page: number) => ({ categories: ['cs.CL'], page, pageSize: 15 });
  const walk = (page: number, seen: string[]) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true });
  assert.deepEqual(ids((await ask(byNumber(0))).papers), ids(papers.slice(0, 15)));
  await ask(walk(0, []), 'reader-2');
  assert.deepEqual(ids((await ask(walk(1, ids(papers.slice(0, 15))), 'reader-2')).papers), ids(papers.slice(15, 30)));
  t.mock.timers.tick(20 * 60_000);
  await ingestPapers(env, [{ paper: paper('2610.70001', 'Filed during the break', 0), lanes: [] }]);
  assert.deepEqual(ids((await ask(byNumber(1))).papers), ids(papers.slice(14, 29)));
  t.mock.timers.tick(70 * 60_000);
  // A filter that no longer holds the first page's papers: the walk goes on
  // past them, and the paper filed since comes right after the ranks it passed.
  assert.deepEqual(ids((await ask(walk(2, ids(papers.slice(15, 30))), 'reader-2')).papers), ['2610.70001', ...ids(papers.slice(30, 44))]);
});

// The app asks for one page more on every load, the follows' page included.
test('a session past its hundredth load still gets the next papers of its ranking, while a page asked by number stops at page 100', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  const papers = recent(45);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const request = (page: number, seen: string[]) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true });
  assert.deepEqual(ids((await ask(request(0, []))).papers), ids(papers.slice(0, 15)));
  const past = await ask(request(101, ids(papers.slice(0, 15))));
  assert.deepEqual([ids(past.papers), past.skipsSeen], [ids(papers.slice(15, 30)), true]);
  assert.deepEqual(ids((await ask(request(250, ids(papers.slice(0, 30))))).papers), ids(papers.slice(30, 45)));
  assert.deepEqual(await ask({ categories: ['cs.CL'], page: 101, pageSize: 15 }), { papers: [] });
});

// Past page 100, a page with nothing unseen to send has no papers: the end of
// the feed (pageAfterLoad). Had it sent page 100's ranks 1,500 to 1,514, every
// later load would get those 15 seen papers again, and the app, which lists
// none twice, would go on asking.
test('a session that walks past the last unseen paper of its ranking after its hundredth load gets no papers, while a page asked by number keeps its page', async t => {
  rankingCaches(t);
  const { db, ask } = store();
  const ranking = Array.from({ length: 1_530 }, (_, rank) => `2610.${String(rank).padStart(5, '0')}`);
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  ranking.forEach((paperId, rank) => {
    const published = new Date(Date.now() - (rank + 1) * 60_000).toISOString();
    insertWork.run(rank + 1, JSON.stringify({ id: paperId, title: `Paper ${rank}`, authors: [] }), published, '2099-01-01T00:00:00.000Z');
    insertLane.run('cs.CL', rank + 1, published);
  });
  db.exec('COMMIT');
  // Seen in earlier sessions: all but the last 30.
  const seen = ranking.slice(0, 1_500);
  const answers = [];
  for (const page of [101, 102, 103, 104]) {
    const answer = await ask({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true });
    answers.push({ papers: ids(answer.papers), skipsSeen: answer.skipsSeen });
    seen.push(...ids(answer.papers));
  }
  assert.deepEqual(answers, [
    { papers: ranking.slice(1_500, 1_515), skipsSeen: true },
    { papers: ranking.slice(1_515), skipsSeen: true },
    { papers: [], skipsSeen: true },
    { papers: [], skipsSeen: true },
  ]);
  // Up to page 100, the page the request names, seen papers shown again.
  const atLast = await ask({ categories: ['cs.CL'], page: 100, pageSize: 15, seen: feedSeenFilter(ranking), skipsSeen: true }, 'reader-2');
  assert.deepEqual(ids(atLast.papers), ranking.slice(1_500, 1_515));
  // Bundles that page by number.
  assert.deepEqual(ids((await ask({ categories: ['cs.CL'], page: 100, pageSize: 15 }, 'reader-3')).papers), ranking.slice(1_500, 1_515));
  assert.deepEqual(await ask({ categories: ['cs.CL'], page: 101, pageSize: 15 }, 'reader-3'), { papers: [] });
});

// What a fold (ingestPapers' `folded`) or an eviction does to a work's row.
function removeWork(db: ReturnType<typeof store>['db'], arxivId: string) {
  const { work_id: workId } = db.prepare('SELECT work_id FROM work_keys WHERE key = ?').get(`arxiv:${arxivId}`) as { work_id: number };
  db.exec(`DELETE FROM work_lanes WHERE work_id = ${workId}; DELETE FROM work_keys WHERE work_id = ${workId}; DELETE FROM works WHERE id = ${workId};`);
}

// A reload walked the order and left every id on it; the corpus then dropped
// some of the works the next page would show.
const dropped: Array<[number[], string]> = [[[16], 'one work of the next page leaves'], [Array.from({ length: 15 }, (_, index) => 15 + index), "the next page's fifteen works leave"]];
for (const [removed, name] of dropped) {
  test(`${name} the corpus after the reload walked past it: the next pages are still full, and pass over it`, async t => {
    rankingCaches(t);
    const { env, db, ask } = store();
    const papers = recent(120);
    await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
    const request = (page: number, seen: string[]) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true });
    const shown = ids((await ask(request(0, []))).papers);
    assert.deepEqual(shown, ids(papers.slice(0, 15)));
    for (const index of removed) removeWork(db, papers[index].id);
    const left = ids(papers.filter((_, index) => index >= 15 && !removed.includes(index)));
    for (let page = 1; page <= 4; page += 1) {
      const answer = await ask(request(page, shown));
      assert.deepEqual(ids(answer.papers), left.slice((page - 1) * 15, page * 15), `page ${page}`);
      shown.push(...ids(answer.papers));
    }
  });
}

// The reader has seen every paper, so a walk finds none to send and falls back
// on the page its number names; the corpus has dropped that page's works since
// the pages left their ids on the kept order. A follow change asks for it, with
// the order as it was ranked or, 15 minutes on, ranked again after the walk.
// The walk is still at its second page when the corpus drops the works, or a
// follow change walked it to the end of the order first, so that the page after
// the drop changes only the ids the order keeps.
const fallbackOrders: Array<[number, string]> = [[0, 'the order as it was ranked'], [20, 'an order ranked again 20 minutes on']];
const fallbackWalks: Array<[boolean, string]> = [[false, 'a walk at its second page'], [true, 'a walk a follow change took to the end of its order']];
const fallbackCases = fallbackWalks.flatMap(([followed, walk]) => fallbackOrders.map(([minutes, order]) => ({
  followed, minutes, name: `${walk}, after the corpus dropped the papers its number names, sends the next ones from ${order}`,
})));
for (const { followed, minutes, name } of fallbackCases) {
  test(`a page that goes on with ${name}, though the reader has seen every paper`, async t => {
    rankingCaches(t);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const { env, db, ask } = store();
    const papers = recent(45);
    await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
    const request = (page: number, seen: string[], extra: object = {}) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, ...extra });
    await ask(request(0, []));
    await ask(request(1, ids(papers.slice(0, 15))));
    const continued = request(0, ids(papers), { continues: true });
    if (followed) await ask(continued);
    const workId = (arxivId: string) => (db.prepare('SELECT work_id FROM work_keys WHERE key = ?').get(`arxiv:${arxivId}`) as { work_id: number }).work_id;
    const gone = new Set(papers.slice(0, 15).map(item => workId(item.id)));
    for (const item of papers.slice(0, 15)) removeWork(db, item.id);
    t.mock.timers.tick(minutes * 60_000);
    assert.deepEqual(ids((await ask(continued)).papers), ids(papers.slice(15, 30)));
    assert.deepEqual(ids((await ask(request(0, ids(papers)), 'reader-2')).papers), ids(papers.slice(15, 30)), 'as without the kept order');
    // The works whose rows the next page reads: the kept order no longer names the dropped ones.
    const binding = env.PAPER_STORE as D1Database;
    const prepare = binding.prepare.bind(binding);
    const read: number[] = [];
    t.mock.method(binding, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith('SELECT w.id, w.paper, w.kept_until')) return statement;
      return { bind: (list: string) => { read.push(...JSON.parse(list) as number[]); return statement.bind(list); } };
    });
    assert.deepEqual(ids((await ask(continued)).papers), ids(papers.slice(15, 30)), 'after another follow');
    assert.deepEqual(read.filter(id => gone.has(id)), []);
  });
}

// The walk goes on from the papers the last page sent, which the reader has
// not seen, but the corpus has dropped them and the ranks before them: past
// them every paper is seen, so the page falls back on the one its number names.
test('a page that goes on with a walk whose unseen papers the corpus dropped, with the ranks before them, sends the next ones, though the reader has seen those', async t => {
  rankingCaches(t);
  const { env, db, ask } = store();
  const papers = recent(45);
  await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
  const request = (page: number, seen: string[], extra: object = {}) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, ...extra });
  await ask(request(0, []));
  await ask(request(1, ids(papers.slice(0, 15))));
  for (const item of papers.slice(0, 30)) removeWork(db, item.id);
  const seen = ids([...papers.slice(0, 15), ...papers.slice(30)]);
  assert.deepEqual(ids((await ask(request(0, seen, { continues: true }))).papers), ids(papers.slice(30)));
  assert.deepEqual(ids((await ask(request(0, seen), 'reader-2')).papers), ids(papers.slice(30)), 'as without the kept order');
});

// The notable cards a page offers after its own papers walk the notable lane's
// kept order, which holds ids too. The corpus drops works of the lane after a
// page read their ids: the walk goes on past them to the next unseen ones.
const notableDrops: Array<[string, boolean]> = [['the next page', false], ['a continued first page whose ranked papers the corpus dropped too', true]];
for (const [page, rankedDropped] of notableDrops) {
  test(`${page} offers the next notable papers past the ones the corpus dropped from the lane`, async t => {
    rankingCaches(t);
    const { env, db, ask } = store();
    const papers = recent(45);
    await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
    const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
    const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
    const notable = Array.from({ length: 8 }, (_, index) => `1901.${String(index).padStart(5, '0')}`);
    notable.forEach((id, index) => {
      const listed = new Date(Date.UTC(2024, 0, 1) - index * 3_600_000).toISOString();
      insertWork.run(10_000 + index, JSON.stringify({ id, title: `Notable paper ${index}`, authors: [] }), listed, '2099-01-01T00:00:00.000Z');
      insertLane.run('notable:cs.CL', 10_000 + index, listed);
    });
    const request = (page: number, seen: string[], extra: object = {}) => ({ categories: ['cs.CL'], page, pageSize: 15, seen: feedSeenFilter(seen), skipsSeen: true, notable: 3, ...extra });
    const split = (answer: Awaited<ReturnType<typeof ask>>) => ({ main: ids(answer.papers.filter(item => !item._notable)), cards: ids(answer.papers.filter(item => item._notable)) });
    const first = split(await ask(request(0, [])));
    assert.deepEqual(first, { main: ids(papers.slice(0, 15)), cards: notable.slice(0, 3) });
    // The app marks a page's papers and its first card seen.
    let sent = request(1, [...first.main, notable[0]]);
    if (rankedDropped) {
      // The second page reads the ids of cards 1 to 3 onto the kept order.
      await ask(sent);
      for (const item of papers.slice(0, 30)) removeWork(db, item.id);
      sent = request(0, [...ids(papers.slice(0, 15)), ...ids(papers.slice(30)), notable[0], notable[1]], { continues: true });
    }
    // Works 1 to 4 of the lane.
    db.exec('DELETE FROM work_lanes WHERE work_id BETWEEN 10001 AND 10004; DELETE FROM works WHERE id BETWEEN 10001 AND 10004;');
    const expected = { main: ids(rankedDropped ? papers.slice(30) : papers.slice(15, 30)), cards: notable.slice(5, 8) };
    assert.deepEqual(split(await ask(sent)), expected);
    assert.deepEqual(split(await ask(sent, 'reader-2')), expected, 'as without the kept order');
  });
}

// A walk past 600 seen papers leaves the ids of the first 1,400 ranks on the
// kept order; the corpus then drops the 400 works after the ones it sent (an
// eviction, or folds, within the order's two hours), and the next walk lands
// on them, whatever the page size.
for (const pageSize of [1, 15, 30]) {
  test(`a page of ${pageSize} past 400 works the corpus dropped behind the kept order costs a few reads, whatever its size`, async t => {
    rankingCaches(t);
    const { env, db, ask } = store();
    const papers = recent(1_100);
    await ingestPapers(env, papers.map(item => ({ paper: item, lanes: [] })));
    const request = (page: number, seen: string[]) => ({ categories: ['cs.CL'], page, pageSize, seen: feedSeenFilter(seen), skipsSeen: true });
    await ask(request(0, []));
    const sent = ids((await ask(request(1, ids(papers.slice(0, 600))))).papers);
    assert.deepEqual(sent, ids(papers.slice(600, 600 + pageSize)));
    for (const item of papers.slice(600 + pageSize, 1_000 + pageSize)) removeWork(db, item.id);
    const binding = env.PAPER_STORE as D1Database;
    const prepare = binding.prepare.bind(binding);
    const statements: string[] = [];
    t.mock.method(binding, 'prepare', (sql: string) => {
      statements.push(sql);
      return prepare(sql);
    });
    const answer = await ask(request(2, ids(papers.slice(0, 600 + pageSize))));
    assert.deepEqual(ids(answer.papers), ids(papers.slice(1_000 + pageSize, 1_000 + 2 * pageSize)));
    const workReads = statements.filter(sql => sql.startsWith('SELECT w.id, w.paper, w.kept_until')).length;
    assert.ok(workReads <= 2 && statements.length <= 6, `${statements.length} statements, ${workReads} of them reads of works`);
  });
}

// ─── A long session (ENG-103) ───

// The reader's ten categories, as many as the app asks for (MAIN_CATEGORIES).
const SESSION_CATEGORIES = ['cs.AI', 'cs.CL', 'cs.CV', 'cs.LG', 'cs.RO', 'cs.IR', 'cs.NE', 'cs.CR', 'cs.DB', 'cs.HC'];
const SESSION_RANKS = 3_000;
const rankedPaper = (rank: number) => `2610.${String(rank).padStart(5, '0')}`;
const notablePaper = (rank: number) => `1901.${String(rank).padStart(5, '0')}`;
// A category the reader follows during the session (FeedContext adds a
// followed topic's categories to the main request).
const FOLLOWED_TOPIC = 'cs.PL';
const topicPaper = (rank: number) => `2612.${String(rank).padStart(5, '0')}`;
const isTopicPaper = (paperId: string) => paperId.startsWith('2612.');
// A session runs at this instant, the day its clock was pinned. The notable
// cards a day's read offers (`daySlice`) and the year they end at move with
// the date, and so do the ids the filter holds and its false positives over
// the ranking: on the real clock the pass-over rate changed from one day to
// the next (1.30% on 2026-10-30, 0.99% the day before). The rate follows the
// ids the filter hashes, not the walk: at this instant, with the 14 other
// cards of each load spelled 40 other ways, the 90-load session's worst rate
// ranged from 0.59% to 1.64% (mean 1.03%) with main's newest-first notable
// order, and from 0.33% to 1.64% (mean 0.96%) with the years in turns, above
// 1.2% for 8 of the 40 spellings with either (ENG-166).
const SESSION_START = Date.parse('2026-10-29T12:00:00Z');
// The last year a notable lane reads (readNotableCandidates): the session's
// notable papers are older, and the ones the harvest files are of this year.
const lastNotableYear = new Date(SESSION_START).getUTCFullYear() - 1;
// On another device: 1,200 notable cards, then 500 papers, every other one at
// the top of each order.
const viewedRanks = (count: number) => Array.from({ length: count }, (_, index) => 2 * index);

/**
 * A reader with a full history reads `loads` pages, as the review of ENG-103
 * modelled it. The corpus holds 300 recent and 300 notable papers in each of
 * their categories, which they rank newest first (they like nothing yet). The
 * notable ones are ten days apart over the years before `lastNotableYear`,
 * about 36 a year, of which a day's read takes 25. The app passes over a
 * paper it has seen (FeedContext.loadPapers), shows the rest of the corpus's
 * page, places two of its unseen notable cards, and adds 14 cards of the
 * follows and exploration. `request` changes a load's request, and
 * `minutesPerLoad` moves the clock after each load, `pause` before one. With
 * `filing`, the harvest files two recent papers and a notable one after each
 * load, newer than any before: a ranking made after that puts the recent ones
 * first, and the notable one in its year's turns, one notable card in ten
 * without likes (ENG-166).
 * The corpus also holds 300 papers of FOLLOWED_TOPIC, which the reader does
 * not ask for: they are ten minutes apart, so the newest 150 are newer than
 * the papers a walk reaches after 100 loads.
 */
async function longSession(t: TestContext, loads: number, { minutesPerLoad = 0, pause, filing = false, request }: {
  minutesPerLoad?: number; pause?: { load: number; minutes: number }; filing?: boolean; request?: (load: number) => object;
} = {}) {
  rankingCaches(t);
  t.mock.timers.enable({ apis: ['Date'], now: SESSION_START });
  const { env, db, ask } = store();
  // The loads come seconds apart, past the ceiling of a reader's pages a minute.
  Object.assign(env, { PROVIDER_USER_MINUTE_LIMIT: '1000' });
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (let rank = 0; rank < SESSION_RANKS; rank += 1) {
    const category = SESSION_CATEGORIES[rank % SESSION_CATEGORIES.length];
    const published = new Date(Date.now() - (rank + 1) * 60_000).toISOString();
    insertWork.run(rank + 1, JSON.stringify({ id: rankedPaper(rank), arxivId: rankedPaper(rank), title: `Paper ${rank}`, authors: [] }), published, '2099-01-01T00:00:00.000Z');
    insertLane.run(category, rank + 1, published);
    const listed = new Date(Date.UTC(lastNotableYear - 1, 11, 31) - rank * DAY_MS).toISOString();
    insertWork.run(SESSION_RANKS + rank + 1, JSON.stringify({ id: notablePaper(rank), title: `Notable paper ${rank}`, authors: [] }), listed, '2099-01-01T00:00:00.000Z');
    insertLane.run(`notable:${category}`, SESSION_RANKS + rank + 1, listed);
  }
  for (let rank = 0; rank < 300; rank += 1) {
    const published = new Date(Date.now() - (10 * rank + 5) * 60_000).toISOString();
    insertWork.run(2 * SESSION_RANKS + rank + 1, JSON.stringify({ id: topicPaper(rank), title: `Topic paper ${rank}`, authors: [] }), published, '2099-01-01T00:00:00.000Z');
    insertLane.run(FOLLOWED_TOPIC, 2 * SESSION_RANKS + rank + 1, published);
  }
  db.exec('COMMIT');

  const uid = 'heavy-reader';
  // The session's seen papers, oldest first, as the app starts them from the
  // account's views (addViewedPapers): the notable cards, then the papers.
  const seen = new Set([...viewedRanks(1_200).map(notablePaper), ...viewedRanks(500).map(rankedPaper)]);
  // The app moves a paper it passes over to the newest end (markSeenLatest).
  const passOver = (paperId: string) => { seen.delete(paperId); seen.add(paperId); };

  const session: Array<{ main: string[]; shown: string[]; placed: string[]; filed: string[] }> = [];
  let otherCards = 0;
  let workId = 3 * SESSION_RANKS;
  const file = (paperId: string, lane: string, published: string) => {
    workId += 1;
    insertWork.run(workId, JSON.stringify({ id: paperId, title: `Paper ${paperId}`, authors: [] }), published, '2099-01-01T00:00:00.000Z');
    insertLane.run(lane, workId, published);
    return paperId;
  };
  for (let load = 0; load < loads; load += 1) {
    if (pause?.load === load) t.mock.timers.tick(pause.minutes * 60_000);
    const { papers } = await ask({ categories: SESSION_CATEGORIES, page: load, pageSize: 15, seen: feedSeenFilter(feedSeenIds(seen, true)), skipsSeen: true, notable: 5, ...request?.(load) }, uid);
    const known = papers.filter(item => seen.has(item.id));
    known.forEach(item => passOver(item.id));
    const shown = papers.filter(item => !item._notable && !known.includes(item));
    const placed = papers.filter(item => item._notable && !known.includes(item)).slice(0, 2);
    [...shown, ...placed].forEach(item => seen.add(item.id));
    for (let card = 0; card < 14; card += 1) seen.add(`other-${otherCards++}`);
    const category = SESSION_CATEGORIES[load % SESSION_CATEGORIES.length];
    const filed = filing ? [
      file(`2611.${String(2 * load).padStart(5, '0')}`, category, new Date().toISOString()),
      file(`2611.${String(2 * load + 1).padStart(5, '0')}`, category, new Date().toISOString()),
      file(`1902.${String(load).padStart(5, '0')}`, `notable:${category}`, new Date(Date.UTC(lastNotableYear, 5, 1) + load * 3_600_000).toISOString()),
    ] : [];
    session.push({ main: ids(papers.filter(item => !item._notable)), shown: ids(shown), placed: ids(placed), filed });
    if (minutesPerLoad) t.mock.timers.tick(minutesPerLoad * 60_000);
  }
  return session;
}

// What a session got: 15 papers of the ranking each load and two notable
// cards, no paper of the ranking twice, so none the walks passed over came
// back, and the papers filed before its last 20 loads, which a ranking after
// their filing puts right after the ones passed over. A notable one comes in
// its year's turns, its lane's newest first (ENG-166): it may still wait
// behind a newer one its lane filed later, which came, up to a fifth of them.
// A false positive of the
// filter passes over one of those too (2611.00052 here, from the first load).
function assertSupplied(session: Awaited<ReturnType<typeof longSession>>) {
  const short = session.flatMap(({ shown, placed }, load) => (shown.length < 15 || placed.length < 2 ? [`load ${load}: ${shown.length} papers, ${placed.length} notable`] : []));
  assert.deepEqual(short, [], 'loads short of 15 new papers of the ranking or 2 notable cards');
  const returned = session.flatMap(load => load.main);
  const viewedBefore = new Set(viewedRanks(500).map(rankedPaper));
  assert.deepEqual(returned.filter((id, index) => viewedBefore.has(id) || returned.indexOf(id) !== index), [], 'no paper the reader had seen comes back');
  const got = new Set(session.flatMap(load => [...load.shown, ...load.placed]));
  const filed = session.slice(0, -20).flatMap(load => load.filed);
  const newerOfLaneCame = (id: string) => {
    const load = session.findIndex(({ filed: ids }) => ids.includes(id));
    return id.startsWith('1902.') && session.some(({ filed: ids }, later) => later > load
      && later % SESSION_CATEGORIES.length === load % SESSION_CATEGORIES.length && ids.some(other => other.startsWith('1902.') && got.has(other)));
  };
  const missed = filed.filter(id => !got.has(id) && !newerOfLaneCame(id));
  assert.ok(missed.length <= 0.02 * filed.length, `${missed.length} of ${filed.length} papers filed during the session never came: ${missed.slice(0, 5)}`);
  // The session files a notable paper of the newest year each load, more than
  // that year's turns place, so some wait; a lane whose older papers of a year
  // never get a turn would leave many more.
  const notableFiled = filed.filter(id => id.startsWith('1902.'));
  const waiting = notableFiled.filter(id => !got.has(id) && newerOfLaneCame(id));
  assert.ok(waiting.length <= 0.2 * notableFiled.length, `${waiting.length} of ${notableFiled.length} notable papers filed during the session waited behind a newer one of their lane`);
}

// Every paper of the ranking before the last one the session got so far, and
// neither got nor viewed before, was passed over as seen: a false positive of
// the filter, which no later walk goes back to. After every load from the 20th
// (300 papers) on, they are about 1% of the unseen papers walked past.
function assertFewPassedOver(session: Awaited<ReturnType<typeof longSession>>) {
  const viewedBefore = new Set(viewedRanks(500).map(rankedPaper));
  const rates = session.slice(19).map((_, index) => {
    const got = new Set(session.slice(0, index + 20).flatMap(load => load.main).filter(id => !isTopicPaper(id)));
    const last = Math.max(...[...got].map(id => Number(id.slice(5))));
    const passed = Array.from({ length: last }, (_, rank) => rankedPaper(rank)).filter(id => !got.has(id) && !viewedBefore.has(id)).length;
    return passed / (passed + got.size);
  });
  const worst = Math.max(...rates);
  assert.ok(worst <= 0.012, `${(100 * worst).toFixed(2)}% of the unseen papers passed over after ${rates.indexOf(worst) + 20} loads`);
}

// On 52d08080 every page walked from the top of the ranking, and the app could
// not put back into the filter a paper that had left its 2,000 newest ids: the
// notable cards stopped after about 12 loads, the ranking after about 60.
test('a reader who viewed 1,200 notable cards and 500 papers before gets new papers and notable cards on each of 90 loads', async t => {
  const session = await longSession(t, 90);
  assertSupplied(session);
  assertFewPassedOver(session);
});

// After about 65 loads the filter no longer holds the session's first papers,
// so a walk from the top of the ranking would send them again, 15 a load, for
// as many loads as the session had (ENG-103). A walk's order lasts two hours
// from its last page; one ranked 15 minutes ago or more is ranked again after
// the ranks the walk passed.
for (const minutes of [20, 45, 90]) {
  test(`a reader back after ${minutes} minutes away from their 100th load gets new papers and notable cards on each of the next 40 loads`, async t => {
    const session = await longSession(t, 140, { pause: { load: 100, minutes } });
    assertSupplied(session);
    assertFewPassedOver(session);
  });
}

// A follow change keeps the reader's cards through the one they are on and
// asks for a first page again (FeedContext, `keepThroughVisible`), which goes
// on with the session's walk (`continues`): a topic follow adds its category
// to the main request, an author follow leaves it as it was.
const followAt = (load: number, extra: object = {}) => (at: number) => (at < load ? {} : { page: at - load, ...(at === load ? { continues: true } : {}), ...extra });

test('a topic followed after 100 loads brings its papers on the next load, and no paper the session was shown comes back', async t => {
  const session = await longSession(t, 140, { request: followAt(100, { categories: [...SESSION_CATEGORIES, FOLLOWED_TOPIC] }) });
  assertSupplied(session);
  assertFewPassedOver(session);
  // The topic's papers newer than where the walk was come right after the ranks it passed.
  assert.equal(session[100].shown.filter(isTopicPaper).length, 15);
});

test('an author followed after 100 loads leaves the walk of the main page where it was', async t => {
  const session = await longSession(t, 140, { request: followAt(100) });
  assertSupplied(session);
  assertFewPassedOver(session);
});

test('a ranking kept for 15 minutes is ranked again after the papers the session passed over, and none comes back', async t => {
  assertSupplied(await longSession(t, 90, { minutesPerLoad: 1, filing: true }));
});

// The app asks for the reader's first ten categories by their interests, and
// for older papers past a lean toward them, both of which a session changes.
test('a like, a new order or set of the reader\'s categories, or a lean toward older papers ranks again after the papers the session passed over', async t => {
  assertSupplied(await longSession(t, 90, {
    filing: true,
    request: load => {
      // A like every third load, of a paper the corpus does not hold.
      const positiveIds = Array.from({ length: Math.floor(load / 3) }, (_, index) => `liked-${index}`);
      const categories = [...SESSION_CATEGORIES.slice(load % 10), ...SESSION_CATEGORIES.slice(0, load % 10)];
      // An eleventh category takes the last one's place for five loads in twenty.
      if (load % 20 >= 15) categories[categories.indexOf('cs.HC')] = 'cs.SE';
      return { positiveIds, categories, order: load % 14 >= 7 ? 'relevance' : 'recent' };
    },
  }));
});

// Every bit set: every paper reads as seen, so each walk passes the whole
// ranking, and a ranking again after it keeps what the walk passed.
test('a filter that holds every paper, with another category on each page, does not grow the order kept for the reader', async t => {
  const entries = rankingCaches(t);
  t.mock.timers.enable({ apis: ['Date'], now: SESSION_START });
  const { db, ask } = store();
  const categories = Array.from({ length: 15 }, (_, index) => `zz.c${index}`);
  const insertWork = db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)');
  const insertLane = db.prepare('INSERT INTO work_lanes (lane, work_id, published) VALUES (?, ?, ?)');
  let workId = 0;
  const file = (paperId: string, lane: string, published: string) => {
    workId += 1;
    insertWork.run(workId, JSON.stringify({ id: paperId, title: `Paper ${paperId}`, authors: [] }), published, '2099-01-01T00:00:00.000Z');
    insertLane.run(lane, workId, published);
  };
  db.exec('BEGIN');
  categories.forEach((category, index) => {
    for (let rank = 0; rank < 1_000; rank += 1) file(`p${index}.${rank}`, category, new Date(Date.now() - (rank + 1) * 60_000).toISOString());
    // 30 in each of the ten years a notable lane reads, of which a day's read takes 25.
    for (let rank = 0; rank < 300; rank += 1) file(`n${index}.${rank}`, `notable:${category}`, new Date(Date.UTC(lastNotableYear - (rank % 10), 0, 1 + Math.floor(rank / 10))).toISOString());
  });
  db.exec('COMMIT');
  const everySeen = Buffer.alloc(2_400, 0xff).toString('base64');
  const kept: Array<{ ranks: number; notable: number }> = [];
  for (const [page, category] of categories.entries()) {
    await ask({ categories: [category], page, pageSize: 15, seen: everySeen, skipsSeen: true, notable: 5 });
    assert.equal(entries.size, 1, 'one order for the session, whatever its categories');
    const entry = await [...entries.values()][0].clone().json<{ ranks: unknown[]; notable: unknown[] }>();
    kept.push({ ranks: entry.ranks.length, notable: entry.notable.length });
  }
  assert.deepEqual(kept.at(-1), kept.at(-3), `the kept order stops growing: ${JSON.stringify(kept)}`);
});

const followedAuthor = { type: 'author', canonicalId: 'https://openalex.org/A77', displayName: 'Li Wei' };

test("a new follow's papers start on the next page, and no paper the first page showed comes back", async t => {
  rankingCaches(t);
  const { env, runs, ask } = store();
  await ingestPapers(env, [{ paper: paper('2610.20001', 'Newest in the category', 1), lanes: [] }, { paper: paper('2610.20002', 'Oldest in the category', 5), lanes: [] }]);
  const request = (page: number) => ({ categories: ['cs.CL'], follows: [followedAuthor], page, pageSize: 1 });
  assert.deepEqual(ids((await ask(request(0))).papers), ['2610.20001']);
  assert.equal(runs.length, 1, 'the follow is harvested at once');
  // What that harvest files for the author: newer than anything the first page had.
  await ingestPapers(env, [{ paper: paper('2610.20003', "The followed author's paper", 0.5), lanes: ['author:A77'] }]);
  const next = (await ask(request(1))).papers;
  assert.deepEqual(next.map(item => [item.id, item._followedEntityMatches?.map(match => (match as PaperFollowMatch).canonicalId)]), [['2610.20003', ['https://openalex.org/A77']]]);
  assert.deepEqual(ids((await ask(request(2))).papers), ['2610.20002']);
  assert.deepEqual((await ask(request(3))).papers, []);
});

test("a reader who just followed an author gets the author's newest papers from the next follows page on", async t => {
  rankingCaches(t);
  const { env, runs, ask } = store();
  // What the feed asks beside its main page (FeedContext's fetchFollowedEntityCandidates).
  const followsPage = (page: number) => ({ categories: [], follows: [followedAuthor], positiveIds: [], page, pageSize: 6, order: 'recent' });
  assert.deepEqual((await ask(followsPage(0))).papers, []);
  assert.equal(runs.length, 1);
  const filed = Array.from({ length: 8 }, (_, index) => `2610.4000${index + 1}`);
  await ingestPapers(env, filed.map((arxivId, index) => ({ paper: paper(arxivId, `Followed author paper ${index + 1}`, index + 1), lanes: ['author:A77'] })));
  assert.deepEqual(ids((await ask(followsPage(1))).papers), filed.slice(0, 6));
  assert.deepEqual(ids((await ask(followsPage(2))).papers), filed.slice(6));
});

test("a follow's papers reach the next page of every reader who asked for it before its first harvest finished", async t => {
  rankingCaches(t);
  const { env, db, runs, ask } = store();
  await ingestPapers(env, [
    { paper: paper('2610.50001', 'Category paper, 2 days', 2), lanes: [] },
    { paper: paper('2610.50003', 'Category paper, 3 days', 3), lanes: [] },
    { paper: paper('2610.50004', 'Category paper, 4 days', 4), lanes: [] },
  ]);
  const request = (page: number) => ({ categories: ['cs.CL'], follows: [followedAuthor], page, pageSize: 1 });
  assert.deepEqual(ids((await ask(request(0), 'reader-1')).papers), ['2610.50001']);
  assert.equal(runs.length, 1);
  // Another reader follows the same author while that harvest runs.
  assert.deepEqual(ids((await ask(request(0), 'reader-2')).papers), ['2610.50001']);
  assert.equal(runs.length, 1, 'one harvest for the lane');
  assert.deepEqual(ids((await ask(request(1), 'reader-1')).papers), ['2610.50003'], 'the harvest has filed nothing yet');
  // The harvest files the author's paper and records that it finished.
  await ingestPapers(env, [{ paper: paper('2610.50002', "The followed author's paper", 1), lanes: ['author:A77'] }]);
  db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', 'author:A77', ?)").run(new Date().toISOString());
  assert.deepEqual(ids((await ask(request(2), 'reader-1')).papers), ['2610.50002']);
  assert.deepEqual(ids((await ask(request(1), 'reader-2')).papers), ['2610.50002']);
  // With the harvest finished, the order is kept: a paper filed later waits for a first page.
  await ingestPapers(env, [{ paper: paper('2610.50005', 'Category paper filed later', 0.5), lanes: [] }]);
  assert.deepEqual(ids((await ask(request(2), 'reader-2')).papers), ['2610.50003']);
});

// Runs `work` once, right after the corpus's next batch of reads: a page's
// candidates, read in one batch.
function afterNextBatch(env: WorkerEnv, work: () => Promise<void>) {
  const binding = env.PAPER_STORE!;
  let pending = true;
  env.PAPER_STORE = {
    prepare: (sql: string) => binding.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      const results = await binding.batch(statements);
      if (pending) {
        pending = false;
        await work();
      }
      return results;
    },
  } as unknown as D1Database;
}

test("a follow's papers reach the next page when its first harvest ends while a page ranks", async t => {
  rankingCaches(t);
  const { env, db, runs, ask } = store();
  await ingestPapers(env, [
    { paper: paper('2610.70001', 'Category paper, 2 days', 2), lanes: [] },
    { paper: paper('2610.70002', 'Category paper, 3 days', 3), lanes: [] },
    { paper: paper('2610.70003', 'Category paper, 4 days', 4), lanes: [] },
  ]);
  const request = (page: number) => ({ categories: ['cs.CL'], follows: [followedAuthor], page, pageSize: 1 });
  assert.deepEqual(ids((await ask(request(0))).papers), ['2610.70001']);
  assert.equal(runs.length, 1);
  // The harvest files the author's paper and records that it finished right
  // after the next page has read its candidates.
  afterNextBatch(env, async () => {
    await ingestPapers(env, [{ paper: paper('2610.70009', "The followed author's paper", 0.5), lanes: ['author:A77'] }]);
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', 'author:A77', ?)").run(new Date().toISOString());
  });
  assert.deepEqual(ids((await ask(request(1))).papers), ['2610.70002'], 'ranked before the harvest filed anything');
  assert.deepEqual(ids((await ask(request(2))).papers), ['2610.70009']);
  assert.deepEqual(ids((await ask(request(3))).papers), ['2610.70003']);
});

test("a follow another reader adds, whose first harvest ends while a page ranks, reaches that page's next page", async t => {
  rankingCaches(t);
  const { env, db, runs, ask } = store();
  await ingestPapers(env, [
    { paper: paper('2610.71001', 'Category paper, 2 days', 2), lanes: [] },
    { paper: paper('2610.71002', 'Category paper, 3 days', 3), lanes: [] },
  ]);
  const request = (page: number) => ({ categories: ['cs.CL'], follows: [followedAuthor], page, pageSize: 1 });
  // Right after this reader's first page has read its candidates, another
  // reader's request adds the author to the harvest, and that first harvest
  // files the author's paper and records that it finished.
  afterNextBatch(env, async () => {
    db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A77', ?)").run(new Date().toISOString());
    await ingestPapers(env, [{ paper: paper('2610.71009', "The followed author's paper", 0.5), lanes: ['author:A77'] }]);
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', 'author:A77', ?)").run(new Date().toISOString());
  });
  assert.deepEqual(ids((await ask(request(0), 'reader-2')).papers), ['2610.71001'], 'ranked before the harvest filed anything');
  assert.equal(runs.length, 0, "the other reader's request started the harvest");
  assert.deepEqual(ids((await ask(request(1), 'reader-2')).papers), ['2610.71009']);
  assert.deepEqual(ids((await ask(request(2), 'reader-2')).papers), ['2610.71002']);
});

test("a page after one whose likes the lookup embedded goes on by them, and the next first page ranks by them", async t => {
  rankingCaches(t);
  const { env, db, ask } = store();
  Object.assign(env, { AI: embeddingModel() });
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'First liked paper', 10), lanes: [] },
    { paper: paper('2610.30002', 'Second liked paper', 11), lanes: [] },
    { paper: paper('2610.30003', 'Like the liked papers, older', 5), lanes: [] },
    { paper: paper('2610.30004', 'Unlike them, newest', 1), lanes: [] },
  ]);
  embed(db, '2610.30003', [1, 0]);
  embed(db, '2610.30004', [0, 1]);
  const request = (page: number) => ({ categories: ['cs.CL'], positiveIds: ['2610.30001', '2610.30002'], page, pageSize: 1 });
  assert.deepEqual(ids((await ask(request(0))).papers), ['2610.30004'], 'ranked before the likes had vectors');
  assert.deepEqual(ids((await ask(request(1))).papers), ['2610.30003']);
  assert.deepEqual((await ask(request(2))).papers, []);
  assert.deepEqual(ids((await ask(request(0))).papers), ['2610.30003']);
});

// A liked paper the corpus holds without a vector, beside one paper like it and
// a newer one unlike it. `embedded` counts the texts sent to Workers AI.
async function likedWithoutVector() {
  const { env, db, ask } = store();
  const embedded: string[] = [];
  const model = embeddingModel();
  Object.assign(env, { AI: { run: async (name: string, input: { text: string[] }) => { embedded.push(...input.text); return model.run(name, input); } } });
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'The paper just liked', 10), lanes: [] },
    { paper: paper('2610.30003', 'Like it, older', 5), lanes: [] },
    { paper: paper('2610.30004', 'Unlike it, newest', 1), lanes: [] },
  ]);
  embed(db, '2610.30003', [1, 0]);
  embed(db, '2610.30004', [0, 1]);
  return { ask, embedded };
}

test('More like this ranks by the paper just liked, even before the corpus had its vector', async () => {
  const { ask } = await likedWithoutVector();
  // What the feed asks when a paper is liked (FeedContext's traverseAndExpandNetwork).
  const { papers } = await ask({ categories: ['cs.CL'], positiveIds: ['2610.30001'], page: 0, pageSize: 1, waitForLikes: true });
  assert.deepEqual(papers.map(item => item.id), ['2610.30003']);
});

test('More like this answers before the app gives up when the embedding is slow, and the lookup finishes after the answer', async () => {
  const { env, db, ask } = store();
  let embeddedAt = 0;
  const model = embeddingModel();
  Object.assign(env, { AI: { run: async (name: string, input: { text: string[] }) => {
    await new Promise(resolve => setTimeout(resolve, 4_000));
    embeddedAt = Date.now();
    return model.run(name, input);
  } } });
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'The paper just liked', 10), lanes: [] },
    { paper: paper('2610.30003', 'Like it, older', 5), lanes: [] },
    { paper: paper('2610.30004', 'Unlike it, newest', 1), lanes: [] },
  ]);
  embed(db, '2610.30003', [1, 0]);
  embed(db, '2610.30004', [0, 1]);
  // As in production (ctx.waitUntil), the answer does not wait for the work handed to `later`.
  const after: Array<Promise<unknown>> = [];
  const started = Date.now();
  const { papers } = await ask({ categories: ['cs.CL'], positiveIds: ['2610.30001'], page: 0, pageSize: 1, waitForLikes: true }, 'reader-1', work => { after.push(work); });
  const elapsed = Date.now() - started;
  assert.equal(embeddedAt, 0, 'answered before Workers AI did');
  // The app's STORE_TIMEOUT_MS.
  assert.ok(elapsed < 3_500, `answered after ${elapsed} ms`);
  assert.deepEqual(ids(papers), ['2610.30004'], 'newest first: the like has no vector yet');
  await Promise.all(after);
  assert.ok(embeddedAt > 0, 'the lookup went on after the answer');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_vectors v JOIN work_keys k ON k.work_id = v.work_id WHERE k.key = 'arxiv:2610.30001'").get()?.n, 1);
});

// A reader's only like is still one like: their first page is the feed's first
// paint, and a lookup can take seconds (arXiv's pace).
test("a reader's first page with a single like answers without waiting for the lookup, which runs after it", async () => {
  const { ask, embedded } = await likedWithoutVector();
  const after: Array<Promise<unknown>> = [];
  const { papers } = await ask({ categories: ['cs.CL'], positiveIds: ['2610.30001'], page: 0, pageSize: 1 }, 'reader-1', work => { after.push(work); });
  assert.deepEqual(papers.map(item => item.id), ['2610.30004'], 'newest first: the like has no vector yet');
  assert.deepEqual(embedded, [], 'nothing embedded before the answer');
  await Promise.all(after);
  assert.equal(embedded.length, 1, 'the lookup embeds the like after it');
});
