/**
 * Warm the signed-in account's own lists so the first open of the lists page
 * or the save-to-list modal is not a cold Firestore handshake.
 *
 * Session caches die on reload. localStorage already remembers the lists; this
 * module hydrates the session cache from that, then revalidates in the
 * background. The first paint of those screens can then use data this device
 * already had, instead of waiting for a channel that has not opened yet.
 */

import { collection, getDocs, limit, query } from 'firebase/firestore';
import { IS_DEMO, auth, db } from './firebase.ts';
import { queryIsAuthoritative } from '../utils/cacheAuthority.ts';
import { OWN_LISTS_PAGE_SIZE } from '../utils/ownLists.ts';
import { ownListsCache, rememberOwnLists, reviseOwnLists } from '../utils/profileSessionCaches.ts';
import { readStoredLists, saveStoredLists } from '../utils/userScopedStorage.ts';

const warmed = new Set();

export function resetAccountWarmup(uid) {
  if (uid) warmed.delete(uid);
  else warmed.clear();
}

/**
 * Synchronous: copy last-known lists into the session cache.
 * Call this before the first screen that needs them renders.
 */
export function hydrateAccountCaches(uid, { storage } = {}) {
  if (!uid || ownListsCache.get(uid)) return;
  const lists = readStoredLists(uid, storage);
  if (lists) reviseOwnLists(uid, lists);
}

async function defaultReadLists(uid) {
  return getDocs(query(
    collection(db, 'users', uid, 'lists'),
    limit(OWN_LISTS_PAGE_SIZE),
  ));
}

export async function warmAccountCaches(uid, {
  storage,
  readLists = defaultReadLists,
  currentUid = () => auth.currentUser?.uid,
} = {}) {
  if (!uid || IS_DEMO || warmed.has(uid)) return;
  warmed.add(uid);
  hydrateAccountCaches(uid, { storage });
  // Signing out does not cancel a read already in flight. Whatever lands
  // afterwards belongs to a session that no longer exists, and must not be
  // written back into the session cache or onto the device the sign-out
  // just cleared.
  const stillCurrent = () => currentUid() === uid && warmed.has(uid);
  const listsSnapshot = await readLists(uid).catch(() => null);
  if (!stillCurrent()) return; // Signed out while the read was in flight.
  if (listsSnapshot && queryIsAuthoritative(listsSnapshot)) {
    const lists = [];
    listsSnapshot.forEach(item => lists.push({ id: item.id, ...item.data() }));
    rememberOwnLists(uid, lists);
    saveStoredLists(uid, lists, storage);
  }
}
