import assert from 'node:assert/strict';
import test from 'node:test';

import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
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

test("a reader's new follows join the harvest at once, up to a daily allowance, and no reader is recorded with them", async () => {
  const { db, runs, ask } = store();
  const follows = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({
    type: 'topic', canonicalId: `query-${from + index}`, displayName: `Search ${from + index}`, metadata: { query: `search ${from + index}` },
  }));
  await ask({ follows: follows(0, 20) });
  assert.equal(runs.length, 1);
  assert.equal((runs[0] as { params: { lanes: string[] } }).params.lanes.length, 20);
  // The same reader's 21st new follow of the day is served from what the corpus has, not harvested.
  await ask({ follows: follows(20, 1) });
  assert.equal(runs.length, 1);
  // Another reader's is.
  await ask({ follows: follows(20, 1) }, 'reader-2');
  assert.equal(runs.length, 2);
  const lanes = db.prepare('SELECT * FROM followed_lanes').all() as Array<Record<string, unknown>>;
  assert.equal(lanes.length, 21);
  assert.deepEqual(Object.keys(lanes[0]).sort(), ['lane', 'requested_at']);
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
