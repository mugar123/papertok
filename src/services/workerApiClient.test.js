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

// `/sources/pubmed` and `/sources/s2` do not go through `domainSourceService`'s
// `fetchJson`, so keeping the Worker's body had to be done twice. PubMed is the
// route that needs it most: NCBI refusing us and our own quota ledger refusing us
// both arrive as an HTTP 429, and `code` is the only thing that tells them apart
// from a browser -- `UPSTREAM_RATE_LIMITED` here, `PROVIDER_RATE_LIMITED` there.
test('a refused source route keeps the Worker body on the error, not just its status', async () => {
  await assert.rejects(
    () => fetchWorkerSourceJson('/sources/pubmed', { q: 'malaria' }, {
      apiBase: WORKER,
      fetchImpl: async () => new Response(
        '{"error":"Specialist source unavailable","code":"UPSTREAM_RATE_LIMITED","upstreamStatus":429}',
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    }),
    error => {
      assert.equal(error.status, 429);
      assert.equal(error.code, 'UPSTREAM_RATE_LIMITED');
      assert.equal(error.upstreamStatus, 429);
      // Both halves of the body reach a log that only prints the message.
      assert.equal(error.message, '/sources/pubmed returned 429 (UPSTREAM_RATE_LIMITED, upstream 429)');
      return true;
    },
  );
});

test('an error body that is not JSON leaves the error exactly as the bare status', async () => {
  await assert.rejects(
    () => fetchWorkerSourceJson('/sources/pubmed', { q: 'malaria' }, {
      apiBase: WORKER,
      fetchImpl: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    }),
    error => {
      assert.equal(error.status, 502);
      assert.equal(error.code, undefined);
      assert.equal(error.upstreamStatus, undefined);
      assert.equal(error.message, '/sources/pubmed returned 502');
      return true;
    },
  );
});
