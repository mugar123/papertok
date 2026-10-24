import type { TestGlobals } from './test-types.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyFirebaseAccount } from './ai-explanation.ts';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';

/* ============================================================
   What an auth failure is actually saying
   ============================================================ */

/** A cold identity cache: every token has to be asked about. */
async function withColdIdentity<Result>(callback: () => Promise<Result>) {
  const originalCaches = (globalThis as TestGlobals).caches;
  const originalFetch = globalThis.fetch;
  (globalThis as TestGlobals).caches = { default: { match: async (): Promise<Response | null | undefined> => null, put: async (): Promise<unknown> => undefined } };
  globalThis.fetch = async () => { throw new Error('identitytoolkit is unreachable'); };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
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
    error => (error as { code: string; status: number }).code === 'AI_UNAVAILABLE' && (error as { code: string; status: number }).status === 503,
  ));
});

test('a worker with no Firebase key really is not configured', async () => {
  await withColdIdentity(() => assert.rejects(
    verifyFirebaseAccount(authRequest(), {}),
    error => (error as { code: string; status: number }).code === 'AI_NOT_CONFIGURED' && (error as { code: string; status: number }).status === 503,
  ));
});

test('a token Google rejects is still the reader signing in again', async () => {
  await withColdIdentity(() => assert.rejects(
    verifyFirebaseAccount(
      new Request('https://papertok-report-api.example/ai/rewrite', { method: 'POST' }),
      { FIREBASE_WEB_API_KEY: 'firebase-test-key' },
    ),
    error => (error as { code: string; status: number }).code === 'AI_AUTH_REQUIRED' && (error as { code: string; status: number }).status === 401,
  ));
});
