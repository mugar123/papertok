import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerApiAuthError, fetchWorkerSourceJson, workerSourceUrl } from './workerApiClient.js';

const WORKER = 'https://papertok-report-api.example';

test('builds a source URL and drops parameters that carry no value', () => {
  const url = new URL(workerSourceUrl('/sources/pubmed', {
    q: 'malaria',
    page: 2,
    limit: 25,
    sort: '',
    cursor: undefined,
    after: null,
  }, WORKER));

  assert.equal(url.pathname, '/sources/pubmed');
  assert.equal(url.searchParams.get('q'), 'malaria');
  assert.equal(url.searchParams.get('page'), '2');
  // An empty parameter is not the same as a parameter set to the empty string:
  // sent, it would fork the Worker's cache key over an input nobody chose.
  assert.equal(url.searchParams.has('sort'), false);
  assert.equal(url.searchParams.has('cursor'), false);
  assert.equal(url.searchParams.has('after'), false);
});

test('refuses to build a URL when no Worker origin is configured', () => {
  assert.equal(workerSourceUrl('/sources/pubmed', { q: 'malaria' }, ''), '');
});

test('fails as an origin problem rather than fetching something unvalidated', async () => {
  let called = false;
  await assert.rejects(
    () => fetchWorkerSourceJson('/sources/pubmed', { q: 'malaria' }, {
      apiBase: '',
      fetchImpl: async () => { called = true; return new Response('{}'); },
    }),
    error => error instanceof WorkerApiAuthError && error.code === 'WORKER_ORIGIN_NOT_ALLOWED',
  );
  assert.equal(called, false);
});

test('bounds the request and rejects a non-200 rather than parsing it', async () => {
  let seenSignal;
  await fetchWorkerSourceJson('/sources/s2', { q: 'malaria' }, {
    apiBase: WORKER,
    fetchImpl: async (_url, options) => {
      seenSignal = options?.signal;
      return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.ok(seenSignal, 'the Worker request carries no AbortSignal');
  assert.equal(seenSignal.aborted, false);

  await assert.rejects(
    () => fetchWorkerSourceJson('/sources/s2', { q: 'malaria' }, {
      apiBase: WORKER,
      fetchImpl: async () => new Response('nope', { status: 502 }),
    }),
    /\/sources\/s2 returned 502/,
  );
});
