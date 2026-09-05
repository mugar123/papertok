import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCache } from '../../utils/sessionCache.js';
import { ownProfileKey } from '../../utils/profileSessionCaches.js';
import {
  LOADING_PROFILE,
  composerStateFor,
  ownProfileFrom,
  seedOwnProfile,
} from './composerGate.js';

const PUBLIC = { uid: 'u1', handle: 'alice', visibility: 'public' };
const PRIVATE = { uid: 'u1', handle: 'alice', visibility: 'private' };

test('signed out wins over everything, even a ready profile', () => {
  assert.equal(composerStateFor({ isAuthenticated: false, ownProfile: ownProfileFrom(PUBLIC) }), 'signed-out');
});

test('an unresolved profile is loading, never a refusal', () => {
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: LOADING_PROFILE }), 'loading');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: undefined }), 'loading');
});

test('the three doors: no profile, private, ready', () => {
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(null) }), 'no-profile');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(PRIVATE) }), 'private');
  assert.equal(composerStateFor({ isAuthenticated: true, ownProfile: ownProfileFrom(PUBLIC) }), 'ready');
});

test('ownProfileFrom carries the uid only when there is a profile', () => {
  assert.deepEqual(ownProfileFrom(PUBLIC), { status: 'ready', profile: PUBLIC, uid: 'u1' });
  assert.deepEqual(ownProfileFrom(null), { status: 'ready', profile: null, uid: undefined });
  assert.deepEqual(ownProfileFrom(undefined), { status: 'ready', profile: null, uid: undefined });
});

test('the seed hydrates first, then reads the account cache', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  const calls = [];
  const hydrate = (uid) => { calls.push(uid); cache.set(ownProfileKey(uid), { profile: PUBLIC }); };
  assert.deepEqual(seedOwnProfile('u1', { cache, hydrate }), ownProfileFrom(PUBLIC));
  assert.deepEqual(calls, ['u1']);
});

test('a cached "no profile" seeds as no profile; a never-asked cache seeds nothing', () => {
  const cache = createSessionCache({ maxEntries: 2 });
  cache.set(ownProfileKey('u1'), { profile: null });
  assert.deepEqual(seedOwnProfile('u1', { cache, hydrate: () => {} }), ownProfileFrom(null));
  assert.equal(seedOwnProfile('u2', { cache, hydrate: () => {} }), null);
  assert.equal(seedOwnProfile('', { cache, hydrate: () => { throw new Error('must not hydrate without a uid'); } }), null);
});
