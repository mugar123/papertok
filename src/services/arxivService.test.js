import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ARXIV_ROUTE_TIMEOUT_MS,
  arxivUnreachableError,
  assignRequestedCategories,
  buildAuthorQuery,
  buildSearchQuery,
  clearCache,
  fetchPapers,
} from './arxivService.js';

// Under node the module sees no import.meta.env, so neither the Worker route nor
// the dev proxy is configured -- exactly the state in which the dead corsproxy.io
// and allorigins cascade used to run. It has to fail without calling anything.
test('fails without reaching for a third-party proxy when no arXiv route exists', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const requested = [];
  globalThis.fetch = (input) => {
    requested.push(String(input?.url || input));
    return Promise.resolve(new Response('', { status: 200 }));
  };
  console.error = () => {};

  try {
    clearCache();
    await assert.rejects(
      fetchPapers(['cs.AI'], 0, 5),
      /No se pudo conectar con arXiv/,
    );
    assert.deepEqual(requested, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    clearCache();
  }
});

test('keeps an exact arXiv subcategory selected by the user', () => {
  const [paper] = assignRequestedCategories([{
    id: 'paper-1',
    title: 'Optical trapping',
    abstract: 'A physics experiment.',
    primaryCategory: 'physics.optics',
    categories: ['physics.optics', 'quant-ph'],
  }], ['physics.optics', 'quant-ph']);

  assert.equal(paper.primaryCategory, 'physics.optics');
  assert.deepEqual(paper.allCategories, ['physics.optics', 'quant-ph']);
});

test('maps keyword-search papers back to the most relevant requested subcategory', () => {
  const [paper] = assignRequestedCategories([{
    id: 'paper-2',
    title: 'Robotics for autonomous vehicles',
    abstract: 'A dynamics method for robotic control.',
    categories: ['cs.RO'],
  }], ['mech.fluid', 'mech.dyn']);

  assert.equal(paper.primaryCategory, 'mech.dyn');
  assert.ok(paper.allCategories.includes('cs.RO'));
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
// worker/report-api.js). A client deadline under that gives up before the
// Worker can answer at all, so a slow query could never succeed — measured
// 2026-09-15/16: `sortBy=relevance` answered 502 at 5.07 s, and the client had
// left at 4 s.
test('the Worker route is given longer than the Worker gives arXiv', async () => {
  const worker = await readFile(new URL('../../worker/report-api.js', import.meta.url), 'utf8');
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
  assert.match(error.message, /No se pudo conectar con arXiv/);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 4_000);
  assert.equal(error.cause, refusal);

  const outage = arxivUnreachableError(new Error('PaperTok arXiv API error: 502'));
  assert.equal(outage.status, undefined);
  assert.equal(outage.retryAfterMs, undefined);
});
