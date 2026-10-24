import test from 'node:test';
import assert from 'node:assert/strict';
import type { FollowEntity } from '../utils/following.ts';
import { fetchCorpusPage, fetchCorpusPapers } from './paperStoreService.ts';
import { hasSeenPaper, readFeedSeenFilter } from '../utils/seenPaperFilter.ts';

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
  const { papers, skipsSeen } = await fetchCorpusPage({
    categories: ['med.cardio', 'cs.LG'], follows: [follow], positiveIds: ['2610.00001'], page: 2, pageSize: 30, order: 'recent',
  }, options);
  assert.equal(skipsSeen, false);
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

test('a page sends what the reader has seen as the filter the Worker reads, and asks for notable papers only with it', async () => {
  const { asked, options } = harness(answered([]));
  const seen = new Set(['2610.00001', 'openalex:W2107743791']);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15, seen, notable: 2 }, options);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15, seen, notable: 0 }, options);
  await fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15, notable: 2 }, options);
  const [withNotable, seenOnly, without] = asked.map(entry => entry.body as { seen?: string; notable?: number });
  assert.equal(withNotable.notable, 2);
  for (const body of [withNotable, seenOnly]) {
    const read = readFeedSeenFilter(body.seen);
    assert.ok(['2610.00001', 'openalex:W2107743791'].every(id => hasSeenPaper(read, id)));
    assert.equal(hasSeenPaper(read, 'openalex:W2493916176'), false);
  }
  assert.ok(!('notable' in seenOnly), 'a page that asks for no notable papers says nothing of them');
  assert.ok(!('seen' in without) && !('notable' in without), 'a page that says nothing of what was seen asks for no notable papers');
});

test('a page returns whether the Worker passed over the papers the filter holds', async () => {
  const seen = new Set(['2610.00001']);
  const skipping = harness(async () => new Response(JSON.stringify({ papers: [STORED], skipsSeen: true }), { status: 200 }));
  assert.deepEqual(await fetchCorpusPage({ categories: ['med.cardio'], page: 0, pageSize: 15, seen }, skipping.options), { papers: [STORED], skipsSeen: true });
  // A Worker from before PAP-103 reads the filter for notable papers only, and says nothing.
  const paging = harness(answered([STORED]));
  assert.deepEqual(await fetchCorpusPage({ categories: ['med.cardio'], page: 0, pageSize: 15, seen }, paging.options), { papers: [STORED], skipsSeen: false });
});

test('a store that fails rejects, so the feed can say so and offer a retry', async () => {
  for (const answer of [async () => new Response('{}', { status: 503 }), async () => { throw new TypeError('offline'); }]) {
    const { options } = harness(answer);
    await assert.rejects(fetchCorpusPage({ categories: ['cs.LG'], page: 0, pageSize: 15 }, options));
  }
});

test("the corpus's copies of papers are asked for by the app's ids", async () => {
  const { asked, options } = harness(answered([STORED]));
  assert.deepEqual(await fetchCorpusPapers(['pmid:41000001', 'W4391234567'], options), [STORED]);
  assert.deepEqual(asked.map(entry => entry.body), [{ ids: ['pmid:41000001', 'W4391234567'] }]);
});
