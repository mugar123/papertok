import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRecommendationCache, getPaperRecommendations } from './semanticScholarService.js';

// The recommendations used to leave the browser for `api.semanticscholar.org`
// behind a module-variable limiter that did not even serialize: it read
// `lastRequestTime`, awaited, and only then wrote it, so concurrent callers all
// read the same stale value and fired together. They now go through `/related`.

test('turns the related papers from the Worker into arXiv identifiers', async () => {
  clearRecommendationCache();
  const asked = [];
  const ids = await getPaperRecommendations('2607.12345v3', {
    fetchRelated: async (paper, limit) => {
      asked.push({ paper, limit });
      return [
        { arxivId: '2601.00001' },
        { arxivId: null },
        { arxivId: '2602.00002' },
      ];
    },
  });

  assert.deepEqual(ids, ['2601.00001', '2602.00002']);
  // The version suffix is stripped before asking, so v2 and v3 of one paper are
  // one lookup rather than two.
  assert.deepEqual(asked, [{ paper: { arxivId: '2607.12345' }, limit: 20 }]);
});

test('does not reach Semantic Scholar directly when the route is unavailable', async () => {
  clearRecommendationCache();
  const escaped = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async input => {
    escaped.push(String(input?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.warn = () => {};
  try {
    // No injected dependency: the real path, which needs a Firebase session and a
    // configured Worker origin, neither of which exists here. It has to fail as a
    // missing recommendation, not by falling back to a keyless browser call.
    const ids = await getPaperRecommendations('2607.12345');
    assert.deepEqual(ids, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.deepEqual(escaped, [], `something still left the browser: ${escaped.join(', ')}`);
});

test('does not cache a failure as an empty recommendation set', async () => {
  clearRecommendationCache();
  let attempts = 0;
  const fetchRelated = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('route unavailable');
    return [{ arxivId: '2601.00001' }];
  };

  assert.deepEqual(await getPaperRecommendations('2607.12345', { fetchRelated }), []);
  assert.deepEqual(await getPaperRecommendations('2607.12345', { fetchRelated }), ['2601.00001']);
  assert.equal(attempts, 2);
});
