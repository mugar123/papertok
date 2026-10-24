import type { OwnList, ListSnapshot } from '../utils/own-lists.ts';

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
import { auth, db } from './firebase.ts';
import { queryIsAuthoritative } from '../utils/cache-authority.ts';
import { OWN_LISTS_PAGE_SIZE } from '../utils/own-lists.ts';
import { ownListsCache, rememberOwnLists, reviseOwnLists } from '../utils/profile-session-caches.ts';
import { readStoredLists, saveStoredLists } from '../utils/user-scoped-storage.ts';

const warmed = new Set<string>();

export function resetAccountWarmup(uid?: string) {
  if (uid) warmed.delete(uid);
  else warmed.clear();
}

/**
 * Synchronous: copy last-known lists into the session cache.
 * Call this before the first screen that needs them renders.
 */
export function hydrateAccountCaches(uid: string, { storage }: { storage?: Parameters<typeof readStoredLists>[1] } = {}) {
  if (!uid || ownListsCache.get(uid)) return;
  const lists = readStoredLists(uid, storage);
  if (lists) reviseOwnLists(uid, lists);
}

async function defaultReadLists(uid: string) {
  return getDocs(query(
    collection(db, 'users', uid, 'lists'),
    limit(OWN_LISTS_PAGE_SIZE),
  ));
}

export async function warmAccountCaches(uid: string, {
  storage,
  readLists = defaultReadLists,
  currentUid = () => auth.currentUser?.uid,
}: { storage?: Parameters<typeof readStoredLists>[1]; readLists?: (uid: string) => Promise<ListSnapshot>; currentUid?: () => string | null | undefined } = {}) {
  if (!uid || warmed.has(uid)) return;
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
    const lists: OwnList[] = [];
    listsSnapshot.forEach(item => lists.push({ id: item.id, ...item.data() }));
    rememberOwnLists(uid, lists);
    saveStoredLists(uid, lists, storage);
  }
}
