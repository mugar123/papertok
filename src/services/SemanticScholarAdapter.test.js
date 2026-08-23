import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticScholarAdapter } from './adapters/SemanticScholarAdapter.js';

// This adapter reached `api.semanticscholar.org` with a bare `fetch(url)` -- no
// key, no signal -- and a three-attempt backoff of its own, which every open tab
// ran independently against a limit Semantic Scholar counts per provider. The
// author pages that use it are public, so guests ran it too.

function silencedGlobalFetch(recorded) {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = async input => {
    recorded.push(String(input?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.error = () => {};
  return () => {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  };
}

test('searches Semantic Scholar through the Worker route', async () => {
  const escaped = [];
  const workerCalls = [];
  const restore = silencedGlobalFetch(escaped);
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        workerCalls.push(String(url));
        return new Response(JSON.stringify({
          total: 7,
          data: [{ paperId: 'abc', title: 'One', authors: [], publicationTypes: [] }],
        }), { headers: { 'content-type': 'application/json' } });
      },
    });

    const result = await adapter.search('Ada Lovelace', 3, { type: 'author' });

    assert.equal(result.total, 7);
    assert.equal(result.papers.length, 1);
    const requested = new URL(workerCalls[0]);
    assert.equal(requested.pathname, '/sources/s2');
    assert.equal(requested.searchParams.get('q'), 'Ada Lovelace');
    assert.equal(requested.searchParams.get('page'), '3');
  } finally {
    restore();
  }

  assert.deepEqual(
    escaped.filter(url => url.includes('api.semanticscholar.org')),
    [],
    'Semantic Scholar was still called directly from the browser',
  );
});

test('gives up on an unavailable Semantic Scholar instead of retrying locally', async () => {
  const escaped = [];
  const restore = silencedGlobalFetch(escaped);
  let workerCalls = 0;
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async () => {
        workerCalls += 1;
        return new Response(JSON.stringify({ code: 'PROVIDER_RATE_LIMITED' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '60' },
        });
      },
    });

    const result = await adapter.search('Ada Lovelace', 1);

    assert.deepEqual(result, { papers: [], total: 0 });
    // One attempt, not three. The retry belongs behind the shared ceiling, where
    // there is one counter; here it only multiplied the pressure that caused the
    // refusal in the first place.
    assert.equal(workerCalls, 1);
  } finally {
    restore();
  }
});
