import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hydrateAccountCaches, resetAccountWarmup } from './accountWarmup.js';
import { ownListsCache, ownProfileCache, ownProfileKey } from '../utils/profileSessionCaches.js';
import { saveStoredLists, saveStoredProfile } from '../utils/userScopedStorage.js';

test('hydrateAccountCaches copies this device\'s lists and profile into the session', () => {
  resetAccountWarmup();
  ownListsCache.clear();
  ownProfileCache.clear();
  const storage = {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
    get length() { return this.map.size; },
  };
  saveStoredLists('uid-w1', [{ id: 'l1', name: 'Notes', paperIds: ['p1'] }], storage);
  saveStoredProfile('uid-w1', {
    uid: 'uid-w1', handle: 'alice', displayName: 'Alice',
  }, storage);

  hydrateAccountCaches('uid-w1', { storage });
  assert.equal(ownListsCache.get('uid-w1')?.[0]?.id, 'l1');
  assert.equal(ownProfileCache.get(ownProfileKey('uid-w1'))?.profile?.handle, 'alice');

  ownListsCache.clear();
  ownProfileCache.clear();
  resetAccountWarmup();
});

test('SOURCE: auth hydrates and warms the account caches on sign-in', async () => {
  const source = await readFile(new URL('../context/AuthContext.jsx', import.meta.url), 'utf8');
  assert.match(source, /hydrateAccountCaches/);
  assert.match(source, /warmAccountCaches/);
  assert.match(source, /resetAccountWarmup/);
});

test('SOURCE: the save modal seeds from this device, not only the session', async () => {
  const source = await readFile(new URL('../components/Lists/SaveToListModal.jsx', import.meta.url), 'utf8');
  assert.match(source, /readStoredLists/);
  assert.match(source, /saveStoredLists/);
});
