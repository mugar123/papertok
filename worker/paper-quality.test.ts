import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkerEnv } from './env.ts';
import { OPENALEX_HARVEST_DAILY_UNITS, OPENALEX_NEW_FOLLOWS_DAILY_UNITS, readOpenAlexBudget, reserveOpenAlexBudget } from './provider-runtime.ts';
import { AUTHOR_IMPACT_PART, computePaperQuality, loadPaperAuthorImpact, prunePaperQuality } from './paper-quality.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { testD1 } from './test-support/sqlite-d1.ts';

const day = 86_400_000;
const now = Date.parse('2026-11-23T02:30:00Z');

function corpus() {
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding } satisfies WorkerEnv;
  function add(id: number, paper: object, published = now - day) {
    db.prepare('INSERT INTO works (id, paper, published, kept_until) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(paper), new Date(published).toISOString(), new Date(now + 90 * day).toISOString());
  }
  return { db, env, add };
}

function bindSharedStore(env: WorkerEnv) {
  const entries = new Map<string, { value: string; metadata: unknown }>();
  const store = {
    entries,
    getWithMetadata: async (key: string) => entries.get(key) ?? { value: null, metadata: null },
    put: async (key: string, value: string, options: { metadata: unknown }) => { entries.set(key, { value, metadata: options.metadata }); },
  };
  Object.assign(env, { NOTIFICATION_STORE: store });
  return store;
}

// Synthetic OpenAlex list responses. All calls pass through the harvest relay and its quota ledger.
function openAlex(t: import('node:test').TestContext, reply: (ids: string[]) => Response) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const batches: string[][] = [];
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : request);
    assert.equal(url.pathname, '/authors');
    assert.equal(url.searchParams.get('select'), 'id,summary_stats');
    assert.equal(url.searchParams.get('per_page'), '100');
    const filter = url.searchParams.get('filter') ?? '';
    assert.match(filter, /^openalex:A\d+(\|A\d+)*$/);
    const ids = filter.slice('openalex:'.length).split('|');
    batches.push(ids);
    return reply(ids);
  });
  return batches;
}

async function run(env: ReturnType<typeof corpus>['env'], at = now) {
  let progress: Awaited<ReturnType<typeof loadPaperAuthorImpact>> = { after: null, pending: [] };
  while (progress) progress = await loadPaperAuthorImpact(env.PAPER_STORE, env, at, progress);
  let after: Awaited<ReturnType<typeof computePaperQuality>> = null;
  do {
    after = await computePaperQuality(env.PAPER_STORE, at, after);
  } while (after);
}

test('the first and last three authors and positive HF votes give inspectable, capped log contributions', async t => {
  const { env, db, add } = corpus();
  const batches = openAlex(t, () => Response.json({ results: [
    { id: 'https://openalex.org/A1', summary_stats: { h_index: 1 } },
    { id: 'https://openalex.org/A3', summary_stats: { h_index: 9 } },
    { id: 'https://openalex.org/A4', summary_stats: { h_index: 1000 } },
    { id: 'https://openalex.org/A5', summary_stats: { h_index: 2 } },
  ] }));
  add(1, { authors: ['A1', 'A2', 'A3', 'A4', 'A5'].map(id => ({ id })), huggingFaceUpvotes: 500 });
  add(2, { authors: [{ id: ' https://openalex.org/authors/A3 ' }], huggingFaceUpvotes: 9, citationCount: 4 });
  add(3, { authors: [{ id: 'A1' }], huggingFaceUpvotes: 0 });
  await run(env);
  assert.deepEqual(batches, [['A1', 'A3', 'A4', 'A5']]);
  const rows = db.prepare('SELECT * FROM work_quality ORDER BY work_id').all();
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].max_h_index, rows[0].hf_upvotes, rows[0].author_bonus, rows[0].hf_bonus, rows[0].score],
    [1000, 500, 0.035, 0.025, 0.05]);
  const close = (actual: unknown, expected: number) => assert.ok(Math.abs(Number(actual) - expected) < 0.000001, String(actual));
  close(rows[1].author_bonus, 0.017462);
  close(rows[1].hf_bonus, 0.012473);
  close(rows[1].score, 0.029935);
  close(rows[2].score, 0.005257);
  assert.equal(rows[2].hf_upvotes, null);
});

test('unknowns and zero votes leave no row, large bylines can qualify through HF alone', async t => {
  const { env, db, add } = corpus();
  const batches = openAlex(t, () => Response.json({ results: [
    { id: 'A2', summary_stats: { h_index: 0 } }, { id: 'A3', summary_stats: {} }, { id: 'A30', summary_stats: { h_index: 2 } },
  ] }));
  add(1, { authors: ['No ID', { id: 'I20' }], huggingFaceUpvotes: 0 });
  add(2, { authors: [{ id: 'A1' }, { id: 'A2' }, { id: 'A3' }] });
  const authors = Array.from({ length: 31 }, () => ({ id: 'A31' }));
  add(3, { authors });
  add(4, { authors, huggingFaceUpvotes: 12, citationCount: 0, citationCountKnown: false });
  add(5, { authors: Array.from({ length: 30 }, () => ({ id: 'A30' })) });
  add(6, { authors: [{ id: 'A66' }], huggingFaceUpvotes: 1 }, now - 90 * day);
  add(7, { authors: [{ id: 'A77' }], huggingFaceUpvotes: 1 }, now + day);
  add(8, { authors: [{ id: 'A8' }], huggingFaceUpvotes: 1, citationCount: 5 });
  add(9, { authors: [{ id: 'A2' }], huggingFaceUpvotes: 6 });
  await run(env);
  await run(env, now + 1000);
  assert.deepEqual(batches, [['A1', 'A2', 'A3', 'A30', 'A77']]);
  assert.deepEqual(db.prepare('SELECT work_id, max_h_index, hf_upvotes FROM work_quality ORDER BY work_id').all().map(Object.values),
    [[4, null, 12], [5, 2, null], [7, null, 1], [9, 0, 6]]);
  assert.deepEqual(db.prepare('SELECT author_id, h_index FROM openalex_author_impact ORDER BY author_id').all().map(Object.values),
    [['A1', null], ['A2', 0], ['A3', null], ['A30', 2], ['A77', null]]);
});

test('a spent nightly share stops calls across pages and the next night resumes from the cached batch', async t => {
  const { env, db, add } = corpus();
  const warnings = t.mock.method(console, 'warn', () => {});
  // The actual ledger has one unit left for tonight, including after earlier callers spent the rest.
  const batches = openAlex(t, ids => Response.json({ results: ids.map(id => ({ id, summary_stats: { h_index: 5 } })) }));
  const reservation = await reserveOpenAlexBudget(env, '', { tier: 'feed', kind: 'list', units: OPENALEX_HARVEST_DAILY_UNITS - OPENALEX_NEW_FOLLOWS_DAILY_UNITS - 1 });
  assert.ok(reservation.reservations);
  for (let id = 1; id <= 501; id++) add(id, { authors: [{ id: 'A' + id }], huggingFaceUpvotes: id === 501 ? 3 : 0 }, now - (id <= 2 ? 2 * day : day));
  await run(env);
  assert.equal(warnings.mock.calls.filter(call => String(call.arguments[0]).includes('nightly share spent')).length, 1);
  assert.deepEqual(batches, [Array.from({ length: 100 }, (_, i) => 'A' + (i + 3)).sort()]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact').get()?.n, 100);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_quality').get()?.n, 101);
  assert.equal(db.prepare('SELECT max_h_index FROM work_quality WHERE work_id = 501').get()?.max_h_index, null);
  t.mock.timers.setTime(now + day);
  await run(env, now + day);
  assert.equal(batches[1][0], 'A103');
  assert.ok(batches.every(batch => batch.length <= 100));
  assert.equal(new Set(batches.flat()).size, 501);
  assert.equal(batches.flat().length, 501);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_quality').get()?.n, 501);
  assert.equal(db.prepare('SELECT max_h_index FROM work_quality WHERE work_id = 501').get()?.max_h_index, 5);
});

test("author discovery still has its nightly units after readers spend their share and minute", async t => {
  const { env, db, add } = corpus();
  Object.assign(env, { OPENALEX_GLOBAL_DAILY_LIMIT: '4', OPENALEX_GLOBAL_MINUTE_LIMIT: '2' });
  const warnings = t.mock.method(console, 'warn', () => {});
  const batches = openAlex(t, ids => Response.json({ results: ids.map(id => ({ id, summary_stats: { h_index: 7 } })) }));
  const readers = await reserveOpenAlexBudget(env, '', { tier: 'essential', kind: 'list', units: 2 });
  assert.ok(readers.reservations);
  for (let id = 1; id <= 101; id++) add(id, { authors: [{ id: 'A' + id }] });
  await run(env);
  assert.deepEqual(batches.map(ids => ids.length), [100]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact WHERE h_index = 7').get()?.n, 100);
  const { report } = await readOpenAlexBudget(env);
  assert.equal(report?.tiers.feed.used, 1);
  assert.equal(report?.rest.used, 2);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), [
    'Stopping author impact for this run: OpenAlex author list returned HTTP 429 (daily feed ceiling reached)',
  ]);
});

test('a fifth citation, aging out and corpus deletion remove evidence, and a refresh that drops an author keeps its h-index', async t => {
  const { env, db, add } = corpus();
  let refreshed = false;
  const batches = openAlex(t, ids => Response.json({ results: ids.includes('A1') && !refreshed ? [{ id: 'A1', summary_stats: { h_index: 3 } }] : [] }));
  add(1, { authors: [{ id: 'A1' }] });
  add(2, { huggingFaceUpvotes: 8 });
  add(3, { huggingFaceUpvotes: 8 }, now - 60 * day);
  add(4, { huggingFaceUpvotes: 8 });
  add(5, { huggingFaceUpvotes: 8 });
  await run(env);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_quality').get()?.n, 5);
  db.prepare("UPDATE works SET paper = json_set(paper, '$.citationCount', 5) WHERE id = 2").run();
  db.prepare("UPDATE works SET published = '2020-01-01' WHERE id = 4").run();
  db.prepare('DELETE FROM works WHERE id = 5').run();
  await run(env, now + 29 * day);
  assert.deepEqual(batches, [['A1']]);
  refreshed = true;
  t.mock.timers.setTime(now + 30 * day);
  assert.equal(await prunePaperQuality(env.PAPER_STORE, now + 30 * day), false);
  await computePaperQuality(env.PAPER_STORE, now + 30 * day, null);
  assert.equal(db.prepare('SELECT max_h_index FROM work_quality WHERE work_id = 1').get()?.max_h_index, 3);
  await run(env, now + 30 * day);
  assert.deepEqual(batches, [['A1'], ['A1']]);
  assert.deepEqual(db.prepare('SELECT work_id, max_h_index FROM work_quality').all().map(row => ({ ...row })), [{ work_id: 1, max_h_index: 3 }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM works').get()?.n, 4);
});

for (const phase of ['discovery', 'refresh']) {
  test(`a malformed OpenAlex list during ${phase} leaves the batch retryable and still materializes HF votes`, async t => {
    const { env, db, add } = corpus();
    const store = bindSharedStore(env);
    let recovered = false;
    const batches = openAlex(t, () => Response.json(recovered ? { results: [{ id: 'A1', summary_stats: { h_index: 8 } }] } : {}));
    add(1, { authors: [{ id: 'A1' }], huggingFaceUpvotes: 10 });
    if (phase === 'refresh') {
      db.prepare("INSERT INTO openalex_author_impact (author_id, h_index, fetched_at) VALUES ('A1', 3, ?)")
        .run(new Date(now - 31 * day).toISOString());
    }
    await run(env);
    assert.equal(store.entries.size, 0);
    assert.deepEqual(Object.values(db.prepare('SELECT max_h_index, hf_upvotes FROM work_quality').get()!), [phase === 'refresh' ? 3 : null, 10]);
    recovered = true;
    const nextNight = now + day - 60_000;
    t.mock.timers.setTime(nextNight);
    await run(env, nextNight);
    assert.deepEqual(batches, [['A1'], ['A1']]);
    assert.equal(db.prepare('SELECT max_h_index FROM work_quality').get()?.max_h_index, 8);
  });
}

test('a provider timeout leaves authors due and an unexpected error propagates', async t => {
  const { env, db, add } = corpus();
  let failure: Error = new DOMException('deadline exceeded', 'TimeoutError');
  const warnings = t.mock.method(console, 'warn', () => {});
  const batches = openAlex(t, () => { throw failure; });
  add(1, { authors: [{ id: 'A1' }] });
  const load = () => loadPaperAuthorImpact(env.PAPER_STORE, env, now, { after: null, pending: [] });
  assert.equal(await load(), null);
  assert.match(String(warnings.mock.calls[0].arguments[0]), /TimeoutError/);
  failure = new TypeError('unexpected provider adapter error');
  await assert.rejects(load, error => error === failure);
  assert.equal(batches.length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact').get()?.n, 0);
});

for (const [size, answered, stored] of [[19, 0, 19], [20, 0, 0], [20, 1, 20]]) {
  test(`a batch of ${size} requested authors with ${answered} valid records stores ${stored} authors`, async t => {
    const { env, db, add } = corpus();
    const batches = openAlex(t, () => Response.json({ results: answered
      ? [{ id: 'A1', summary_stats: {} }]
      : [{ id: 'A1', summary_stats: null }, { id: 'A999', summary_stats: {} }] }));
    for (let id = 1; id <= size; id++) add(id, { authors: [{ id: 'A' + id }] });
    const progress = await loadPaperAuthorImpact(env.PAPER_STORE, env, now, { after: null, pending: [] });
    assert.equal(progress, stored ? 'refresh' : null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact').get()?.n, stored);
    t.mock.timers.setTime(now + day);
    await run(env, now + day);
    assert.equal(batches.length, stored ? 1 : 2);
  });
}

test('a rejected discovery batch is logged and can recover the next night within the shared cache TTL', async t => {
  const { env, db, add } = corpus();
  const store = bindSharedStore(env);
  const reads = t.mock.method(store, 'getWithMetadata');
  const warnings = t.mock.method(console, 'warn', () => {});
  let recovered = false;
  const batches = openAlex(t, ids => Response.json({ results: recovered ? ids.map(id => ({ id, summary_stats: { h_index: 8 } })) : [] }));
  for (let id = 101; id <= 120; id++) add(id, { authors: [{ id: 'A' + (221 - id) }] });
  await run(env);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact').get()?.n, 0);
  assert.equal(store.entries.size, 0);
  assert.equal((await readOpenAlexBudget(env)).report?.tiers.feed.used, 1);
  const [key] = reads.mock.calls[0].arguments;
  store.entries.set(key, { value: JSON.stringify({ results: [] }), metadata: { status: 200 } });
  const firstNight = warnings.mock.calls.map(call => String(call.arguments[0]));
  recovered = true;
  const nextNight = now + day - 60_000;
  t.mock.timers.setTime(nextNight);
  await run(env, nextNight);
  assert.equal(batches.length, 2);
  assert.equal(store.entries.size, 1);
  assert.equal((await readOpenAlexBudget(env)).report?.tiers.feed.used, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM openalex_author_impact WHERE h_index = 8').get()?.n, 20);
  assert.equal(firstNight.length, 1);
  assert.match(firstNight[0], /20 requested authors.*A101/);
});

test('an unanswered full refresh keeps the old metrics and advances to the next author', async t => {
  const { env, db, add } = corpus();
  const warnings = t.mock.method(console, 'warn', () => {});
  const batches = openAlex(t, ids => Response.json({ results: ids.length === 1 ? [{ id: ids[0], summary_stats: { h_index: 7 } }] : [] }));
  const seed = db.prepare('INSERT INTO openalex_author_impact (author_id, h_index, fetched_at) VALUES (?, 4, ?)');
  for (let id = 101; id <= 201; id++) {
    add(id, { authors: [{ id: 'A' + id }] });
    seed.run('A' + id, new Date(now - 31 * day).toISOString());
  }
  await run(env);
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  assert.deepEqual(db.prepare('SELECT h_index, count(*) FROM openalex_author_impact WHERE fetched_at = ? GROUP BY h_index ORDER BY h_index')
    .all(new Date(now).toISOString()).map(Object.values), [[4, 100], [7, 1]]);
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[0]), ['OpenAlex author list gave no valid record for 100 of 100 authors']);
});

test('only an answered author can replace its cached h-index with an unknown value', async t => {
  const { env, db, add } = corpus();
  openAlex(t, () => Response.json({ results: [
    { id: 'A1', summary_stats: { h_index: null } }, { id: 'A2' },
    { id: 'A3', summary_stats: null }, { id: 'A4', summary_stats: {} },
  ] }));
  for (let id = 1; id <= 4; id++) {
    add(id, { authors: [{ id: 'A' + id }] });
    db.prepare('INSERT INTO openalex_author_impact (author_id, h_index, fetched_at) VALUES (?, 9, ?)')
      .run('A' + id, new Date(now - 31 * day).toISOString());
  }
  await run(env);
  const rows = db.prepare('SELECT h_index, fetched_at FROM openalex_author_impact ORDER BY author_id').all();
  assert.deepEqual(rows.map(row => row.h_index), [null, 9, 9, null]);
  assert.ok(rows.every(row => row.fetched_at === new Date(now).toISOString()));
});

test('sparse misses across publication pages share a single author request', async t => {
  const { env, db, add } = corpus();
  const batches = openAlex(t, ids => Response.json({ results: ids.map(id => ({ id, summary_stats: { h_index: 1 } })) }));
  for (let id = 1; id <= 502; id++) add(id, { authors: [{ id: id < 500 ? 'A1' : 'A' + id }] });
  await run(env);
  assert.deepEqual(batches, [['A1', 'A500', 'A501', 'A502']]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_quality').get()?.n, 502);
});

test('invalid author records and unrequested IDs leave only their own metrics unknown', async t => {
  const { env, db, add } = corpus();
  openAlex(t, () => Response.json({ results: [
    { id: 'invalid', summary_stats: { h_index: 19 } },
    { id: 'A2', summary_stats: { h_index: 2.5 } },
    { id: 'A99', summary_stats: { h_index: 12 } },
    { id: 'A3', summary_stats: { h_index: 7 } },
  ] }));
  for (const id of [1, 2, 3]) add(id, { authors: [{ id: 'A' + id }] });
  await run(env);
  assert.deepEqual(db.prepare('SELECT author_id, h_index FROM openalex_author_impact ORDER BY author_id').all().map(Object.values),
    [['A1', null], ['A2', null], ['A3', 7]]);
  assert.deepEqual(db.prepare('SELECT work_id, max_h_index FROM work_quality').all().map(Object.values), [[3, 7]]);
});

test('missing authors precede the oldest eligible refreshes and the author cap leaves other feed calls available', async t => {
  const { env, db, add } = corpus();
  const batches = openAlex(t, ids => Response.json({ results: ids.map(id => ({ id, summary_stats: { h_index: 9 } })) }));
  const warnings = t.mock.method(console, 'warn', () => {});
  const reserve = await reserveOpenAlexBudget(env, '', { tier: 'feed', kind: 'list', part: AUTHOR_IMPACT_PART, units: AUTHOR_IMPACT_PART.limit - 2 });
  assert.ok(reserve.reservations);
  const seed = db.prepare('INSERT INTO openalex_author_impact (author_id, h_index, fetched_at) VALUES (?, 3, ?)');
  for (let id = 1; id <= 101; id++) {
    add(id, { authors: [{ id: 'A' + id }] }, now - (id === 101 ? 2 : 1) * day);
    seed.run('A' + id, new Date(now - (30 + id) * day).toISOString());
  }
  // Both the only missing author and the oldest eligible refresh fall on the second page.
  for (let id = 102; id <= 500; id++) add(id, {});
  add(501, { authors: [{ id: 'A501' }] }, now - 2 * day);
  seed.run('A998', new Date(now - 365 * day).toISOString());
  seed.run('A999', new Date(now - 200 * day).toISOString());
  add(999, { authors: [{ id: 'A999' }], citationCount: 5 });
  await prunePaperQuality(env.PAPER_STORE, now);
  assert.equal(db.prepare("SELECT count(*) AS n FROM openalex_author_impact WHERE author_id = 'A998'").get()?.n, 0);
  await run(env);
  assert.equal(warnings.mock.calls.filter(call => String(call.arguments[0]).includes('author part spent')).length, 1);
  assert.deepEqual(batches, [['A501'], Array.from({ length: 100 }, (_, i) => 'A' + (i + 2)).sort()]);
  assert.equal(db.prepare('SELECT max_h_index FROM work_quality WHERE work_id = 1').get()?.max_h_index, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM work_quality WHERE max_h_index = 9').get()?.n, 101);
  assert.ok((await reserveOpenAlexBudget(env, '', { tier: 'feed', kind: 'list', units: 1 })).reservations);
});
