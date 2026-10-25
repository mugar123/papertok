import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import { fetchCorpusPage, fetchCorpusPapers } from './paper-store-service.ts';
import { WorkerApiAuthError } from './worker-api-client.ts';
import { hasSeenPaper, readFeedSeenFilter } from '../utils/seen-paper-filter.ts';

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

test('a page asked by interest groups sends them with their categories and examples as the flat request', async () => {
  const { asked, options } = harness(answered([]));
  const groups = [
    { categories: ['econ.EM', 'econ.GN'], exampleCategories: ['econ.EM', 'econ.GN', 'econ.TH'], positiveIds: ['e1', 'e2'], weight: 2 },
    { categories: ['quant-ph'], exampleCategories: ['quant-ph', 'hep-th'], positiveIds: ['p1', 'e2'], weight: 1 },
  ];
  await fetchCorpusPage({ groups, positiveIds: ['u1'], page: 1, pageSize: 15 }, options);
  await fetchCorpusPage({ categories: ['econ.EM'], positiveIds: ['u1'], page: 1, pageSize: 15 }, options);
  const [grouped, flat] = asked.map(entry => entry.body);
  // An older Worker reads only the flat fields, so they carry every group.
  assert.deepEqual(grouped, {
    categories: ['econ.EM', 'econ.GN', 'quant-ph'], follows: [], positiveIds: ['e1', 'e2', 'p1', 'u1'], groups, page: 1, pageSize: 15, order: 'recent',
  });
  assert.deepEqual(flat, { categories: ['econ.EM'], follows: [], positiveIds: ['u1'], page: 1, pageSize: 15, order: 'recent' });
});

test('the examples of every group, then the unassigned ones, reach the corpus 24 at most', async () => {
  const { asked, options } = harness(answered([]));
  const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  const groups = [
    { categories: ['econ.EM'], exampleCategories: ['econ.EM'], positiveIds: ids('e', 16), weight: 2 },
    { categories: ['quant-ph'], exampleCategories: ['quant-ph'], positiveIds: ids('p', 8), weight: 1 },
  ];
  await fetchCorpusPage({ groups, positiveIds: ids('u', 4), page: 0, pageSize: 15 }, options);
  assert.deepEqual((asked[0].body as { positiveIds: string[] }).positiveIds, [...ids('e', 16), ...ids('p', 8)]);
});

test('a page that asks for notable papers sends what the reader has seen as the filter the Worker reads', async () => {
  const { asked, options } = harness(answered([]));
  const seen = new Set(['2610.00001', 'openalex:W2107743791']);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15, seen, notable: 2 }, options);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15, seen, notable: 0 }, options);
  const [withSeen, ...without] = asked.map(entry => entry.body as { seen?: string; notable?: number });
  assert.equal(withSeen.notable, 2);
  const read = readFeedSeenFilter(withSeen.seen);
  assert.ok(['2610.00001', 'openalex:W2107743791'].every(id => hasSeenPaper(read, id)));
  assert.equal(hasSeenPaper(read, 'openalex:W2493916176'), false);
  for (const body of without) assert.ok(!('seen' in body) && !('notable' in body), 'a page that asks for no notable papers sends no filter');
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

// The seen filter is 3,200 characters whatever it holds, and the Worker reads
// at most 16 KiB of a request: the exclusions and rejections make room for it.
test('a page asking for notable papers with a full profile keeps the whole seen filter below the request body limit', async () => {
  const { asked, options } = harness(answered([]));
  const ids = Array.from({ length: 24 }, (_, index) => `10.1234/${index}${'a'.repeat(283)}`);
  const follows: FollowEntity[] = Array.from({ length: 20 }, (_, index) => ({ type: 'author', canonicalId: `A${index}`, displayName: `Followed author ${index}` }));
  const excludedIds = Array.from({ length: 200 }, (_, index) => `10.1234/seen-${index}`);
  const seen = new Set(['2610.00001']);
  await fetchCorpusPage({ categories: ['cs.CL'], positiveIds: ids, negativeIds: ids.map(id => `${id}b`), excludedIds, follows, page: 0, pageSize: 15, seen, notable: 3 }, options);
  const body = asked[0].body as { seen: string; notable: number; positiveIds: string[]; excludedIds?: string[] };
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).byteLength <= 16_384);
  assert.equal(body.notable, 3);
  assert.ok(hasSeenPaper(readFeedSeenFilter(body.seen), '2610.00001'), 'the filter arrives whole');
  assert.deepEqual(body.positiveIds, ids);
  assert.deepEqual(body.excludedIds ?? [], excludedIds.slice(0, body.excludedIds?.length ?? 0), 'the newest exclusions stay first');
});

test("the corpus's copies of papers are asked for by the app's ids", async () => {
  const { asked, options } = harness(answered([STORED]));
  assert.deepEqual(await fetchCorpusPapers(['pmid:41000001', 'W4391234567'], options), [STORED]);
  assert.deepEqual(asked.map(entry => entry.body), [{ ids: ['pmid:41000001', 'W4391234567'] }]);
});

// ENG-116: the Worker says why it refused a page (worker/router.ts), and the
// feed reported every refusal as the same "Error loading papers".
test("a store refusal keeps the Worker's status and code", async () => {
  const { options } = harness(async () => new Response(JSON.stringify({ code: 'LANES_REQUIRED' }), { status: 400 }));
  await assert.rejects(
    fetchCorpusPage({ categories: [], page: 0, pageSize: 15 }, options),
    { status: 400, code: 'LANES_REQUIRED' },
  );
  const { options: unreadable } = harness(async () => new Response('<html>Bad gateway</html>', { status: 502 }));
  await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, unreadable), (error: { status?: number; code?: string }) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, undefined);
    return true;
  });
});

test('a request that got no answer is marked unreachable, while a deadline or a session failure keeps its own error', async () => {
  const { options: offline } = harness(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, offline), { code: 'STORE_UNREACHABLE' });
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  const { options: late } = harness(async () => { throw timeout; });
  await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, late), (error) => error === timeout);
  const signedOut = new WorkerApiAuthError();
  const { options: noSession } = harness(async () => { throw signedOut; });
  await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, noSession), (error) => error === signedOut);
});

test('a connection lost while the answer arrives is marked unreachable too', async () => {
  const cut = new ReadableStream({ start(controller) { controller.error(new TypeError('network error')); } });
  const { options } = harness(async () => new Response(cut, { status: 200 }));
  await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options), { code: 'STORE_UNREACHABLE' });
});

test('an answer without a papers list is an invalid response, not an empty page', async () => {
  for (const body of ['null', '{}', '{"papers":null}', '{"papers":{}}']) {
    const { options } = harness(async () => new Response(body, { status: 200 }));
    await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options), { code: 'STORE_RESPONSE_INVALID' });
  }
  const { options } = harness(answered([]));
  assert.deepEqual(await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options), []);
});
