import test from 'node:test';
import assert from 'node:assert/strict';
import { digestInterestsToSend, digestOptInStep, digestOptInWaitsForFollow, digestProfileInterests, digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from './digest-shutoff.ts';

const base = { enabled: true, followsConfirmed: true, interestsConfirmed: true, digestCovered: false, attempted: false };

test('the live profile gives the digest its chosen leaf categories, confirmed only when the server sent them', () => {
  const fromServer = digestProfileInterests({ preferences: ['cs.LG', 'not-a-category', 'cs.AI', 'cs.LG'] }, false);
  assert.deepEqual(fromServer, { interests: ['cs.AI', 'cs.LG'], confirmed: true });
  assert.deepEqual(digestProfileInterests({ selectedCategories: ['cs.AI'] }, false).interests, ['cs.AI']);
  assert.equal(digestProfileInterests({ preferences: ['cs.LG'] }, true).confirmed, false);
});

test('a profile the server says holds no categories is a confirmed none', () => {
  assert.deepEqual(digestProfileInterests(undefined, false), { interests: [], confirmed: true });
  assert.deepEqual(digestProfileInterests({ preferences: 'cs.LG' }, false), { interests: [], confirmed: true });
});

test('only categories from the server\'s copy of the profile are sent to the digest', () => {
  assert.deepEqual(digestInterestsToSend({ interests: ['cs.LG'], interestsConfirmed: true }), ['cs.LG']);
  assert.equal(digestInterestsToSend({ interests: ['cs.LG'], interestsConfirmed: false }), undefined);
});

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
  const state = { hasFollows: false, followsConfirmed: true, interestsConfirmed: true };
  assert.equal(digestSyncAllowed({ ...state, followsConfirmed: false }), false);
  assert.equal(digestSyncAllowed(state), true);
  assert.equal(digestSyncAllowed({ ...state, hasFollows: true, followsConfirmed: false, interestsConfirmed: false }), true);
});

test('with no follows, a digest is not sent until the profile read is confirmed, so the chosen categories go with it', () => {
  assert.equal(digestSyncAllowed({ hasFollows: false, followsConfirmed: true, interestsConfirmed: false }), false);
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

const BEFORE = '2026-11-24T12:00:00Z';
const AFTER = '2026-11-25T09:30:00Z';
const effectiveAt = '2026-11-25T00:00:00Z';
const optIn = {
  waitsForFollow: false,
  attempted: false,
  enabled: false,
  serviceDown: false,
  hasFollows: false,
  digestCovered: true,
  digestSendReady: true,
};

test('a yes from an account created before the email began from sign-up waits for the first follow; a newer one does not', () => {
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: BEFORE, effectiveAt }), true);
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: AFTER, effectiveAt }), false);
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: effectiveAt, effectiveAt }), false, 'created at the instant itself counts as new');
  assert.equal(digestOptInWaitsForFollow({ pending: false, accountCreated: BEFORE, effectiveAt }), false, 'nothing is pending without a yes');
});

test('an account whose creation time is unknown keeps the old promise', () => {
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: undefined, effectiveAt }), true);
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: 'not a date', effectiveAt }), true);
});

test('a new yes subscribes in the first session on the chosen topics, with no follow', () => {
  assert.equal(digestOptInStep(optIn), 'subscribe');
});

test('an old yes does not subscribe on chosen topics alone, and starts with its first follow', () => {
  assert.equal(digestOptInStep({ ...optIn, waitsForFollow: true }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, waitsForFollow: true, hasFollows: true }), 'subscribe');
});

test('a new yes waits until the topics are the server\'s own and something covers the digest', () => {
  assert.equal(digestOptInStep({ ...optIn, digestSendReady: false }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, digestCovered: false }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, serviceDown: true }), 'wait');
});

test('an attempt already made this session is not repeated, and one not yet made goes ahead', () => {
  assert.equal(digestOptInStep({ ...optIn, attempted: true }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, attempted: false }), 'subscribe');
});

test('a yes that is already on is settled, not subscribed again', () => {
  assert.equal(digestOptInStep({ ...optIn, enabled: true }), 'settle');
  assert.equal(digestOptInStep({ ...optIn, enabled: true, attempted: true }), 'wait');
});

test('Firebase\'s own creation time format is read against the instant', () => {
  const effective = '2026-11-25T00:00:00Z';
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: 'Tue, 24 Nov 2026 23:59:59 GMT', effectiveAt: effective }), true);
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: 'Wed, 25 Nov 2026 09:30:00 GMT', effectiveAt: effective }), false);
});

test('a new account that chose no topics keeps waiting for its first follow, and is told so', () => {
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: AFTER, covered: false, effectiveAt }), true);
  assert.equal(digestOptInWaitsForFollow({ pending: true, accountCreated: AFTER, covered: true, effectiveAt }), false);
});
