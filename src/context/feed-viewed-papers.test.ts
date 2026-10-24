import test from 'node:test';
import assert from 'node:assert/strict';
import { leavesLoadedAccount, recordCardView, seenPapersForAccount } from './feed-viewed-papers.ts';
import { clearUserScopedStorage, readSeenPaperIds, saveSeenPaperIds } from '../utils/user-scoped-storage.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test('a card viewed by the signed-in account joins its viewed list, last viewed at the end', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  const account = { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen };
  recordCardView('p1', 'account-a', account, storage);
  recordCardView('p2', 'account-a', account, storage);
  recordCardView('p1', 'account-a', account, storage);
  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['p2', 'p1']);
  assert.deepEqual([...sessionSeen], ['p1', 'p2']);
});

test('a card that reports after the feed switched to another account counts for neither', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('before', 'account-a', { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen }, storage);
  // The feed now belongs to B; A's last card still reports, as A's.
  recordCardView('late-card', 'account-a', { activeUserId: 'account-b', signedInUid: 'account-b', sessionSeen }, storage);

  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['before']);
  assert.deepEqual([...readSeenPaperIds('account-b', storage)], []);
  assert.equal(sessionSeen.has('late-card'), false);
});

test('a card that reports while signing out does not write the swept list back', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('before', 'account-a', { activeUserId: 'account-a', signedInUid: 'account-a', sessionSeen }, storage);
  clearUserScopedStorage('account-a', storage);
  // Firebase names nobody; the feed's account effect has not run yet.
  recordCardView('on-screen-at-sign-out', 'account-a', { activeUserId: 'account-a', signedInUid: undefined, sessionSeen }, storage);

  assert.equal(storage.getItem('papertok_viewedIds:account-a'), null);
  assert.equal(storage.length, 0);
});

test('a guest view is remembered for the session only', () => {
  const storage = memoryStorage();
  const sessionSeen = new Set<string>();
  recordCardView('guest-paper', undefined, { activeUserId: null, signedInUid: undefined, sessionSeen }, storage);
  assert.deepEqual([...sessionSeen], ['guest-paper']);
  assert.equal(storage.length, 0);
});

test('switching from A to B starts from B\'s viewed list and leaves A\'s for when A returns', () => {
  const storage = memoryStorage();
  saveSeenPaperIds('account-a', ['a-viewed'], storage);
  saveSeenPaperIds('account-b', ['b-viewed'], storage);

  assert.deepEqual([...seenPapersForAccount('account-b', storage)], ['b-viewed']);
  assert.deepEqual([...seenPapersForAccount(null, storage)], []);
  assert.deepEqual([...readSeenPaperIds('account-a', storage)], ['a-viewed']);
});

test('an account\'s first load starts from the list this browser kept before the release', () => {
  const storage = memoryStorage();
  storage.setItem('papertok_seenIds:account-b', JSON.stringify(['b-before-release']));
  assert.deepEqual([...seenPapersForAccount('account-b', storage)], ['b-before-release']);
  assert.equal(storage.getItem('papertok_seenIds:account-b'), null);
});

test('the previous account\'s papers are cleared on a switch or a sign-out, not on a reload of the same account', () => {
  assert.equal(leavesLoadedAccount('account-a', 'account-b'), true);
  assert.equal(leavesLoadedAccount('account-a', null), true);
  assert.equal(leavesLoadedAccount('account-a', 'account-a'), false);
  // Nothing loaded yet: a profile that failed to load leaves the sets alone.
  assert.equal(leavesLoadedAccount(null, 'account-b'), false);
});
