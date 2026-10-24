import type { PaperFollowMatch } from '../src/models/Paper.ts';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerEnv } from './env.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers, quantize } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { feedSeenFilter } from '../src/utils/seenPaperFilter.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';

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

test('a reader who follows a hundred and twenty entities still gets their follows with the filter', async t => {
  rankingCaches(t);
  const { env, ask } = store();
  await ingestPapers(env, [{ paper: paper('2610.70001', "A followed author's paper", 1), lanes: ['author:A5000000000'] }]);
  // As the app sends its follows' page (fetchCorpusPage): every follow as it
  // is stored, its likes and what the reader has seen.
  const follows = Array.from({ length: 120 }, (_, index) => ({
    type: 'author', canonicalId: `https://openalex.org/A${5_000_000_000 + index}`, displayName: `Followed author number ${index}`, metadata: {},
  }));
  const positiveIds = Array.from({ length: 24 }, (_, index) => `openalex:W${7_000_000_000 + index}`);
  const seen = feedSeenFilter(Array.from({ length: 2_000 }, (_, index) => `2610.${String(index).padStart(5, '0')}`));
  const body = { categories: [], follows, positiveIds, page: 0, pageSize: 6, order: 'recent', seen, skipsSeen: true };
  assert.ok(JSON.stringify(body).length > 16_384, 'the request is longer than the 16 KB the route took before the filter');
  assert.deepEqual(ids((await ask(body)).papers), ['2610.70001']);
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
