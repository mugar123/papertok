import type { TestGlobals } from './test-types.ts';
import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRelated } from './semantic-scholar.ts';

const ORIGIN = 'http://localhost:5173';
// The ledger that the quota and pace gates reserve against, accepting everything.
const ENV = {
  REQUEST_QUOTA_LEDGER: {
    idFromName: () => 'quota-id',
    get: () => ({ fetch: async () => new Response(JSON.stringify({ accepted: true })) }),
  } as unknown as WorkerEnv['REQUEST_QUOTA_LEDGER'],
} as WorkerEnv;

async function askRelated(upstreamStatus: number) {
  const puts: Response[] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as TestGlobals).caches;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Paper not found' }), {
    status: upstreamStatus,
    headers: { 'content-type': 'application/json' },
  });
  (globalThis as TestGlobals).caches = {
    default: {
      match: async (): Promise<Response | null | undefined> => null,
      put: async (_key, response): Promise<void> => { puts.push(response); },
    },
  };
  try {
    const request = new Request('https://api.papertok.test/related?paper_id=DOI:10.1002/smtd.71013', { headers: { origin: ORIGIN } });
    return { response: await handleRelated(request, ENV, { uid: 'reader' }), puts };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
  }
}

test('a paper Semantic Scholar has not indexed has no recommendations, not a failure', async () => {
  const { response, puts } = await askRelated(404);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recommendedPapers: [], code: 'PAPER_NOT_INDEXED' });
  assert.match(response.headers.get('cache-control') ?? '', /s-maxage=3600\b/, 'kept an hour, not a day: it may be indexed tomorrow');
  assert.equal(puts.length, 1, 'cached, so a second reader does not spend quota on the same 404');
});

test('any other upstream failure still fails', async () => {
  await assert.rejects(askRelated(500), (error) => (error as UpstreamError).status === 500);
});
