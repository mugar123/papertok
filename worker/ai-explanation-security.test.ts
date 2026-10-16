import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyFirebaseAccount } from './ai-explanation.ts';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

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
