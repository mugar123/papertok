import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticRetry, emptyFirstPageError, feedFailureEventStep, feedLoadFailure, feedLoadOutcome } from './feed-load-failure.ts';
import { FEED_EMPTY } from '../utils/feed-loading-state.ts';
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

test('no papers for the reader\'s interests is an empty state that does not retry; a failed request is an error that does', () => {
  assert.deepEqual(feedLoadOutcome(emptyFirstPageError()), { error: FEED_EMPTY, autoRetry: false });
  assert.deepEqual(feedLoadOutcome(refused(503, 'PAPER_STORE_UNAVAILABLE')), { error: 'FEED_LOAD_FAILED', autoRetry: true });
  assert.deepEqual(feedLoadOutcome(new DOMException('The operation timed out.', 'TimeoutError')), { error: 'FEED_LOAD_FAILED', autoRetry: true });
});

test('only a first screen that timed out retries at once, without its long wait; every other failure keeps the pause', () => {
  const timedOut = new DOMException('The operation timed out.', 'TimeoutError');
  const atOnce = { pauseMs: 0, retriesTimeout: true };
  const paused = { pauseMs: 2_500, retriesTimeout: false };
  assert.deepEqual(automaticRetry(timedOut, true), atOnce);
  assert.deepEqual(automaticRetry(new DOMException('The operation was aborted.', 'AbortError'), true), atOnce);
  assert.deepEqual(automaticRetry(timedOut, false), paused, 'a refresh or a follow change over shown cards');
  assert.deepEqual(automaticRetry(refused(503, 'PAPER_STORE_UNAVAILABLE'), true), paused);
  assert.deepEqual(automaticRetry(Object.assign(new Error('unreachable'), { code: 'STORE_UNREACHABLE' }), true), paused);
  assert.deepEqual(automaticRetry(Object.assign(new Error('offline'), { code: 'auth/network-request-failed' }), true), paused);
});

test('a build with no allowed Worker origin is not a session failure, and keeps its code', () => {
  assert.deepEqual(feedLoadFailure(new WorkerApiAuthError('WORKER_ORIGIN_NOT_ALLOWED')), { reason: 'unexpected', code: 'WORKER_ORIGIN_NOT_ALLOWED' });
  assert.deepEqual(feedLoadFailure(new WorkerApiAuthError('WORKER_AUTH_REQUIRED')), { reason: 'session', code: 'WORKER_AUTH_REQUIRED' });
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

const serverDown = { kind: 'feed_load_failed', reason: 'server', status: 503, error_code: 'AUTH_UNAVAILABLE' };
const failed = { feedVisible: true, error: 'FEED_LOAD_FAILED' };
const nothing = { send: null, hold: null };

test('a failed load on /feed with no card sends its event at once, and only once', () => {
  const first = feedFailureEventStep(null, { kind: 'load_failed', failure: refused(503, 'AUTH_UNAVAILABLE'), screen: { ...failed, shownPapers: 0 } });
  assert.deepEqual(first, { send: serverDown, hold: null });
  // The error state re-renders: nothing more is sent.
  assert.deepEqual(feedFailureEventStep(first.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 0 } }), nothing);
});

test('a failed load behind a remaining card holds its event until the last card is dismissed, then sends it once', () => {
  const held = feedFailureEventStep(null, { kind: 'load_failed', failure: refused(503, 'AUTH_UNAVAILABLE'), screen: { ...failed, shownPapers: 1 } });
  assert.deepEqual(held, { send: null, hold: serverDown });
  // Another render with the card still there keeps it held.
  const still = feedFailureEventStep(held.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 1 } });
  assert.deepEqual(still, held);
  const dismissed = feedFailureEventStep(still.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 0 } });
  assert.deepEqual(dismissed, { send: serverDown, hold: null });
  assert.deepEqual(feedFailureEventStep(dismissed.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 0 } }), nothing);
});

test('a failed load off /feed holds its event until the reader returns and still sees the error', () => {
  const held = feedFailureEventStep(null, { kind: 'load_failed', failure: refused(503, 'AUTH_UNAVAILABLE'), screen: { ...failed, feedVisible: false, shownPapers: 0 } });
  assert.deepEqual(held, { send: null, hold: serverDown });
  assert.deepEqual(feedFailureEventStep(held.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 0 } }), { send: serverDown, hold: null });
  // Back on /feed with cards that arrived meanwhile: still hidden, still held.
  assert.deepEqual(feedFailureEventStep(held.hold, { kind: 'screen_changed', screen: { ...failed, shownPapers: 2 } }), held);
});

test('a new load drops the event a previous failure still held, so a success never sends it later', () => {
  const held = feedFailureEventStep(null, { kind: 'load_failed', failure: refused(503, 'AUTH_UNAVAILABLE'), screen: { ...failed, shownPapers: 1 } });
  const started = feedFailureEventStep(held.hold, { kind: 'load_started' });
  assert.deepEqual(started, nothing);
  // The new load succeeds and the reader dismisses every card: no event.
  assert.deepEqual(feedFailureEventStep(started.hold, { kind: 'screen_changed', screen: { feedVisible: true, error: null, shownPapers: 0 } }), nothing);
});
