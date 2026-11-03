import test from 'node:test';
import assert from 'node:assert/strict';
import { digestShutoffDue, digestShutoffNoticeShown } from './digest-shutoff.ts';

const base = { enabled: true, followsConfirmed: true, hasDigestFollows: false, attempted: false };

test('the last digest follow removed with the digest on turns it off, once', () => {
  assert.equal(digestShutoffDue(base), true);
  assert.equal(digestShutoffDue({ ...base, attempted: true }), false);
});

test('an unconfirmed follows read (failed, cached or mid-write) never turns the digest off', () => {
  assert.equal(digestShutoffDue({ ...base, followsConfirmed: false }), false);
});

test('the turned-off notice belongs to the account that was shut off, and ends with a follow or the digest back on', () => {
  const shown = { turnedOffFor: 'a', userId: 'a', enabled: false, hasDigestFollows: false };
  assert.equal(digestShutoffNoticeShown(shown), true);
  assert.equal(digestShutoffNoticeShown({ ...shown, userId: 'b' }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, userId: null }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, enabled: true }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, hasDigestFollows: true }), false);
});

test('a digest that is off, or one that still has a follow to cover, is left alone', () => {
  assert.equal(digestShutoffDue({ ...base, enabled: false }), false);
  assert.equal(digestShutoffDue({ ...base, hasDigestFollows: true }), false);
});
