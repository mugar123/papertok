import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hydrateAccountCaches, resetAccountWarmup, warmAccountCaches } from './accountWarmup.ts';
import { ownListsCache } from '../utils/profileSessionCaches.ts';
import { readStoredLists, saveStoredLists } from '../utils/userScopedStorage.ts';

test('hydrateAccountCaches copies this device\'s lists into the session', () => {
  resetAccountWarmup();
  ownListsCache.clear();
  const storage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
    get length() { return this.map.size; },
  };
  saveStoredLists('uid-w1', [{ id: 'l1', name: 'Notes', paperIds: ['p1'] }], storage);

  hydrateAccountCaches('uid-w1', { storage });
  assert.equal(ownListsCache.get('uid-w1')?.[0]?.id, 'l1');

  ownListsCache.clear();
  resetAccountWarmup();
});

test('SOURCE: auth hydrates and warms the account caches on sign-in', async () => {
  const source = await readFile(new URL('../context/AuthContext.jsx', import.meta.url), 'utf8');
  assert.match(source, /hydrateAccountCaches/);
  assert.match(source, /warmAccountCaches/);
  assert.match(source, /resetAccountWarmup/);
  assert.match(source, /readStoredOnboarding/);
  assert.match(source, /accountLooksOnboarded/);
});

test('SOURCE: the save modal seeds from this device, not only the session', async () => {
  const source = await readFile(new URL('../components/Lists/SaveToListModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /readStoredLists/);
  assert.match(source, /saveStoredLists/);
});

function deviceStorage() {
  return {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
    get length() { return this.map.size; },
  };
}

/** A lists query snapshot the server answered. */
function listsSnapshot(lists) {
  return {
    empty: lists.length === 0,
    size: lists.length,
    metadata: { fromCache: false },
    forEach: callback => lists.forEach(({ id, ...data }) => callback({ id, data: () => data })),
  };
}

test('a warm-up that is still current caches and stores the lists it read', async () => {
  resetAccountWarmup();
  ownListsCache.clear();
  const storage = deviceStorage();

  await warmAccountCaches('uid-w5', {
    storage,
    currentUid: () => 'uid-w5',
    readLists: async () => listsSnapshot([{ id: 'l5', name: 'Reading', paperIds: ['p5'] }]),
  });

  assert.equal(ownListsCache.get('uid-w5')?.[0]?.id, 'l5');
  assert.equal(readStoredLists('uid-w5', storage)?.[0]?.id, 'l5');

  ownListsCache.clear();
  resetAccountWarmup();
});

/* --- A warm-up outlives the session that started it ---
   The lists read is a round trip; signing out does not cancel it. What lands
   afterwards must not be cached for the next session, nor written back onto
   the device the sign-out has just cleared. */

test('a warm-up whose read lands after a sign-out writes nothing', async () => {
  resetAccountWarmup();
  ownListsCache.clear();
  const storage = deviceStorage();
  let signedIn = 'uid-w6';
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const pending = warmAccountCaches('uid-w6', {
    storage,
    currentUid: () => signedIn,
    readLists: () => gate.then(() => listsSnapshot([{ id: 'l6', name: 'Private', paperIds: ['p6'] }])),
  });
  signedIn = null; // Sign-out, with the lists read still in flight.
  release();
  await pending;

  assert.equal(ownListsCache.get('uid-w6'), undefined,
    'the signed-out account\'s lists were cached for whoever comes next');
  assert.equal(readStoredLists('uid-w6', storage), null, 'and nothing was written to the device either');

  ownListsCache.clear();
  resetAccountWarmup();
});

test('a warm-up the sign-out already reset writes nothing either', async () => {
  resetAccountWarmup();
  ownListsCache.clear();
  const storage = deviceStorage();
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  const pending = warmAccountCaches('uid-w7', {
    storage,
    currentUid: () => 'uid-w7',
    readLists: () => gate.then(() => listsSnapshot([{ id: 'l7', name: 'Private', paperIds: ['p7'] }])),
  });
  resetAccountWarmup('uid-w7'); // What AuthContext does when the session ends.
  release();
  await pending;

  assert.equal(ownListsCache.get('uid-w7'), undefined);
  assert.equal(readStoredLists('uid-w7', storage), null);

  ownListsCache.clear();
  resetAccountWarmup();
});
