import assert from 'node:assert/strict';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { ARXIV_PACE_MAX_WAIT_MS, ARXIV_PACE_PERIOD_MS, ARXIV_UPSTREAM_TIMEOUT_MS, handleArxiv } from './arxiv-api.ts';
import { handleRequest } from './router.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.ts';

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
  const ask = (body: unknown, uid = 'reader-1') => handleCorpusFeed(new Request('https://papertok.internal/store/papers', { method: 'POST', body: JSON.stringify(body) }), env, { uid });
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
  assert.deepEqual(Object.keys(lanes[0]).sort(), ['lane', 'requested_at']);
});

test('a reader adds at most 40 new followed lanes a day; past them a new follow is served from what the corpus has and is not registered', async () => {
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
  }) as typeof fetch;
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
  }) as typeof fetch;
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
  }) as typeof fetch;
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
  // Two readers' arXiv searches take this period's seat and the next one:
  // the first goes to arXiv, the second waits for its seat.
  const searches = ['all:attention', 'all:sparsity'].map(query => handleArxiv(new Request(`https://papertok.internal/arxiv?search_query=${encodeURIComponent(query)}`), env));
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

test("a reader's ranking is kept for their next pages under their own key, never another reader's", async t => {
  const entries = new Map<string, Response>();
  const realCaches = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: {
    match: async (request: Request) => entries.get(request.url)?.clone() ?? undefined,
    put: async (request: Request, response: Response) => { entries.set(request.url, response); },
  } };
  t.after(() => { (globalThis as { caches?: unknown }).caches = realCaches; });
  const { env, ask } = store();
  await ingestPapers(env, [{ paper: stored, lanes: [] }]);
  await ask({ categories: ['cs.CL'] }, 'reader-1');
  assert.equal(entries.size, 1);
  await ask({ categories: ['cs.CL'], page: 1 }, 'reader-1');
  assert.equal(entries.size, 1, 'the next page reads the order the first one kept');
  await ask({ categories: ['cs.CL'], page: 1 }, 'reader-2');
  assert.equal(entries.size, 2, "another reader's identical request ranks for them");
});
