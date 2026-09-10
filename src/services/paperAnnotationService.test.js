import assert from 'node:assert/strict';
import test from 'node:test';
import { canAnnotatePassage, PaperAnnotationError, toAnnotationError } from './paperAnnotationService.js';
import { WorkerApiAuthError } from './workerApiClient.js';

test('a selection too short to identify a passage is refused before the request', () => {
  assert.equal(canAnnotatePassage('short'), false);
  assert.equal(canAnnotatePassage('long enough to point at something'), true);
});

/**
 * The rail borrows the reader's error vocabulary, so the same mistake costs the
 * same thing here: a session that expired inside `getIdToken` never reaches the
 * worker, and calling it «no se ha podido explicar este pasaje» sends the reader
 * to press the button again instead of to sign in.
 */
test('an expired Firebase session maps to AI_AUTH_REQUIRED', () => {
  assert.equal(
    toAnnotationError({ name: 'FirebaseError', code: 'auth/user-token-expired' }).code,
    'AI_AUTH_REQUIRED',
  );
  assert.equal(toAnnotationError(new WorkerApiAuthError()).code, 'AI_AUTH_REQUIRED');
});

test('an error the worker already named keeps its name', () => {
  const named = new PaperAnnotationError('AI_QUOTA_EXHAUSTED');
  assert.equal(toAnnotationError(named), named);
  assert.equal(toAnnotationError({ name: 'AbortError' }).code, 'AI_TIMEOUT');
  assert.equal(toAnnotationError({ name: 'AbortError' }, { cancelled: true }).code, 'AI_CANCELLED');
  assert.equal(toAnnotationError(new TypeError('Failed to fetch')).code, 'AI_UNAVAILABLE');
});
