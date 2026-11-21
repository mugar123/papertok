import test from 'node:test';
import assert from 'node:assert/strict';
import { digestInterestsToSend, digestOptInStep, digestOptInWaitsForFollow, digestProfileInterests, digestShutoffDue, digestShutoffNoticeShown, digestSyncAllowed } from './digest-shutoff.ts';
import { DIGEST_CONSENT_FROM_SIGNUP, DIGEST_CONSENT_SPENT, readDigestConsent, writeDigestConsent } from './digest-consent.ts';

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

const optIn = {
  consent: DIGEST_CONSENT_FROM_SIGNUP,
  attempted: false,
  flagLive: null,
  enabled: false,
  serviceDown: false,
  hasFollows: false,
  digestCovered: true,
  digestSendReady: true,
} as const;

test('a yes given under the from-sign-up text waits for a follow only while nothing covers the digest', () => {
  assert.equal(digestOptInWaitsForFollow({ pending: true, consent: DIGEST_CONSENT_FROM_SIGNUP }), false);
  assert.equal(digestOptInWaitsForFollow({ pending: true, consent: DIGEST_CONSENT_FROM_SIGNUP, covered: false }), true);
  assert.equal(digestOptInWaitsForFollow({ pending: false, consent: DIGEST_CONSENT_FROM_SIGNUP, covered: false }), false, 'nothing is pending without a yes');
});

test('a yes with no known version keeps the old promise, whenever the account was created', () => {
  assert.equal(digestOptInWaitsForFollow({ pending: true, consent: null }), true);
  assert.equal(digestOptInStep({ ...optIn, consent: null }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, consent: null, hasFollows: true }), 'subscribe');
});

test('a new yes subscribes in the first session on the chosen topics, with no follow', () => {
  assert.equal(digestOptInStep(optIn), 'subscribe');
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

test('a digest that is already on is settled, not subscribed again', () => {
  assert.equal(digestOptInStep({ ...optIn, enabled: true }), 'settle');
  assert.equal(digestOptInStep({ ...optIn, enabled: true, attempted: true }), 'wait');
});

test('a spent yes, however its flag survived, is only deleted: never a new subscription, with or without follows', () => {
  const spent = { ...optIn, consent: DIGEST_CONSENT_SPENT } as const;
  assert.equal(digestOptInStep(spent), 'settle');
  assert.equal(digestOptInStep({ ...spent, hasFollows: true }), 'settle');
  assert.equal(digestOptInStep({ ...spent, enabled: false, digestCovered: true, digestSendReady: true }), 'settle');
});

// The reader's withdrawal outlives a flag that could not be deleted: subscribe
// succeeds, the delete fails, the reader unsubscribes (in Settings or from the
// email), and the next sign-in still finds the flag.
test('a withdrawal made while the flag survived is never turned back into a subscription at the next sign-in', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  writeDigestConsent('uid-a', DIGEST_CONSENT_FROM_SIGNUP, storage);
  assert.equal(digestOptInStep({ ...optIn, consent: readDigestConsent('uid-a', storage) }), 'subscribe');

  // The subscription started and the reader later ended it; the device recorded the yes as spent.
  writeDigestConsent('uid-a', DIGEST_CONSENT_SPENT, storage);
  const nextSession = { ...optIn, consent: readDigestConsent('uid-a', storage), enabled: false, hasFollows: true };
  assert.equal(digestOptInStep(nextSession), 'settle');
  assert.equal(digestOptInWaitsForFollow({ pending: true, consent: nextSession.consent }), false, 'and Settings does not say it starts with a first follow');
});

// Another tab or device already subscribed and settled the flag, then the reader
// unsubscribed there: this tab still has the old pending yes in memory.
test('a yes whose flag the live profile no longer holds is never acted on, but an unknown flag is', () => {
  assert.equal(digestOptInStep({ ...optIn, consent: null, hasFollows: true, flagLive: false }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, flagLive: false }), 'wait');
  assert.equal(digestOptInStep({ ...optIn, flagLive: true }), 'subscribe');
  assert.equal(digestOptInStep({ ...optIn, consent: null, hasFollows: true, flagLive: null }), 'subscribe');
});
