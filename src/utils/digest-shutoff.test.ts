import test from 'node:test';
import assert from 'node:assert/strict';
import { digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from './digest-shutoff.ts';

const base = { enabled: true, followsConfirmed: true, interestsConfirmed: true, digestCovered: false, attempted: false };

test('a digest left with no follow it covers and no chosen categories is turned off, once', () => {
  assert.equal(digestShutoffDue(base), true);
  assert.equal(digestShutoffDue({ ...base, attempted: true }), false);
});

test('an unconfirmed read (failed, cached or mid-write) never turns the digest off', () => {
  assert.equal(digestShutoffDue({ ...base, followsConfirmed: false }), false);
});

test('a cached profile with no chosen categories, before the server copy arrives, never turns the digest off', () => {
  assert.equal(digestShutoffDue({ ...base, interestsConfirmed: false }), false);
});

test('a cached empty follow list never lets the sync replace the follows the Worker stores', () => {
  assert.equal(digestSyncAllowed({ hasFollows: false, followsConfirmed: false }), false);
  assert.equal(digestSyncAllowed({ hasFollows: false, followsConfirmed: true }), true);
  assert.equal(digestSyncAllowed({ hasFollows: true, followsConfirmed: false }), true);
});

test('a digest that is off, or one with follows or chosen categories to cover, is left alone', () => {
  assert.equal(digestShutoffDue({ ...base, enabled: false }), false);
  assert.equal(digestShutoffDue({ ...base, digestCovered: true }), false);
});

test('the turned-off notice belongs to the account that was shut off, and ends once there is something to cover or the digest is back on', () => {
  const shown = { turnedOffFor: 'a', userId: 'a', enabled: false, digestCovered: false };
  assert.equal(digestShutoffNoticeShown(shown), true);
  assert.equal(digestShutoffNoticeShown({ ...shown, userId: 'b' }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, userId: null }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, enabled: true }), false);
  assert.equal(digestShutoffNoticeShown({ ...shown, digestCovered: true }), false);
});
