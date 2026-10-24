import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { carryArxivVectors, runPaperHarvest } from './paper-harvest.ts';
import { handleCorpusFeed } from './paper-feed.ts';
import { ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { testD1 } from './test-support/sqliteD1.ts';
import { inMemoryQuotaLedger } from './test-support/quotaLedger.ts';

// The Workflow's steps run in place: a step's callback is called once, a sleep
// is recorded and returns at once. `fail` names the steps that fail past their
// retries; `skipLanes` answers the category lanes' steps as if every lane were
// done, for a daily run whose lanes the test does not exercise. An attempt
// running past `timeoutMs` is stopped, as a Workflow stops one past its
// timeout and leaves its work unfinished, and the step is tried again within
// its retries.
function workflowStep({ fail = () => false, skipLanes = false, timeoutMs = 0 }: { fail?: (name: string) => boolean; skipLanes?: boolean; timeoutMs?: number } = {}) {
  const steps: string[] = [];
  const sleeps: Array<number | string> = [];
  const step = {
    async do(name: string, ...rest: unknown[]) {
      steps.push(name);
      if (fail(name)) throw new Error(`${name} failed past its retries`);
      if (skipLanes && /^categories: lanes \d+$/.test(name)) return Number.MAX_SAFE_INTEGER;
      const callback = rest.at(-1) as () => Promise<unknown>;
      if (!timeoutMs) return callback();
      const retries = rest.length > 1 ? (rest[0] as { retries?: { limit: number } }).retries?.limit ?? 0 : 0;
      for (let attempt = 0; ; attempt += 1) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<'timed out'>(resolve => { timer = setTimeout(resolve, timeoutMs, 'timed out'); });
        const result = await Promise.race([callback(), timedOut]).finally(() => clearTimeout(timer));
        if (result !== 'timed out') return result;
        if (attempt >= retries) throw new Error(`${name} timed out past its retries`);
      }
    },
    async sleep(_name: string, duration: number | string) {
      sleeps.push(duration);
    },
  };
  return { step: step as unknown as WorkflowStep, steps, sleeps };
}

const followRun = (lanes: string[]) => ({ payload: { lanes }, timestamp: new Date(), instanceId: 'follow-test' }) as unknown as WorkflowEvent<{ lanes?: string[] }>;
const dailyRun = () => ({ payload: undefined, timestamp: new Date(), instanceId: 'daily-test' }) as unknown as WorkflowEvent<undefined>;

// The providers: `answer` when it has a response for the URL, otherwise an
// empty OpenAlex list (through the Worker's relay).
function providers(t: import('node:test').TestContext, answer: (url: URL) => Response | Promise<Response> | undefined = () => undefined) {
  const asked: URL[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url);
    return answer(url) ?? Response.json({ results: [] });
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  return asked;
}

function corpus() {
  const { binding, db } = testD1();
  const texts: string[] = [];
  const env = {
    PAPER_STORE: binding,
    REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
    OPENALEX_API_KEY: 'test-key',
    AI: {
      run: async (_model: string, { text }: { text: string[] }) => {
        texts.push(...text);
        return { data: text.map(() => Array.from({ length: 1024 }, (_, dimension) => Math.cos(dimension))) };
      },
    },
  } as unknown as WorkerEnv;
  return { env, db, texts };
}

// Synthetic, in the shape the arXiv harvest stores.
const paper = (id: string, title: string) => arxivRecordPaper({
  arxivId: id, title, abstract: `${title}, in short.`, authors: ['Ana Pérez'], categories: [], doi: null, journalRef: null, comments: null,
  published: new Date(Date.now() - 86_400_000).toISOString(), updated: '',
});

test("a followed lanes' run embeds its own lanes' papers and leaves the rest to the daily run", async t => {
  providers(t);
  const { env, db, texts } = corpus();
  await ingestPapers(env, [
    { paper: paper('2610.30001', 'A paper by the followed author'), lanes: ['author:A1'] },
    { paper: paper('2610.30002', 'Another paper by the followed author'), lanes: ['author:A1', 'cs.LG'] },
    { paper: paper('2610.30003', 'A machine learning paper nobody followed'), lanes: ['cs.LG'] },
    { paper: paper('2610.30004', 'A paper of an author someone else follows'), lanes: ['author:A2'] },
  ]);
  const { step } = workflowStep();
  await runPaperHarvest(env, followRun(['author:A1']), step);
  assert.deepEqual(texts.map(text => text.split('\n')[0]).sort(), ['A paper by the followed author', 'Another paper by the followed author']);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_vectors').get() as { n: number }).n, 2);
});

test("runs for new follows stop at 300 of the followed lanes' OpenAlex units, and the nightly refresh still has its 700", async t => {
  const asked = providers(t);
  const { env, db } = corpus();
  // The relay's own ceilings, out of the way: the harvest's shares are under test.
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const searches = () => asked.filter(url => url.hostname === 'api.openalex.org' && url.searchParams.has('search')).length;
  // A followed search is ten units, and an empty answer ends its lane after one.
  const lanes = Array.from({ length: 80 }, (_, index) => `query:search ${index}`);
  for (let run = 0; run < 4; run += 1) {
    await runPaperHarvest(env, followRun(lanes.slice(run * 10, run * 10 + 10)), workflowStep().step);
  }
  assert.equal(searches(), 30);
  // Every lane asked for since, refreshed by the nightly run on the same day.
  const now = new Date().toISOString();
  db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) SELECT value, ?, ? FROM json_each(?)').run(now, now, JSON.stringify(lanes));
  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
  assert.equal(searches() - 30, 70);
});

// The nightly refresh's 700 units do not reach every followed lane on a busy
// night. An account that asks for its own followed searches again just before
// the run must not take them every night from the lanes other readers follow.
test('the nightly refresh starts with the followed lanes due longest ago, however recently another lane was asked for', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T02:30:00Z') });
  providers(t);
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  // One account's 70 searches, ten units each: harvested last night, asked again a minute ago.
  const searches = Array.from({ length: 70 }, (_, index) => `query:search ${index}`);
  // Other readers' authors, one unit each, asked yesterday: five followed
  // before last night's run, which did not reach them, five harvested two nights ago.
  const authors = Array.from({ length: 10 }, (_, index) => `author:A${index + 1}`);
  const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
  const harvested = db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', ?, ?)");
  for (const lane of searches) {
    follow.run(lane, '2026-10-23T02:29:00.000Z', '2026-10-20T12:00:00.000Z');
    harvested.run(lane, '2026-10-22T02:40:00.000Z');
  }
  for (const lane of authors.slice(0, 5)) follow.run(lane, '2026-10-22T15:00:00.000Z', '2026-10-22T01:00:00.000Z');
  for (const lane of authors.slice(5)) {
    follow.run(lane, '2026-10-22T15:00:00.000Z', '2026-10-19T12:00:00.000Z');
    harvested.run(lane, '2026-10-21T02:40:00.000Z');
  }

  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
  const refreshed = db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-follows' AND harvested_through = '2026-10-23T02:30:00.000Z'")
    .all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(authors.filter(lane => !refreshed.includes(lane)), [], 'every author is refreshed');
  // The rest of the 700 units: 69 of the account's searches.
  assert.equal(refreshed.filter(lane => lane.startsWith('query:')).length, 69);
});

// Synthetic, in the shape the relay's `select` returns.
const openAlexWork = (index: number) => ({
  id: `https://openalex.org/W${9_000 + index}`,
  doi: `https://doi.org/10.1/w${9_000 + index}`,
  title: `A paper a broad search finds, number ${index}`,
  type: 'article',
  publication_date: '2026-10-15',
  publication_year: 2026,
  authorships: [{ author: { id: `https://openalex.org/A${9_000 + index}`, display_name: 'Ana Pérez' }, institutions: [] }],
  abstract_inverted_index: { A: [0], broad: [1], result: [2] },
  primary_location: { landing_page_url: null, is_published: true, version: 'publishedVersion', source: { id: 'https://openalex.org/S1', display_name: 'A journal', type: 'journal' } },
  locations: [],
  open_access: { is_oa: false, oa_url: null },
  cited_by_count: 0,
});

// A followed search's first harvest reads a second page when the first is
// full: 20 of the nightly refresh's 700 units, so one account's 40 new
// searches a day ask for 800. With no run for new follows (their 300 spent),
// all of them wait for the nightly refresh.
test("one account registering 40 broad followed searches a day does not keep another reader's lane from its nightly refresh", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T12:00:00Z') });
  const fullPage = Array.from({ length: 50 }, (_, index) => openAlexWork(index));
  providers(t, url => (url.hostname === 'api.openalex.org' && url.searchParams.get('search')?.startsWith('broad ')
    ? Response.json({ results: fullPage })
    : undefined));
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const follow = (uid: string, queries: string[]) => handleCorpusFeed(new Request('https://papertok.internal/store/papers', {
    method: 'POST',
    body: JSON.stringify({ follows: queries.map(query => ({ type: 'topic', canonicalId: `query-${query}`, displayName: query, metadata: { query } })) }),
  }), env, { uid });
  const refreshedTonight = async (night: string) => {
    t.mock.timers.setTime(Date.parse(`${night}T02:30:00Z`));
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    const row = db.prepare("SELECT harvested_through FROM lane_state WHERE source = 'openalex-follows' AND lane = 'query:a narrow topic'").get() as { harvested_through: string } | undefined;
    return row?.harvested_through === new Date().toISOString();
  };

  await follow('reader-b', ['a narrow topic']);
  assert.equal(await refreshedTonight('2026-10-20'), true);
  const refreshed: boolean[] = [];
  for (const [day, night] of ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].entries()) {
    t.mock.timers.setTime(Date.parse(`${night}T12:00:00Z`) - 86_400_000);
    const searches = Array.from({ length: 40 }, (_, index) => `broad ${day}-${index}`);
    await follow('reader-a', searches.slice(0, 20));
    await follow('reader-a', searches.slice(20));
    refreshed.push(await refreshedTonight(night));
  }
  // The searches registered since the lane's last refresh wait behind it.
  assert.ok(refreshed.every((done, night) => done || refreshed[night - 1]), `refreshed on nights ${refreshed.join(', ')}`);
});

// Every live lane due before another reader's waits ahead of it, and asking
// for a lane again keeps it followed for 14 more days. Were every search an
// account asks for again kept, one that follows 40 new searches a day and asks
// again for all of them daily would put 40 more lanes a day ahead of the other
// reader's, without end.
test("one account following 40 new searches a day and asking again daily for all of them still leaves another reader's lane refreshed at least once a week", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-19T12:00:00Z') });
  // Every search answers empty: ten units each, 70 of the nightly 700.
  providers(t);
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  // A minute apart, inside the route's requests a minute.
  let clock = Date.parse('2026-10-19T12:00:00Z');
  const follow = async (uid: string, queries: string[]) => {
    t.mock.timers.setTime(clock += 60_000);
    await handleCorpusFeed(new Request('https://papertok.internal/store/papers', {
      method: 'POST',
      body: JSON.stringify({ follows: queries.map(query => ({ type: 'topic', canonicalId: `query-${query}`, displayName: query, metadata: { query } })) }),
    }), env, { uid });
  };
  const narrowLane = () => (db.prepare("SELECT harvested_through FROM lane_state WHERE source = 'openalex-follows' AND lane = 'query:a narrow topic'")
    .get() as { harvested_through: string } | undefined)?.harvested_through;

  await follow('reader-b', ['a narrow topic']);
  t.mock.timers.setTime(Date.parse('2026-10-20T02:30:00Z'));
  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
  const followed: string[] = [];
  const refreshed: boolean[] = [];
  // 24 nights: were the account's searches all kept, the lane would go 7 nights in a row without a refresh by the 21st.
  for (let day = 0; day < 24; day += 1) {
    const night = Date.parse('2026-10-21T02:30:00Z') + day * 86_400_000;
    // From 03:30 the day before.
    clock = night - 23 * 3_600_000;
    const searches = Array.from({ length: 40 }, (_, index) => `broad ${day}-${index}`);
    const asked = [...searches, ...followed];
    // 20 follows a request, the most the route reads.
    for (let from = 0; from < asked.length; from += 20) await follow('reader-a', asked.slice(from, from + 20));
    followed.push(...searches);
    await follow('reader-b', ['a narrow topic']);
    const before = narrowLane();
    t.mock.timers.setTime(night);
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    refreshed.push(narrowLane() !== before);
  }
  const nightsWithout = refreshed.reduce((nights, done) => [...nights, done ? 0 : nights.at(-1)! + 1], [0]);
  assert.ok(Math.max(...nightsWithout) < 7, `refreshed on nights ${refreshed.map(done => (done ? 'Y' : '.')).join('')}`);
});

// The OpenAlex searches each night asks for, from the providers' requests.
const searchesAsked = (asked: URL[]) => asked.filter(url => url.hostname === 'api.openalex.org' && url.searchParams.has('search'))
  .map(url => url.searchParams.get('search')!);

// A search OpenAlex answers with a 400 spends its ten units each time it is
// asked and never records a harvest. 70 of them, followed before another
// reader's lane, took the whole 700 every night, and that lane got none of it.
test('followed lanes that fail every night take their turn and are asked less and less often, so a later lane is refreshed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  const asked = providers(t, url => (url.searchParams.get('search')?.startsWith('broken ')
    ? Response.json({ error: 'Invalid query' }, { status: 400 })
    : undefined));
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const broken = Array.from({ length: 70 }, (_, index) => `query:broken ${index}`);
  const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
  for (const lane of broken) {
    follow.run(lane, '2026-10-20T12:00:00.000Z', '2026-10-10T12:00:00.000Z');
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', ?, '2026-10-19T02:40:00.000Z')").run(lane);
  }
  follow.run('query:a narrow topic', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z');

  const nights = Array.from({ length: 22 }, (_, index) => index + 1);
  const narrowNights: number[] = [];
  const brokenNights = new Map(broken.map(lane => [lane.slice('query:'.length), [] as number[]]));
  for (const night of nights) {
    const at = Date.parse('2026-10-20T02:30:00Z') + night * 86_400_000;
    // Asked for again every day, so none leaves the harvest.
    db.prepare('UPDATE followed_lanes SET requested_at = ?').run(new Date(at - 3_600_000).toISOString());
    t.mock.timers.setTime(at);
    const before = asked.length;
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    for (const search of searchesAsked(asked.slice(before))) {
      if (search === 'a narrow topic') narrowNights.push(night);
      brokenNights.get(search)?.push(night);
    }
  }
  // The broken searches were due before it on the first night, never after.
  assert.deepEqual(narrowNights, nights.slice(1), `the narrow topic was asked on nights ${narrowNights.join(', ')}`);
  // In the last 7 of the 22 nights, each broken search is asked once.
  for (const [search, asks] of brokenNights) {
    assert.equal(asks.filter(night => night > 15).length, 1, `${search} was asked on nights ${asks.join(', ')}`);
  }
});

test('a followed lane the budget refuses keeps its turn: the next night it comes before the lanes due after it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T02:30:00Z') });
  const asked = providers(t);
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
  // 70 searches due before it spend the 700 the first night.
  for (let index = 0; index < 70; index += 1) follow.run(`query:search ${index}`, '2026-10-20T12:00:00.000Z', '2026-10-19T12:00:00.000Z');
  follow.run('query:followed first', '2026-10-20T12:00:00.000Z', '2026-10-20T10:00:00.000Z');
  follow.run('query:followed second', '2026-10-20T12:00:00.000Z', '2026-10-20T11:00:00.000Z');
  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
  assert.ok(!searchesAsked(asked).includes('followed first'), 'refused the first night');
  // The 72 lanes ask for 720 units: the two the 700 leave out are the ones harvested last night.
  t.mock.timers.setTime(Date.parse('2026-10-22T02:30:00Z'));
  const before = asked.length;
  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
  assert.deepEqual(searchesAsked(asked.slice(before)).slice(0, 2), ['followed first', 'followed second']);
});

// The quota ledger as the relay finds it when its Durable Object answers with
// an error or cannot be reached, while `failure` says so.
function failingLedger(ledger: WorkerEnv['REQUEST_QUOTA_LEDGER'], failure: () => 'error' | 'throw' | null) {
  return {
    idFromName: (name: string) => ledger!.idFromName(name),
    get: (id: Parameters<NonNullable<WorkerEnv['REQUEST_QUOTA_LEDGER']>['get']>[0]) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const mode = failure();
        if (mode === 'throw') throw new Error('the ledger cannot be reached');
        if (mode === 'error') return new Response('down', { status: 500 });
        return ledger!.get(id).fetch(url, init);
      },
    }),
  } as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'];
}

// With our own ledger down, no OpenAlex unit can be reserved and OpenAlex is
// asked nothing; a provider that is down fails every lane alike. Neither says
// anything about a lane.
test('outages cost no followed lane a wait: the first night after one refreshes every lane', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  const tooMany = () => new Response('Too many requests', { status: 429, headers: { 'retry-after': '3600' } });
  const followedHosts = ['api.openalex.org', 'export.arxiv.org', 'api.openaire.eu'];
  const providerOutages: Record<string, (url: URL) => Response | Promise<Response> | undefined> = {
    'OpenAlex answering 503': url => (url.hostname === 'api.openalex.org' ? new Response('Service unavailable', { status: 503 }) : undefined),
    // As fetchWithDeadline rejects once its deadline passes.
    'OpenAlex timing out': url => (url.hostname === 'api.openalex.org' ? Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')) : undefined),
    'OpenAlex, arXiv and OpenAIRE answering 429': url => (followedHosts.includes(url.hostname) ? tooMany() : undefined),
    // A key or a client the providers refuse is refused on every request alike.
    'OpenAlex, arXiv and OpenAIRE answering 401': url => (followedHosts.includes(url.hostname) ? new Response('Unauthorized', { status: 401 }) : undefined),
    'OpenAlex, arXiv and OpenAIRE answering 403': url => (followedHosts.includes(url.hostname) ? new Response('Forbidden', { status: 403 }) : undefined),
  };
  let outageNow: string | null = null;
  providers(t, url => (outageNow && providerOutages[outageNow] ? providerOutages[outageNow](url) : undefined)
    ?? (url.hostname === 'export.arxiv.org' ? new Response('<feed xmlns="http://www.w3.org/2005/Atom"></feed>') : undefined));
  const lanes = [
    ...Array.from({ length: 10 }, (_, index) => `query:search ${index}`),
    ...Array.from({ length: 10 }, (_, index) => `author:A${index + 1}`),
    'author-name:Ana Pérez',
    'project:NSF|2047484',
  ];
  const ledgerOutages = { 'the ledger answering with an error': 'error', 'the ledger unreachable': 'throw' } as const;
  for (const kind of [...Object.keys(ledgerOutages), ...Object.keys(providerOutages)]) {
    for (const outage of [1, 4]) {
      const { env, db } = corpus();
      Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
      const ledgerFailure = ledgerOutages[kind as keyof typeof ledgerOutages] ?? null;
      env.REQUEST_QUOTA_LEDGER = failingLedger(env.REQUEST_QUOTA_LEDGER, () => (outageNow ? ledgerFailure : null));
      const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
      for (const lane of lanes) follow.run(lane, '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z');
      const refreshed: number[] = [];
      for (let night = 1; night <= outage + 3; night += 1) {
        const at = Date.parse('2026-10-20T02:30:00Z') + night * 86_400_000;
        // Asked for again every day, so none leaves the harvest.
        db.prepare('UPDATE followed_lanes SET requested_at = ?').run(new Date(at - 3_600_000).toISOString());
        outageNow = night <= outage ? kind : null;
        t.mock.timers.setTime(at);
        await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
        refreshed.push((db.prepare('SELECT COUNT(*) AS n FROM lane_state WHERE harvested_through = ?').get(new Date(at).toISOString()) as { n: number }).n);
      }
      outageNow = null;
      assert.ok(refreshed.slice(0, outage).every(count => count < lanes.length), `${kind}: the outage nights refreshed ${refreshed.join(', ')}`);
      assert.deepEqual(refreshed.slice(outage), [lanes.length, lanes.length, lanes.length], `${kind} for ${outage} nights`);
    }
  }
});

// Past a ledger that cannot answer, OpenAlex is asked nothing and the lane is
// not the reason: it keeps the place it had in the rotation.
test('a followed lane harvested while the quota ledger cannot answer keeps its turn: the next night it comes before a lane due after it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T02:30:00Z') });
  const asked = providers(t);
  for (const failure of ['error', 'throw'] as const) {
    const { env, db } = corpus();
    Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
    let down = true;
    env.REQUEST_QUOTA_LEDGER = failingLedger(env.REQUEST_QUOTA_LEDGER, () => (down ? failure : null));
    const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
    follow.run('query:followed first', '2026-10-20T12:00:00.000Z', '2026-10-20T10:00:00.000Z');
    t.mock.timers.setTime(Date.parse('2026-10-21T02:30:00Z'));
    let before = asked.length;
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    assert.deepEqual(searchesAsked(asked.slice(before)), [], `${failure}: the outage night`);
    // Followed after that run and before the next day.
    follow.run('query:followed later', '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.000Z');
    down = false;
    t.mock.timers.setTime(Date.parse('2026-10-22T02:30:00Z'));
    before = asked.length;
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    assert.deepEqual(searchesAsked(asked.slice(before)), ['followed first', 'followed later'], `${failure}: the night after`);
  }
});

// OpenAlex failing one search after another every night looks, in one run,
// like OpenAlex being down. Each failure is still that lane's turn, so 70 of
// them, due before another reader's lane, do not keep it from its refresh.
test('followed lanes OpenAlex fails every night with a 500 take their turn without a longer wait, and a later lane is refreshed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  const asked = providers(t, url => (url.searchParams.get('search')?.startsWith('failing ')
    ? new Response('Internal server error', { status: 500 })
    : undefined));
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const failing = Array.from({ length: 70 }, (_, index) => `query:failing ${index}`);
  const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
  for (const lane of failing) {
    follow.run(lane, '2026-10-20T12:00:00.000Z', '2026-10-10T12:00:00.000Z');
    db.prepare("INSERT INTO lane_state (source, lane, harvested_through) VALUES ('openalex-follows', ?, '2026-10-19T02:40:00.000Z')").run(lane);
  }
  follow.run('query:a narrow topic', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z');

  const nights = Array.from({ length: 12 }, (_, index) => index + 1);
  const narrowNights: number[] = [];
  const failingNights = new Map(failing.map(lane => [lane.slice('query:'.length), [] as number[]]));
  for (const night of nights) {
    const at = Date.parse('2026-10-20T02:30:00Z') + night * 86_400_000;
    db.prepare('UPDATE followed_lanes SET requested_at = ?').run(new Date(at - 3_600_000).toISOString());
    t.mock.timers.setTime(at);
    const before = asked.length;
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    for (const search of searchesAsked(asked.slice(before))) {
      if (search === 'a narrow topic') narrowNights.push(night);
      failingNights.get(search)?.push(night);
    }
  }
  assert.deepEqual(narrowNights, nights.slice(1), `the narrow topic was asked on nights ${narrowNights.join(', ')}`);
  // No wait builds up: a failing search the 700 left out one night comes first the next.
  for (const [search, asks] of failingNights) {
    assert.ok(asks.every((night, index) => index === 0 || night - asks[index - 1] <= 2) && asks.at(-1)! >= nights.length - 1, `${search} was asked on nights ${asks.join(', ')}`);
  }
});

test('a followed lane harvested after rejected nights is asked again the night after its next rejection', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T12:00:00Z') });
  let failing = true;
  const asked = providers(t, url => (failing && url.searchParams.get('search') === 'a flaky search'
    ? Response.json({ error: 'Invalid query' }, { status: 400 })
    : undefined));
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)')
    .run('query:a flaky search', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z');
  const askedOn: number[] = [];
  let harvestedOn = 0;
  for (let night = 1; night <= 16; night += 1) {
    const at = Date.parse('2026-10-20T02:30:00Z') + night * 86_400_000;
    db.prepare('UPDATE followed_lanes SET requested_at = ?').run(new Date(at - 3_600_000).toISOString());
    // OpenAlex answers it again from the fifth night, until it is harvested once.
    if (night === 5) failing = false;
    t.mock.timers.setTime(at);
    const before = asked.length;
    await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true }).step);
    if (searchesAsked(asked.slice(before)).length === 0) continue;
    askedOn.push(night);
    if (!failing && !harvestedOn) {
      harvestedOn = night;
      failing = true;
    }
  }
  // Its rejections had spaced its asks out; after the harvest, one rejection costs it one night again.
  const spaced = askedOn.filter(night => night <= harvestedOn);
  assert.ok(harvestedOn > 5 && spaced.some((night, index) => night - spaced[index - 1] > 2), `asked on nights ${askedOn.join(', ')}`);
  assert.deepEqual(askedOn.filter(night => night > harvestedOn).slice(0, 2), [harvestedOn + 1, harvestedOn + 2], `asked on nights ${askedOn.join(', ')}`);
});

// A lane that holds its step past the timeout never reaches the harvest's own
// error handling.
test("a followed lane that stops its step has had its turn: the step's retry harvests the lanes after it", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T02:30:00Z') });
  const asked = providers(t, url => (url.searchParams.get('search') === 'a search that hangs' ? new Promise<Response>(() => {}) : undefined));
  const { env, db } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_MINUTE_LIMIT: '100000', OPENALEX_GLOBAL_DAILY_LIMIT: '100000' });
  const follow = db.prepare('INSERT INTO followed_lanes (lane, requested_at, registered_at) VALUES (?, ?, ?)');
  follow.run('query:a search that hangs', '2026-10-20T12:00:00.000Z', '2026-10-20T10:00:00.000Z');
  const authors = ['author:A1', 'author:A2', 'author:A3', 'author:A4'];
  for (const lane of authors) follow.run(lane, '2026-10-20T12:00:00.000Z', '2026-10-20T11:00:00.000Z');
  // Its steps' work takes milliseconds: 3 s is a step that stopped.
  await runPaperHarvest(env, dailyRun(), workflowStep({ skipLanes: true, timeoutMs: 3_000 }).step);
  const refreshed = db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-follows' ORDER BY lane").all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(refreshed, authors);
  assert.deepEqual(searchesAsked(asked), ['a search that hangs']);
});

test('a lane step that fails past its retries passes over its lanes, not the rest of the run', async t => {
  providers(t);
  const { env, db } = corpus();
  const lanes = Array.from({ length: 7 }, (_, index) => `author:A${index + 1}`);
  // The first step, five lanes, times out every time.
  const { step, steps } = workflowStep({ fail: name => name === 'followed: lanes 0' });
  await runPaperHarvest(env, followRun(lanes), step);
  const harvested = db.prepare("SELECT lane FROM lane_state WHERE source = 'openalex-follows' ORDER BY lane").all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(harvested, ['author:A6', 'author:A7']);
  assert.ok(steps.includes('embed 0'), 'the run goes on to embed');
});

test("arXiv's 503 is waited out as asked, but a long pause or one 503 after another ends the set, not the run", async t => {
  let retryAfter = '';
  providers(t, url => (url.hostname === 'oaipmh.arxiv.org'
    ? new Response('Retry later', { status: 503, headers: { 'retry-after': retryAfter } })
    : undefined));
  for (retryAfter of ['86400', '30']) {
    const { env } = corpus();
    // Ten requests of one set is a run that would never end.
    const { step, steps, sleeps } = workflowStep({ skipLanes: true, fail: name => Number(name.match(/^cs: request (\d+)$/)?.[1]) >= 10 });
    await runPaperHarvest(env, dailyRun(), step);
    const requests = steps.filter(name => /: request \d+$/.test(name));
    assert.ok(requests.length <= 4 && requests.every(name => name.startsWith('cs:')), `${retryAfter}: ${requests.join(', ')}`);
    assert.ok(sleeps.every(duration => Number(duration) <= 300_000), `${retryAfter}: slept ${sleeps.join(', ')}`);
    assert.ok(steps.includes('embed 0'), `${retryAfter}: the run goes on`);
  }
});

const NOW = Date.parse('2026-10-22T03:00:00Z');
const record = (arxivId: string, title: string, abstract: string) => arxivRecordPaper({
  arxivId,
  title,
  abstract,
  authors: ['Ana Pérez'],
  categories: ['cs.CL'],
  doi: null,
  journalRef: null,
  comments: null,
  published: '2026-10-10T12:00:00.000Z',
  updated: '2026-10-10T12:00:00.000Z',
});

// The run carries the vectors of the arXiv-only store (migration 0001) every
// night. A new version that changes a paper's text drops its vector, and the
// next carry, in the same run, put the old version's back.
test("the old store's vector moves to a row with the same text, never to a revised one", async () => {
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding } as Parameters<typeof ingestPapers>[0];
  const firstVersions = [
    record('2610.11111', 'Sparse attention for long documents', 'We make attention sparse.'),
    record('2610.22222', 'Dense retrieval for scientific question answering', 'We retrieve passages densely.'),
  ];
  for (const paper of firstVersions) {
    db.prepare(`INSERT INTO papers VALUES (?, ?, ?, '[]', '["cs.CL"]', NULL, NULL, NULL, '2026-10-10', '2026-10-10')`).run(paper.id, paper.title, paper.abstract);
    db.prepare(`INSERT INTO paper_vectors VALUES (?, x'0707')`).run(paper.id);
  }
  await ingestPapers(env, firstVersions.map(paper => ({ paper, lanes: [] })), { now: NOW });
  await carryArxivVectors(binding)();
  const carried = () => db.prepare(`SELECT k.key FROM work_vectors v JOIN work_keys k ON k.work_id = v.work_id WHERE k.key LIKE 'arxiv:%' ORDER BY k.key`).all().map(row => row.key);
  assert.deepEqual(carried(), ['arxiv:2610.11111', 'arxiv:2610.22222']);

  const revision = record('2610.22222', 'Dense retrieval for scientific question answering', 'We retrieve passages densely, and rerank them.');
  await ingestPapers(env, [{ paper: revision, lanes: [] }], { now: NOW });
  await carryArxivVectors(binding)();
  assert.deepEqual(carried(), ['arxiv:2610.11111'], 'the revised paper waits for the embedding pass');
});
