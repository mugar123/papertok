import test from 'node:test';
import assert from 'node:assert/strict';
import { digestInterestsToSend, digestLeafIds, digestProfileInterests, requestAccountCurrent, digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from './digest-shutoff.ts';

const SERVER = { fromCache: false, hasPendingWrites: false };
const base = { enabled: true, followsConfirmed: true, interestsConfirmed: true, digestCovered: false, attempted: false };

test('the live profile gives the digest its chosen leaf categories, confirmed only when the server sent them', () => {
  const fromServer = digestProfileInterests({ preferences: ['cs.LG', 'not-a-category', 'cs.AI', 'cs.LG'] }, SERVER);
  assert.deepEqual(fromServer, { interests: ['cs.AI', 'cs.LG'], confirmed: true });
  assert.deepEqual(digestProfileInterests({ selectedCategories: ['cs.AI'] }, SERVER).interests, ['cs.AI']);
  assert.equal(digestProfileInterests({ preferences: ['cs.LG'] }, { fromCache: true, hasPendingWrites: false }).confirmed, false);
});

test('a profile the server says holds no categories is a confirmed none', () => {
  assert.deepEqual(digestProfileInterests(undefined, SERVER), { interests: [], confirmed: true });
  assert.deepEqual(digestProfileInterests({ preferences: 'cs.LG' }, SERVER), { interests: [], confirmed: true });
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

test('a profile snapshot that still holds an unacknowledged write is not the server\'s copy', () => {
  // The emulator reports fromCache: false with hasPendingWrites: true for a write made a moment ago.
  assert.equal(digestProfileInterests({ preferences: ['cs.LG'] }, { fromCache: false, hasPendingWrites: true }).confirmed, false);
  assert.equal(digestProfileInterests({ preferences: ['cs.LG'] }, SERVER).confirmed, true);
});

test('the welcome hands the digest only the leaf topics of what was chosen, once each and in a fixed order', () => {
  assert.deepEqual(digestLeafIds(['stat.ML', 'cs', 'cs.LG', 'stat.ML', 7, 'not-a-category']), ['cs.LG', 'stat.ML']);
  assert.deepEqual(digestLeafIds(undefined), []);
});

test('an answer is kept only for the account that is both shown and signed in', () => {
  assert.equal(requestAccountCurrent({ requestUid: 'a', shownUid: 'a', signedInUid: 'a' }), true);
  // Firebase switched to B before React did: the shown account is still A.
  assert.equal(requestAccountCurrent({ requestUid: 'a', shownUid: 'a', signedInUid: 'b' }), false);
  // React moved on to B while A's answer was in flight.
  assert.equal(requestAccountCurrent({ requestUid: 'a', shownUid: 'b', signedInUid: 'b' }), false);
  assert.equal(requestAccountCurrent({ requestUid: 'a', shownUid: 'a', signedInUid: null }), false);
  assert.equal(requestAccountCurrent({ requestUid: null, shownUid: null, signedInUid: null }), false);
});
