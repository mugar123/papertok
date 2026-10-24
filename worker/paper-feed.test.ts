import type { PaperFollowMatch } from '../src/models/paper.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers, quantize } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_PACE_PERIOD_MS, ARXIV_UPSTREAM_TIMEOUT_MS, handleArxiv } from './arxiv-api.ts';
import { handleRequest } from './router.ts';
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
  const searches = ['all:attention', 'all:sparsity'].map(query => handleArxiv(new Request(`https://papertok.internal/arxiv?search_query=${encodeURIComponent(query)}`), env, null));
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
function rankingCaches(t: TestContext) {
  const entries = new Map<string, Response>();
  const realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: {
    match: async (request: Request) => entries.get(request.url)?.clone() ?? undefined,
    put: async (request: Request, response: Response) => { entries.set(request.url, response); },
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
