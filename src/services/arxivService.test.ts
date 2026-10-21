import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import {
  ARXIV_ROUTE_TIMEOUT_MS,
  arxivUnreachableError,
  buildAuthorQuery,
  buildSearchQuery,
  clearCache,
  fetchPapers,
  noteLabelSearchCategories,
} from './arxivService.ts';
import type { Paper } from '../models/Paper.ts';
import { scorePaperForRecommendation } from '../utils/recommendationEngine.ts';

test('an ID lookup requests every result in an abstract-recovery batch instead of the default ten', async () => {
  const source = await readFile(new URL('./arxivService.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function fetchPapersByIds(');
  const end = source.indexOf('\n/**', start);
  const callback = stripTypeScriptTypes(source.slice(start, end).replace('export ', ''));
  const requests: string[] = [];
  const fetchByIds = new Function('isDev', 'ARXIV_DEV', 'ARXIV_PROD', 'cache', 'CACHE_TTL', 'fetchArxivData',
    `${callback}\nreturn fetchPapersByIds;`)(false, '/api/arxiv', 'https://export.arxiv.org/api/query', new Map(), 300000,
    async (url: string) => { requests.push(url); return []; });
  const ids = Array.from({ length: 15 }, (_, i) => `2101.${10000 + i}`);
  await fetchByIds(ids);
  const params = new URL(requests[0]).searchParams;
  assert.equal(params.get('id_list'), ids.join(','));
  assert.equal(params.get('max_results'), '15');
});

// Under node the module sees no import.meta.env, so neither the Worker route nor
// the dev proxy is configured -- exactly the state in which the dead corsproxy.io
// and allorigins cascade used to run. It has to fail without calling anything.
test('fails without reaching for a third-party proxy when no arXiv route exists', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const requested: unknown[] = [];
  globalThis.fetch = (input) => {
    requested.push(String((input as Request)?.url || input));
    return Promise.resolve(new Response('', { status: 200 }));
  };
  console.error = () => {};

  try {
    clearCache();
    await assert.rejects(
      fetchPapers(['cs.AI'], 0, 5),
      /Could not reach arXiv/,
    );
    assert.deepEqual(requested, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    clearCache();
  }
});

test('keeps an exact arXiv subcategory selected by the user', () => {
  const [paper] = noteLabelSearchCategories([{
    id: 'paper-1',
    title: 'Optical trapping',
    abstract: 'A physics experiment.',
    primaryCategory: 'physics.optics',
    categories: ['physics.optics', 'quant-ph'],
    allCategories: ['physics.optics', 'quant-ph'],
  }], ['physics.optics', 'quant-ph']);

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
});

// mech.* categories are not arXiv's, so they are fetched with `all:"label"`
// searches. The record has the parser's shape: every parsed entry carries a primary.
test('a paper found by a label search keeps arXiv\'s own primary category', () => {
  const [paper] = noteLabelSearchCategories([{
    id: 'paper-2',
    title: 'Robotics for autonomous vehicles',
    abstract: 'A dynamics method for robotic control.',
    primaryCategory: 'cs.RO',
    categories: ['cs.RO'],
    allCategories: ['cs.RO'],
  }], ['mech.fluid', 'mech.dyn']);

  assert.equal(paper.primaryCategory, 'cs.RO');
  assert.deepEqual(paper.allCategories, ['cs.RO']);
});

// arXiv files a "Fluid Mechanics" match under its own categories, so nothing on
// the paper names the mech.fluid the reader chose. Before PAP-64 the request was
// written onto it as its primary, which is how it earned the reader's preference.
test('a paper found by a label search ranks for the reader category that found it', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const preference = (paper: Partial<Paper>, userPreferences: string[]) => (
    scorePaperForRecommendation(paper, { now, userPreferences }).preference
  );
  const [found, crossListed] = noteLabelSearchCategories([{
    id: '2610.01234',
    title: 'Wall-bounded turbulence at high Reynolds number',
    primaryCategory: 'physics.flu-dyn',
    categories: ['physics.flu-dyn'],
    allCategories: ['physics.flu-dyn'],
    published: '2026-10-01T00:00:00Z',
  }, {
    id: '2610.05678',
    title: 'Agents that learn to plan',
    primaryCategory: 'cs.AI',
    categories: ['cs.AI', 'cs.LG'],
    allCategories: ['cs.AI', 'cs.LG'],
    published: '2026-10-01T00:00:00Z',
  }], ['mech.fluid', 'cs.LG']);

  assert.equal(found.primaryCategory, 'physics.flu-dyn');
  assert.deepEqual(found.allCategories, ['physics.flu-dyn']);
  assert.equal(preference(found, ['mech.fluid']), 100);
  assert.equal(preference(found, ['cs.LG']), 0, 'a label match is not a cs.LG paper');
  // The cs.LG clause found this one, and arXiv's cross-list already ranks it.
  assert.equal(preference(crossListed, ['mech.fluid', 'cs.LG']), 80);
});

// A quote inside the phrase used to close arXiv's quoted term early, which is
// answered with an empty or wrong result set rather than an error.
test('keeps the arXiv phrase quotes balanced whatever the user typed', () => {
  assert.equal(buildAuthorQuery('Ada "Countess" Lovelace'), 'au:"Ada Countess Lovelace"');
  assert.equal(buildSearchQuery('  "quantum" error correction  '), 'all:"quantum error correction"');
  assert.equal((buildAuthorQuery('A" OR au:B').match(/"/g) || []).length, 2);
  assert.equal((buildSearchQuery('a"b"c').match(/"/g) || []).length, 2);
});

// The Worker gives arXiv five seconds (ARXIV_UPSTREAM_TIMEOUT_MS in
// worker/arxiv-api.ts). A client deadline under that gives up before the
// Worker can answer at all, so a slow query could never succeed — measured
// 2026-09-15/16: `sortBy=relevance` answered 502 at 5.07 s, and the client had
// left at 4 s.
test('the Worker route is given longer than the Worker gives arXiv', async () => {
  const worker = await readFile(new URL('../../worker/arxiv-api.ts', import.meta.url), 'utf8');
  const upstream = Number(worker.match(/const ARXIV_UPSTREAM_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(upstream) && upstream > 0, 'the Worker declares its arXiv deadline');
  assert.ok(ARXIV_ROUTE_TIMEOUT_MS > upstream, `client ${ARXIV_ROUTE_TIMEOUT_MS} ms must exceed the Worker's ${upstream} ms`);
});

// The lane (arxivRequestQueue.js) pauses on a 429 by reading `status` off the
// error the route threw. `fetchArxivDataNow` catches that error and throws a
// fresh one -- measured 2026-09-16 on the paced Worker: the tab sent a second
// request 420 ms after the first 429, because the fresh error carried nothing.
test('the error the route ends in keeps the status and retry-after of the refusal behind it', () => {
  const refusal = Object.assign(new Error('PaperTok arXiv API error: 429'), { status: 429, retryAfterMs: 4_000 });
  const error = arxivUnreachableError(refusal);
  assert.match(error.message, /Could not reach arXiv/);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 4_000);
  assert.equal(error.cause, refusal);

  const outage = arxivUnreachableError(new Error('PaperTok arXiv API error: 502'));
  assert.equal(outage.status, undefined);
  assert.equal(outage.retryAfterMs, undefined);
});
