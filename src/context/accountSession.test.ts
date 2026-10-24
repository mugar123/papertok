import type { ListSnapshot, OwnList } from '../utils/ownLists.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptOnboardedProfile, closeAccountSession, openAccountSession } from './accountSession.ts';
import { resetAccountWarmup } from '../services/accountWarmup.ts';
import { readGuestInterests, saveGuestInterests } from '../utils/guestInterests.ts';
import { ownListsCache } from '../utils/profileSessionCaches.ts';
import { readSeenPaperIds, readStoredLists, readStoredOnboarding, saveSeenPaperIds, saveStoredLists, saveStoredOnboarding } from '../utils/userScopedStorage.ts';

function deviceStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

/** A lists query snapshot the server answered. */
function listsSnapshot(lists: OwnList[]): ListSnapshot {
  return {
    empty: lists.length === 0,
    size: lists.length,
    metadata: { fromCache: false },
    forEach: callback => lists.forEach(({ id, ...data }) => callback({ id, data: () => data })),
  };
}

function freshSession(t: import('node:test').TestContext) {
  ownListsCache.clear();
  resetAccountWarmup();
  t.after(() => { ownListsCache.clear(); resetAccountWarmup(); });
}

test('signing in paints from what this device remembers and refreshes the lists behind it', async t => {
  freshSession(t);
  const storage = deviceStorage();
  saveStoredLists('account-a', [{ id: 'a-local', name: 'Notes', paperIds: ['p1'] }], storage);
  saveStoredOnboarding('account-a', { complete: true, preferences: ['cs.AI'] }, storage);
  let answer!: () => void;
  const answered = new Promise<void>(resolve => { answer = resolve; });

  const paint = openAccountSession('account-a', {
    storage,
    currentUid: () => 'account-a',
    readLists: () => answered.then(() => listsSnapshot([{ id: 'a-server', name: 'Reading', paperIds: ['p2'] }])),
  });

  assert.deepEqual(paint, { complete: true, preferences: ['cs.AI'] });
  assert.deepEqual(ownListsCache.get('account-a')?.map(list => list.id), ['a-local'], 'the device\'s lists are there before the read');
  answer();
  await answered;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(ownListsCache.get('account-a')?.map(list => list.id), ['a-server']);
  assert.deepEqual(readStoredLists('account-a', storage)?.map(list => list.id), ['a-server']);
});

test('after A signs out, B signing in on the same device finds nothing of A\'s', async t => {
  freshSession(t);
  const storage = deviceStorage();
  let signedIn: string | null = 'account-a';
  saveStoredLists('account-a', [{ id: 'a-private', name: 'Private', paperIds: ['p1'] }], storage);
  saveStoredOnboarding('account-a', { complete: true, preferences: ['cs.AI'] }, storage);
  saveSeenPaperIds('account-a', ['a-viewed'], storage);
  // A guest answer A left waiting mid-onboarding.
  saveGuestInterests({ areas: ['physics'], topics: [] }, storage);
  let answer!: () => void;
  const answered = new Promise<void>(resolve => { answer = resolve; });
  openAccountSession('account-a', {
    storage,
    currentUid: () => signedIn,
    readLists: () => answered.then(() => listsSnapshot([{ id: 'a-private', name: 'Private', paperIds: ['p1'] }])),
  });

  signedIn = null;
  closeAccountSession('account-a', storage);
  // A's warm-up read lands after the sign-out.
  answer();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(ownListsCache.get('account-a'), undefined, 'A\'s lists left the session');
  assert.equal(readStoredLists('account-a', storage), null, 'and the device');
  assert.equal(readStoredOnboarding('account-a', storage), null);
  assert.deepEqual([...readSeenPaperIds('account-a', storage)], []);
  assert.equal(readGuestInterests(storage), null, 'the guest answer cannot seed B');

  signedIn = 'account-b';
  const paintB = openAccountSession('account-b', {
    storage,
    currentUid: () => signedIn,
    readLists: async () => listsSnapshot([]),
  });
  assert.equal(paintB, null, 'B has no remembered onboarding');
  assert.equal(ownListsCache.get('account-b'), undefined);
});

test('signing back in after a sign-out reads the account\'s lists again', async t => {
  freshSession(t);
  const storage = deviceStorage();
  let reads = 0;
  const devices = { storage, currentUid: () => 'account-a', readLists: async () => { reads += 1; return listsSnapshot([]); } };
  openAccountSession('account-a', devices);
  await new Promise(resolve => setTimeout(resolve, 0));
  closeAccountSession('account-a', storage);
  openAccountSession('account-a', devices);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(reads, 2);
});

test('a profile that already holds its interests spends the guest answer waiting on this device', () => {
  const storage = deviceStorage();
  saveGuestInterests({ areas: ['physics'], topics: [] }, storage);

  adoptOnboardedProfile('account-a', ['cs.AI', 'cs.LG'], storage);

  assert.deepEqual(readStoredOnboarding('account-a', storage), { complete: true, preferences: ['cs.AI', 'cs.LG'] });
  assert.equal(readGuestInterests(storage), null, 'the next new account on this device is not seeded with A\'s pick');
});
