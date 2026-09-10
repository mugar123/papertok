import assert from 'node:assert/strict';
import test from 'node:test';
import { explanationCacheKey, handleAIExplanation, normalizePaperForExplanation, verifyFirebaseAccount } from './ai-explanation.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

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

/* ============================================================
   What an auth failure is actually saying
   ============================================================ */

/** A cold identity cache: every token has to be asked about. */
async function withColdIdentity(callback) {
  const originalCaches = globalThis.caches;
  const originalFetch = globalThis.fetch;
  globalThis.caches = { default: { match: async () => null, put: async () => undefined } };
  globalThis.fetch = async () => { throw new Error('identitytoolkit is unreachable'); };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

const authRequest = () => new Request('https://papertok-report-api.example/ai/rewrite', {
  method: 'POST',
  headers: { authorization: `Bearer ${fakeIdToken()}` },
});

/**
 * Both of Identity Toolkit's 503s used to arrive as `AI_NOT_CONFIGURED`, and the
 * reader's copy for that code says the feature is not switched on here — final,
 * no retry button. Google being briefly unreachable is the opposite of final,
 * and every protected route sits behind this verifier, so an outage read as
 * "never coming" for as long as it lasted.
 */
test('an Identity Toolkit outage is AI_UNAVAILABLE, not "not configured"', async () => {
  await withColdIdentity(() => assert.rejects(
    verifyFirebaseAccount(authRequest(), { FIREBASE_WEB_API_KEY: 'firebase-test-key' }),
    error => error.code === 'AI_UNAVAILABLE' && error.status === 503,
  ));
});

test('a worker with no Firebase key really is not configured', async () => {
  await withColdIdentity(() => assert.rejects(
    verifyFirebaseAccount(authRequest(), {}),
    error => error.code === 'AI_NOT_CONFIGURED' && error.status === 503,
  ));
});

test('a token Google rejects is still the reader signing in again', async () => {
  await withColdIdentity(() => assert.rejects(
    verifyFirebaseAccount(
      new Request('https://papertok-report-api.example/ai/rewrite', { method: 'POST' }),
      { FIREBASE_WEB_API_KEY: 'firebase-test-key' },
    ),
    error => error.code === 'AI_AUTH_REQUIRED' && error.status === 401,
  ));
});
