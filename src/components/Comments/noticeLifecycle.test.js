import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDLE_NOTICE,
  NOTICE_SUCCESS_MS,
  clearedNotice,
  expireNotice,
  nextNotice,
  noticeLifetime,
} from './noticeLifecycle.js';

test('every announcement gets a new sequence number, even the same words twice', () => {
  const first = nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' });
  const second = nextNotice(first, { tone: 'success', text: 'Posted.' });
  assert.deepEqual(first, { tone: 'success', text: 'Posted.', seq: 1 });
  assert.equal(second.seq, 2);
});

test('clearing keeps the sequence and is a no-op on an idle notice', () => {
  const shown = nextNotice(IDLE_NOTICE, { tone: 'error', text: 'Failed.' });
  assert.deepEqual(clearedNotice(shown), { tone: 'error', text: '', seq: 1 });
  assert.equal(clearedNotice(IDLE_NOTICE), IDLE_NOTICE, 'same object, so React skips the render');
});

test('only a success expires on its own', () => {
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' })), NOTICE_SUCCESS_MS);
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'error', text: 'Failed.' })), null);
  assert.equal(noticeLifetime(nextNotice(IDLE_NOTICE, { tone: 'status', text: 'Wait.' })), null);
  assert.equal(noticeLifetime(IDLE_NOTICE), null);
  assert.equal(NOTICE_SUCCESS_MS, 2400);
});

test('an expiry only clears the notice it was armed for', () => {
  const first = nextNotice(IDLE_NOTICE, { tone: 'success', text: 'Posted.' });
  const second = nextNotice(first, { tone: 'success', text: 'Saved.' });
  assert.equal(expireNotice(second, first.seq), second, 'a stale timer leaves the newer notice alone');
  assert.deepEqual(expireNotice(second, second.seq), { tone: 'success', text: '', seq: 2 });
});
