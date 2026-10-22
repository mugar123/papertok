import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/Paper.ts';
import { fetchStoreFeed } from './paperStoreService.ts';

const WORKER = 'https://papertok-report-api.example';

// Synthetic, in the shape /store/feed answers (worker/paper-store.ts).
const STORED = {
  arxivId: '2610.29600',
  title: 'Demand Estimation for Rationally Inattentive Consumers',
  abstract: 'We estimate demand when consumers pay attention at a cost.',
  authors: ['Ana Pérez'],
  categories: ['econ.EM', 'stat.ME'],
  doi: null,
  journalRef: null,
  comments: '30 pages',
  published: '2026-10-21T17:59:56.000Z',
};

function harness({ store }: { store: () => Promise<Response> }) {
  const live: Array<{ categories: string[]; start: number }> = [];
  const asked: Array<{ url: string; body: unknown }> = [];
  const options = {
    apiBase: WORKER,
    hasSession: () => true,
    fetchWorker: async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(String(init.body)) });
      return store();
    },
    fetchLive: (async (categories: string[], start = 0) => {
      live.push({ categories, start });
      return [{ id: `live:${categories.join('+')}` } as Paper];
    }) as never,
  };
  return { live, asked, options };
}

const answered = (papers: unknown[]) => async () => new Response(JSON.stringify({ papers }), { status: 200 });

test('a stored page becomes arXiv papers, and only arXiv categories reach the store', async () => {
  const { live, asked, options } = harness({ store: answered([STORED]) });
  const papers = await fetchStoreFeed(['econ.EM', 'mech.fluid'], 2, 15, 'recent', ['2610.00001'], options);
  assert.deepEqual(asked, [{
    url: `${WORKER}/store/feed`,
    body: { categories: ['econ.EM'], page: 2, pageSize: 15, positiveIds: ['2610.00001'] },
  }]);
  // The engineering leaf has no arXiv category, so arXiv's text search keeps it.
  assert.deepEqual(live, [{ categories: ['mech.fluid'], start: 30 }]);
  assert.equal(papers[0].id, '2610.29600');
  assert.equal(papers[0].primaryCategory, 'econ.EM');
  assert.equal(papers[0].landingPageUrl, 'https://arxiv.org/abs/2610.29600');
  assert.equal(papers[0].publicationStatus, 'preprint');
  assert.equal(papers[1].id, 'live:mech.fluid');
});

test('a store that fails or has nothing for the page leaves the page to arXiv', async () => {
  for (const store of [async () => new Response('{}', { status: 503 }), answered([]), async () => { throw new TypeError('offline'); }]) {
    const { live, options } = harness({ store });
    const papers = await fetchStoreFeed(['econ.EM'], 0, 15, 'recent', [], options);
    assert.deepEqual(live, [{ categories: ['econ.EM'], start: 0 }]);
    assert.deepEqual(papers.map(paper => paper.id), ['live:econ.EM']);
  }
});

test('relevance order and a reader without a session ask arXiv without the store', async () => {
  for (const [queryMode, session] of [['relevance', true], ['recent', false]] as const) {
    const { live, asked, options } = harness({ store: answered([STORED]) });
    await fetchStoreFeed(['econ.EM'], 1, 15, queryMode, [], { ...options, hasSession: () => session });
    assert.deepEqual(asked, []);
    assert.deepEqual(live, [{ categories: ['econ.EM'], start: 15 }]);
  }
});
