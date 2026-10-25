import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFirstPageError, feedLoadFailure } from './feed-load-failure.ts';
import { WorkerApiAuthError, sourceResponseError } from '../services/worker-api-client.ts';

const refused = (status: number, code?: string) => sourceResponseError('/store/papers', status, code ? { code } : null);

test('a failed feed load keeps why it failed: deadline, network, session, HTTP refusal, server, bad answer or no papers', () => {
  assert.deepEqual(feedLoadFailure(new DOMException('The operation timed out.', 'TimeoutError')), { reason: 'timeout' });
  assert.deepEqual(feedLoadFailure(new TypeError('Failed to fetch')), { reason: 'network' });
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
