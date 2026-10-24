import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import { fetchCorpusPage, fetchCorpusPapers } from './paperStoreService.ts';

const WORKER = 'https://papertok-report-api.example';

// Synthetic, in the shape /store/papers answers (worker/paper-feed.ts): the
// app's papers, with the categories and follows each was found under.
const STORED = {
  id: 'pmid:41000001',
  pmid: '41000001',
  sources: { primary: 'pubmed', enrichedBy: ['openalex', 'icite'] },
  title: 'Cardiac fibrosis after myocardial infarction',
  abstract: 'We follow fibrosis in 400 patients.',
  authors: [{ name: 'Ana Pérez' }],
  primaryCategory: 'med.cardio',
  citationCount: 3,
  citationCountKnown: true,
  _fetchedFor: ['med.cardio'],
};

function harness(answer: () => Promise<Response>) {
  const asked: Array<{ url: string; body: unknown }> = [];
  const options = {
    apiBase: WORKER,
    fetchWorker: async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init.body)) });
      return answer();
    },
  };
  return { asked, options };
}

const answered = (papers: unknown[]) => async () => new Response(JSON.stringify({ papers }), { status: 200 });

test('a page asks the corpus for the categories, follows and likes, and returns its papers as they are', async () => {
  const { asked, options } = harness(answered([STORED]));
  const follow = {
    type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez', followKey: 'author:A5023888391',
    metadata: { source: 'openalex', labelEn: 'Ana Pérez' },
  } as FollowEntity;
  const papers = await fetchCorpusPage({
    categories: ['med.cardio', 'cs.LG'], follows: [follow], positiveIds: ['2610.00001'], page: 2, pageSize: 30, order: 'recent',
  }, options);
  assert.deepEqual(asked, [{
    url: `${WORKER}/store/papers`,
    body: {
      categories: ['med.cardio', 'cs.LG'],
      // Only what decides the lane travels; the rest of the stored follow stays.
      follows: [{ type: 'author', canonicalId: 'A5023888391', displayName: 'Ana Pérez', metadata: {} }],
      positiveIds: ['2610.00001'],
      page: 2,
      pageSize: 30,
      order: 'recent',
    },
  }]);
  assert.deepEqual(papers, [STORED]);
});

test('a store that fails rejects, so the feed can say so and offer a retry', async () => {
  for (const answer of [async () => new Response('{}', { status: 503 }), async () => { throw new TypeError('offline'); }]) {
    const { options } = harness(answer);
    await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options));
  }
});

test('exclusions and explicit rejections reach the corpus while semantic relevance reaches the client', async () => {
  const { asked, options } = harness(answered([{ ...STORED, _semanticScore: -0.4 }]));
  const papers = await fetchCorpusPage({ categories: ['med.cardio'], negativeIds: ['rejected'], excludedIds: ['seen'], page: 0, pageSize: 15 }, options);
  assert.equal(papers[0]._semanticScore, -0.4);
  assert.deepEqual(asked.map(entry => entry.body), [{ categories: ['med.cardio'], follows: [], positiveIds: [], negativeIds: ['rejected'], excludedIds: ['seen'], page: 0, pageSize: 15, order: 'recent' }]);
});

test('long exclusions stay below the request body limit and keep the newest exclusions first', async () => {
  const { asked, options } = harness(answered([]));
  const excludedIds = Array.from({ length: 250 }, (_, index) => `10.1234/${index}${'é'.repeat(140)}`);
  await fetchCorpusPage({ categories: ['cs.CL'], negativeIds: ['rejected'], excludedIds, page: 0, pageSize: 15 }, options);
  const body = asked[0].body as { excludedIds: string[]; negativeIds: string[] };
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength <= 16_384);
  assert.deepEqual(body.excludedIds, excludedIds.slice(0, body.excludedIds.length));
  assert.ok(body.excludedIds.length > 0 && body.excludedIds.length < 200);
  assert.deepEqual(body.negativeIds, ['rejected']);
});

test('a full positive and followed profile still fits with long rejection IDs and no exclusions', async () => {
  const { asked, options } = harness(answered([]));
  const ids = Array.from({ length: 24 }, (_, index) => `10.1234/${index}${'a'.repeat(283)}`);
  const follows: FollowEntity[] = Array.from({ length: 20 }, (_, index) => ({ type: 'author', canonicalId: `A${index}`, displayName: `Followed author ${index}` }));
  await fetchCorpusPage({ categories: ['cs.CL'], positiveIds: ids, negativeIds: ids.map(id => `${id}b`), follows, page: 0, pageSize: 15 }, options);
  const body = asked[0].body as { positiveIds: string[]; negativeIds: string[]; follows: unknown[] };
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength <= 16_384);
  assert.deepEqual(body.positiveIds, ids);
  assert.equal(body.follows.length, 20);
  assert.ok(body.negativeIds.length < 24);
});

test("the corpus's copies of papers are asked for by the app's ids", async () => {
  const { asked, options } = harness(answered([STORED]));
  assert.deepEqual(await fetchCorpusPapers(['pmid:41000001', 'W4391234567'], options), [STORED]);
  assert.deepEqual(asked.map(entry => entry.body), [{ ids: ['pmid:41000001', 'W4391234567'] }]);
});
