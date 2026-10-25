import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFirstPageError, feedErrorOnScreen, feedLoadFailedEvent, feedLoadFailure } from './feed-load-failure.ts';
import { WorkerApiAuthError, sourceResponseError } from '../services/worker-api-client.ts';

const refused = (status: number, code?: string) => sourceResponseError('/store/papers', status, code ? { code } : null);

test('a failed feed load keeps why it failed: deadline, network, session, HTTP refusal, server, bad answer or no papers', () => {
  assert.deepEqual(feedLoadFailure(new DOMException('The operation timed out.', 'TimeoutError')), { reason: 'timeout' });
  assert.deepEqual(feedLoadFailure(Object.assign(new Error('unreachable'), { code: 'STORE_UNREACHABLE' })), { reason: 'network', code: 'STORE_UNREACHABLE' });
  assert.deepEqual(feedLoadFailure(new WorkerApiAuthError()), { reason: 'session', code: 'WORKER_AUTH_REQUIRED' });
  assert.deepEqual(feedLoadFailure(refused(401, 'AUTH_REQUIRED')), { reason: 'auth', status: 401, code: 'AUTH_REQUIRED' });
  assert.deepEqual(feedLoadFailure(refused(429, 'RATE_LIMITED')), { reason: 'rate_limited', status: 429, code: 'RATE_LIMITED' });
  assert.deepEqual(feedLoadFailure(refused(400, 'LANES_REQUIRED')), { reason: 'rejected', status: 400, code: 'LANES_REQUIRED' });
  assert.deepEqual(feedLoadFailure(refused(503, 'AUTH_UNAVAILABLE')), { reason: 'server', status: 503, code: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(feedLoadFailure(refused(502)), { reason: 'server', status: 502 });
  assert.deepEqual(feedLoadFailure(Object.assign(new Error('no list'), { code: 'STORE_RESPONSE_INVALID' })), { reason: 'invalid_response', code: 'STORE_RESPONSE_INVALID' });
  assert.deepEqual(feedLoadFailure(new SyntaxError('Unexpected token <')), { reason: 'invalid_response' });
  assert.deepEqual(feedLoadFailure(emptyFirstPageError()), { reason: 'empty' });
  assert.deepEqual(feedLoadFailure(new Error('something else')), { reason: 'unexpected' });
  assert.deepEqual(feedLoadFailure('a string'), { reason: 'unexpected' });
});

test('a TypeError thrown by our own code is not a network failure', () => {
  assert.deepEqual(feedLoadFailure(new TypeError("Cannot read properties of undefined (reading 'id')")), { reason: 'unexpected' });
});

test('a failed Firebase token keeps its code: offline is network, throttled is rate_limited, any other auth failure is session', () => {
  const firebase = (code: string) => Object.assign(new Error(`Firebase: Error (${code}).`), { name: 'FirebaseError', code });
  assert.deepEqual(feedLoadFailure(firebase('auth/network-request-failed')), { reason: 'network', code: 'auth/network-request-failed' });
  assert.deepEqual(feedLoadFailure(firebase('auth/too-many-requests')), { reason: 'rate_limited', code: 'auth/too-many-requests' });
  assert.deepEqual(feedLoadFailure(firebase('auth/user-token-expired')), { reason: 'session', code: 'auth/user-token-expired' });
});

test('a failed load owes an event only while no card hides the error', () => {
  const failure = refused(503, 'AUTH_UNAVAILABLE');
  assert.deepEqual(feedLoadFailedEvent(failure, 0), {
    kind: 'feed_load_failed', reason: 'server', status: 503, error_code: 'AUTH_UNAVAILABLE',
  });
  assert.equal(feedLoadFailedEvent(failure, 3), null);
});

test('the error is on screen only on /feed, with the error still set and no cards', () => {
  const base = { feedVisible: true, error: 'FEED_LOAD_FAILED', shownPapers: 0 };
  assert.equal(feedErrorOnScreen(base), true);
  // The reader is on another page: the failure is held, not lost.
  assert.equal(feedErrorOnScreen({ ...base, feedVisible: false }), false);
  // A new load cleared the error, or cards arrived.
  assert.equal(feedErrorOnScreen({ ...base, error: null }), false);
  assert.equal(feedErrorOnScreen({ ...base, shownPapers: 3 }), false);
});
