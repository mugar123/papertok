import assert from 'node:assert/strict';
import test from 'node:test';
import { explanationCacheKey, handleAIExplanation, normalizePaperForExplanation } from './ai-explanation.js';

test('AI explanation cache varies with every prompt-relevant paper field', async () => {
  const base = normalizePaperForExplanation({
    id: 'paper-1',
    title: 'A paper',
    abstract: 'A sufficiently useful abstract.',
    authors: [{ name: 'Ada' }],
    year: 2026,
    journal: 'Journal A',
    categories: ['physics'],
    concepts: [{ name: 'Cosmology' }],
  });
  const changed = { ...base, authors: ['Grace'] };
  const first = await explanationCacheKey(base, 'university', 'en', 'gemini', 'model');
  const second = await explanationCacheKey(changed, 'university', 'en', 'gemini', 'model');
  assert.notEqual(first.url, second.url);
});

/**
 * A body that arrives in pieces and declares no length: the shape that walks
 * straight past a `content-length` check.
 */
function chunked(bytes, size = 65_536) {
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.subarray(i, i + size));
      controller.close();
    },
  });
}

/** A signed-in caller without an Identity Toolkit round trip. */
async function withCachedIdentity(callback) {
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async request => (String(request.url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : null),
      put: async () => undefined,
    },
  };
  try {
    return await callback();
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

test('an oversized chunked explanation body is cut off, not buffered', { timeout: 10_000 }, async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    level: 'university',
    language: 'en',
    paper: { title: 'A paper', abstract: 'x'.repeat(120_000) },
  }));
  const request = new Request('https://papertok-report-api.example/ai/explain', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: chunked(bytes),
    duplex: 'half',
  });

  // No `content-length` at all, so the header check has nothing to refuse on and
  // the cap has to be enforced against the bytes as they land.
  await withCachedIdentity(() => assert.rejects(
    handleAIExplanation(request, { FIREBASE_WEB_API_KEY: 'firebase-test-key', GEMINI_API_KEY: 'gemini-test-key' }),
    error => error.code === 'AI_REQUEST_TOO_LARGE' && error.status === 413,
  ));
});
