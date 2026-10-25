import assert from 'node:assert/strict';
import test from 'node:test';

import type { Paper } from '../src/models/paper.ts';
import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import { enrichPending } from './paper-enrichment.ts';
import { embedWorks, ingestPapers } from './paper-store.ts';
import { arxivRecordPaper } from './paper-sources.ts';
import { mapOpenAlexWork } from '../src/utils/open-alex-work.ts';
import { testD1 } from './test-support/sqlite-d1.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';
import { OPENALEX_TIER_PERCENT } from './provider-runtime.ts';

const NOW = Date.parse('2026-10-22T03:00:00Z');

// Synthetic records in the shapes the sources' mappers return.
const preprint = arxivRecordPaper({
  arxivId: '2610.11111',
  title: 'Sparse attention for long documents',
  abstract: 'We make attention sparse.',
  authors: ['Ana Pérez'],
  categories: ['cs.CL'],
  doi: null, journalRef: null, comments: null,
  published: '2026-10-10T12:00:00.000Z',
  updated: '2026-10-10T12:00:00.000Z',
});
const unknownPreprint = { ...preprint, id: '2610.22222', arxivId: '2610.22222', title: 'A paper OpenAlex has not listed yet', pdfUrl: 'https://arxiv.org/pdf/2610.22222', landingPageUrl: 'https://arxiv.org/abs/2610.22222' };
// An OpenAlex record whose DOI Crossref types as a book.
const book = { ...mapOpenAlexWork({ id: 'https://openalex.org/W568341909', doi: 'https://doi.org/10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals', type: 'article', publication_date: '2026-10-01' })!, abstract: 'A book.' };

function providers(t: import('node:test').TestContext, { openAlexStatus = 200 } = {}) {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    asked.push(url.hostname);
    if (url.hostname === 'api.openalex.org') {
      if (openAlexStatus !== 200) return new Response('{}', { status: openAlexStatus });
      return Response.json({ results: [{
        id: 'https://openalex.org/W4400000001',
        ids: { arxiv: 'https://arxiv.org/abs/2610.11111' },
        cited_by_count: 7,
        primary_topic: { id: 'https://openalex.org/T10181', display_name: 'Natural Language Processing Techniques' },
        topics: [{ id: 'https://openalex.org/T10181', display_name: 'Natural Language Processing Techniques' }],
        authorships: [{ author: { id: 'https://openalex.org/A5023888391', display_name: 'Ana Pérez' }, institutions: [] }],
        type: 'preprint',
        locations: [{ landing_page_url: 'https://arxiv.org/abs/2610.11111' }],
      }] });
    }
    if (url.hostname === 'api.crossref.org') {
      return Response.json({ message: { 'total-results': 1, items: [{ DOI: '10.1007/978-3-540-76956-9', type: 'book' }] } });
    }
    return Response.json({});
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  return asked;
}

async function corpus() {
  const { binding, db } = testD1();
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, OPENALEX_API_KEY: 'test-key' } as unknown as WorkerEnv;
  await ingestPapers(env, [
    { paper: preprint, lanes: [] },
    { paper: unknownPreprint, lanes: [] },
    { paper: book, lanes: ['math.MP'] },
  ], { now: NOW });
  return { env, db };
}
const stored = (db: ReturnType<typeof testD1>['db']): Record<string, { paper: Paper; misses: number; enrichedAt: string | null }> => Object.fromEntries((db.prepare('SELECT paper, enrich_misses, enriched_at FROM works').all() as Array<{ paper: string; enrich_misses: number; enriched_at: string | null }>)
  .map(row => [JSON.parse(row.paper).id, { paper: JSON.parse(row.paper), misses: row.enrich_misses, enrichedAt: row.enriched_at }]));

test('stored papers get what the feed used to add to every page, once; an unknown one waits for a retry, a book leaves its lanes', async t => {
  providers(t);
  const { env, db } = await corpus();
  db.prepare("INSERT INTO followed_lanes (lane, requested_at) VALUES ('author:A5023888391', ?)").run(new Date(NOW).toISOString());
  assert.equal((await enrichPending(env, 50, NOW)).workIds.length, 3);
  const works = stored(db);
  assert.equal(works['2610.11111'].paper.citationCount, 7);
  assert.equal(works['2610.11111'].paper.citationCountKnown, true);
  assert.equal(works['2610.11111'].paper.primaryTopic?.id, 'https://openalex.org/T10181');
  assert.ok(works['2610.11111'].paper.sources.enrichedBy.includes('openalex'));
  assert.equal(works['2610.11111'].misses, 0);
  // OpenAlex did not know this one yet: unknown stays unknown, and it is asked again later.
  assert.equal(works['2610.22222'].paper.citationCountKnown, false);
  assert.equal(works['2610.22222'].misses, 1);
  assert.equal(works['openalex:W568341909'].paper.publicationType, 'book');
  assert.deepEqual(db.prepare(`SELECT lane FROM work_lanes WHERE work_id = (SELECT work_id FROM work_keys WHERE key = 'id:openalex:w568341909')`).all(), [], 'a book is not offered');
  // The followed author and topic now find the enriched paper.
  const lanes = db.prepare(`SELECT lane FROM work_lanes WHERE work_id = (SELECT work_id FROM work_keys WHERE key = 'arxiv:2610.11111') ORDER BY lane`).all().map(row => (row as { lane: string }).lane);
  assert.deepEqual(lanes, ['author:A5023888391', 'cs.CL', 'topic:T10181']);
  assert.deepEqual(await enrichPending(env, 50, NOW), { workIds: [], stop: true }, 'nothing is asked twice');
});

// PAP-88: readers' card batches stop at 80 % of the day's OpenAlex ceiling.
// Enrichment asks in the same shape, at night and for the runs new follows
// start during the day, and spends the harvest's own share up to 95 %.
test("readers' closed card-batch tier does not stop the harvest's enrichment", async t => {
  providers(t);
  const { env, db } = await corpus();
  const ceiling = 1_000;
  Object.assign(env, { OPENALEX_GLOBAL_DAILY_LIMIT: String(ceiling) });
  await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `openalex:day:${new Date().toISOString().slice(0, 10)}`, subject: 'readers', subjectLimit: ceiling, globalLimit: ceiling,
    amount: Math.floor(ceiling * OPENALEX_TIER_PERCENT.enrichment / 100) + 100,
  });
  assert.equal((await enrichPending(env, 50, NOW)).workIds.length, 3);
  assert.equal(stored(db)['2610.11111'].paper.citationCount, 7);
});

for (const status of [429, 502]) {
  test(`an OpenAlex that answers ${status} leaves the papers waiting for it to the next run, and marks the rest done`, async t => {
    providers(t, { openAlexStatus: status });
    const { env, db } = await corpus();
    assert.equal((await enrichPending(env, 50, NOW)).stop, true, 'the run stops asking');
    const works = stored(db);
    assert.equal(works['2610.11111'].enrichedAt, null);
    assert.equal(works['2610.22222'].enrichedAt, null);
    assert.equal(works['2610.22222'].misses, 0, 'not a miss: OpenAlex was not heard');
    // OpenAlex's own record needed no OpenAlex: Crossref's answer applies, and it is done.
    assert.equal(works['openalex:W568341909'].paper.publicationType, 'book');
    assert.notEqual(works['openalex:W568341909'].enrichedAt, null);
  });
}

// ENG-129: a paper OpenAlex lists without an abstract is admitted, and its text
// is recovered from Crossref's record and then from Semantic Scholar's.
const NO_ABSTRACT = 'No abstract available.';
const DAY_MS = 86_400_000;
const awaitingAbstract = (workId: string, doi: string) => mapOpenAlexWork({
  id: `https://openalex.org/${workId}`, doi: `https://doi.org/${doi}`, title: `A journal article OpenAlex lists without its abstract (${doi})`, type: 'article', publication_date: '2026-10-01',
})!;

interface Asked { url: URL; method: string; body: string; apiKey: string | null }

// Crossref and Semantic Scholar as these tests set them; OpenAlex knows nothing
// new and every other source answers empty.
function recoveryProviders(t: import('node:test').TestContext, {
  crossref,
  semanticScholar = () => Response.json([]),
}: { crossref: () => Response; semanticScholar?: () => Response }) {
  const asked: Asked[] = [];
  const realFetch = globalThis.fetch;
  const realCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    asked.push({ url, method: request.method, body: await request.text(), apiKey: request.headers.get('x-api-key') });
    if (url.hostname === 'api.crossref.org') return crossref();
    if (url.hostname === 'api.semanticscholar.org') return semanticScholar();
    if (url.hostname === 'api.openalex.org') return Response.json({ results: [] });
    return Response.json({});
  });
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = realCaches;
  });
  return asked;
}

async function recoveryCorpus(papers: Paper[], settings: Record<string, string> = {}) {
  const { binding, db } = testD1();
  // Workers AI, as the store calls it: one vector of the model's size per text.
  const AI = { run: async (_model: string, { text }: { text: string[] }) => ({ data: text.map((_, index) => Array.from({ length: 1024 }, (__, dimension) => Math.sin(index + dimension + 1))) }) };
  const env = { PAPER_STORE: binding, REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding, OPENALEX_API_KEY: 'test-key', SEMANTIC_SCHOLAR_API_KEY: 's2-test-key', AI, ...settings } as unknown as WorkerEnv;
  await ingestPapers(env, papers.map(paper => ({ paper, lanes: [] })), { now: NOW });
  const ids: Record<string, number> = Object.fromEntries((db.prepare('SELECT id, paper FROM works').all() as Array<{ id: number; paper: string }>)
    .map(row => [JSON.parse(row.paper).id, row.id]));
  // The title-only vectors an earlier run gave them, whose claim has expired since.
  assert.equal(await embedWorks(env, Object.values(ids), undefined), papers.length);
  db.prepare('UPDATE works SET embedding_claimed_until = NULL').run();
  return { env, db, ids };
}
const vectorOf = (db: ReturnType<typeof testD1>['db'], id: number) => db.prepare('SELECT embedding FROM work_vectors WHERE work_id = ?').get(id);
const semanticScholarCalls = (asked: Asked[]) => asked.filter(request => request.url.hostname === 'api.semanticscholar.org');

test("a paper without an abstract gets Crossref's, stripped of JATS markup, from the same call that brings its type; its vector is dropped and re-embedded", async t => {
  const asked = recoveryProviders(t, {
    crossref: () => Response.json({ message: { items: [{ DOI: '10.5555/Recovered', type: 'journal-article', abstract: '<jats:p>Real <i>text</i>.</jats:p>' }] } }),
  });
  const { env, db, ids } = await recoveryCorpus([awaitingAbstract('W4410000001', '10.5555/recovered')]);
  const id = ids['openalex:W4410000001'];
  assert.ok(vectorOf(db, id));
  const { workIds } = await enrichPending(env, 50, NOW);
  const { paper } = stored(db)['openalex:W4410000001'];
  assert.equal(paper.abstract, 'Real text .');
  assert.ok(paper.sources.enrichedBy.includes('crossref'));
  assert.equal(vectorOf(db, id), undefined, 'the title-only vector is dropped');
  assert.equal(await embedWorks(env, workIds, undefined), 1);
  assert.ok(vectorOf(db, id), 'and the title and abstract are embedded');
  assert.equal(asked.filter(request => request.url.hostname === 'api.crossref.org').length, 1);
  assert.deepEqual(semanticScholarCalls(asked), []);
});

test('what Crossref has no abstract for is asked of Semantic Scholar in one batch per step, matched by DOI', async t => {
  const asked = recoveryProviders(t, {
    crossref: () => Response.json({ message: { items: [
      { DOI: '10.5555/c', type: 'journal-article', abstract: '<jats:p>From Crossref.</jats:p>' },
      { DOI: '10.5555/a', type: 'journal-article' },
      { DOI: '10.5555/b', type: 'journal-article' },
    ] } }),
    // In the order asked: the answer for a is another paper's record.
    semanticScholar: () => Response.json([
      { paperId: 'f1', externalIds: { DOI: '10.9999/another-paper' }, abstract: 'The abstract of another paper.' },
      { paperId: 'f2', externalIds: { DOI: '10.5555/B' }, abstract: 'From Semantic Scholar.' },
    ]),
  });
  const { env, db } = await recoveryCorpus([awaitingAbstract('W4410000001', '10.5555/a'), awaitingAbstract('W4410000002', '10.5555/b'), awaitingAbstract('W4410000003', '10.5555/c')]);
  await enrichPending(env, 50, NOW);
  const [batch, ...others] = semanticScholarCalls(asked);
  assert.deepEqual(others, []);
  assert.equal(batch.method, 'POST');
  assert.equal(`${batch.url.origin}${batch.url.pathname}`, 'https://api.semanticscholar.org/graph/v1/paper/batch');
  assert.deepEqual(JSON.parse(batch.body), { ids: ['DOI:10.5555/a', 'DOI:10.5555/b'] });
  assert.equal(batch.apiKey, 's2-test-key');
  const works = stored(db);
  assert.equal(works['openalex:W4410000003'].paper.abstract, 'From Crossref.');
  assert.equal(works['openalex:W4410000002'].paper.abstract, 'From Semantic Scholar.');
  assert.ok(works['openalex:W4410000002'].paper.sources.enrichedBy.includes('semantic-scholar'));
  assert.equal(works['openalex:W4410000001'].paper.abstract, NO_ABSTRACT, "another paper's record is not this paper's abstract");
  assert.ok(!works['openalex:W4410000001'].paper.sources.enrichedBy.includes('semantic-scholar'));
});

test('a recovery that fails leaves the paper admitted, enriched and asked again at the refresh', async t => {
  const asked = recoveryProviders(t, {
    crossref: () => new Response('{}', { status: 500 }),
    semanticScholar: () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
  });
  const { env, db, ids } = await recoveryCorpus([awaitingAbstract('W4410000001', '10.5555/a')]);
  const id = ids['openalex:W4410000001'];
  const titleVector = vectorOf(db, id);
  assert.deepEqual((await enrichPending(env, 50, NOW)).workIds, [id]);
  assert.equal(semanticScholarCalls(asked).length, 1);
  const work = stored(db)['openalex:W4410000001'];
  assert.equal(work.paper.abstract, NO_ABSTRACT);
  assert.equal(work.enrichedAt, new Date(NOW).toISOString());
  assert.equal(work.misses, 0);
  assert.deepEqual(vectorOf(db, id), titleVector, 'its title-only vector stays');
  assert.deepEqual((await enrichPending(env, 50, NOW + DAY_MS)).workIds, [], 'not asked again the next day');
  asked.length = 0;
  assert.deepEqual((await enrichPending(env, 50, NOW + 15 * DAY_MS)).workIds, [id]);
  assert.ok(asked.some(request => request.url.hostname === 'api.openalex.org'), 'asked again as a refresh of its counts');
  assert.ok(asked.some(request => request.url.hostname === 'api.crossref.org'), 'and of its abstract');
});

test('a spent Semantic Scholar bucket sends nothing and costs nothing', async t => {
  const asked = recoveryProviders(t, {
    crossref: () => Response.json({ message: { items: [{ DOI: '10.5555/a', type: 'journal-article' }] } }),
  });
  const { env, db, ids } = await recoveryCorpus([awaitingAbstract('W4410000001', '10.5555/a')], { S2_GLOBAL_MINUTE_LIMIT: '1' });
  // Readers' related papers have spent this minute's allowance, and the next one's.
  for (const minute of [0, 60_000]) {
    await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, { periodKey: `s2:${new Date(Date.now() + minute).toISOString().slice(0, 16)}`, subject: 's2:shared', subjectLimit: 1, globalLimit: 1 });
  }
  assert.deepEqual((await enrichPending(env, 50, NOW)).workIds, [ids['openalex:W4410000001']]);
  assert.deepEqual(semanticScholarCalls(asked), []);
  const work = stored(db)['openalex:W4410000001'];
  assert.equal(work.paper.abstract, NO_ABSTRACT);
  assert.equal(work.enrichedAt, new Date(NOW).toISOString());
  assert.equal(work.misses, 0);
});
