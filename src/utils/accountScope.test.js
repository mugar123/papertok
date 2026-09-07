import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_ACCOUNT_SCOPE,
  SIGNED_OUT_ACCOUNT,
  accountScopeKey,
  nextAccountScope,
} from './accountScope.js';

/**
 * These run the real sequences an auth session produces, in order, and assert on
 * the KEY the provider tree is mounted under — because that key is what decides
 * whether React keeps the subtree or destroys it. A test that only looked at the
 * expression in `App.jsx` would pass on a key that is spelled differently and
 * still flips.
 */

/** Replays a sequence of auth states and returns the key after each one. */
function keysThrough(states) {
  let scope = INITIAL_ACCOUNT_SCOPE;
  return states.map((auth) => {
    scope = nextAccountScope(scope, auth);
    return accountScopeKey(scope);
  });
}

test('a signed-in cold load keeps ONE tree: the account becoming known is not the account changing', () => {
  // The sequence AuthContext actually emits: null while onAuthStateChanged is
  // out, then the user with `loading` raised in the same block (:82-83), then
  // loading clearing once the profile read settles.
  const keys = keysThrough([
    { uid: null, authLoading: true },
    { uid: 'uid-abc', authLoading: true },
    { uid: 'uid-abc', authLoading: false },
  ]);
  assert.equal(new Set(keys).size, 1, `the key must never change on a cold load, got ${keys.join(' -> ')}`);
});

test('a visit that never signs in keeps one tree too', () => {
  const keys = keysThrough([
    { uid: null, authLoading: true },
    { uid: null, authLoading: false },
  ]);
  assert.equal(new Set(keys).size, 1, `an anonymous load must not remount, got ${keys.join(' -> ')}`);
});

test('the key still changes when the reader becomes somebody else — which is what it is for', () => {
  // e507856, "isolate recommendation state": per-account state below this key
  // must not survive a change of account.
  const keys = keysThrough([
    { uid: null, authLoading: true },
    { uid: 'uid-abc', authLoading: false },
    { uid: 'uid-xyz', authLoading: false },
  ]);
  assert.equal(keys[0], keys[1], 'adopting the first account must not remount');
  assert.notEqual(keys[1], keys[2], 'switching accounts must remount');
});

test('signing out is a change of account, and remounts', () => {
  const keys = keysThrough([
    { uid: 'uid-abc', authLoading: false },
    { uid: null, authLoading: false },
  ]);
  assert.notEqual(keys[0], keys[1]);
});

test('signing in after an anonymous visit remounts', () => {
  const keys = keysThrough([
    { uid: null, authLoading: false },
    { uid: 'uid-abc', authLoading: false },
  ]);
  assert.notEqual(keys[0], keys[1]);
});

/**
 * `AuthContext.jsx:82` raises `loading` again on EVERY auth emission, a token
 * refresh included, while `user` stays. Read as "the session is unknown again",
 * that would drop the account and re-adopt it — a remount per refresh, which is
 * the original bug on a longer clock.
 */
test('a token refresh does not drop the account', () => {
  const keys = keysThrough([
    { uid: null, authLoading: true },
    { uid: 'uid-abc', authLoading: false },
    { uid: 'uid-abc', authLoading: true },
    { uid: 'uid-abc', authLoading: false },
  ]);
  assert.equal(new Set(keys).size, 1, `a refresh must not remount, got ${keys.join(' -> ')}`);
});

/**
 * `AuthContext.jsx:82-83` raises `loading` and sets the user in the SAME block,
 * and only clears it once the profile read settles — a cache miss then a network
 * read, up to `PROFILE_NETWORK_TIMEOUT_MS` (7000ms, :29). Adoption must key off
 * the user being there, not off that read finishing, or the tree spends the
 * whole profile read on a scope it is going to leave.
 */
test('the account is adopted as soon as there is one, without waiting for the profile read', () => {
  const scope = nextAccountScope(INITIAL_ACCOUNT_SCOPE, { uid: 'uid-abc', authLoading: true });
  assert.equal(scope.account, 'uid-abc', 'a user in hand is a known session, whatever `loading` says');
  assert.equal(accountScopeKey(scope), accountScopeKey(INITIAL_ACCOUNT_SCOPE), 'and adopting it still must not remount');
});

test('the scope is returned by identity when nothing changed, so a render can compare with !==', () => {
  const first = nextAccountScope(INITIAL_ACCOUNT_SCOPE, { uid: 'uid-abc', authLoading: false });
  assert.equal(nextAccountScope(first, { uid: 'uid-abc', authLoading: false }), first);
  assert.equal(nextAccountScope(first, { uid: 'uid-abc', authLoading: true }), first);
  // And before anything is known there is nothing to adopt yet.
  assert.equal(nextAccountScope(INITIAL_ACCOUNT_SCOPE, { uid: null, authLoading: true }), INITIAL_ACCOUNT_SCOPE);
});

test('the key carries the generation and not the account, or adoption would be back in it', () => {
  const adopted = nextAccountScope(INITIAL_ACCOUNT_SCOPE, { uid: 'uid-abc', authLoading: false });
  assert.equal(adopted.account, 'uid-abc');
  assert.doesNotMatch(accountScopeKey(adopted), /uid-abc/);
  assert.equal(accountScopeKey(INITIAL_ACCOUNT_SCOPE), accountScopeKey(adopted));
});

test('a signed-out reader scopes to a named account rather than to null', () => {
  const out = nextAccountScope(INITIAL_ACCOUNT_SCOPE, { uid: null, authLoading: false });
  assert.equal(out.account, SIGNED_OUT_ACCOUNT);
  // Null means "not resolved yet"; without the distinction the next resolution
  // would adopt instead of switching, and a sign-out would not remount.
  assert.notEqual(out.account, null);
});
