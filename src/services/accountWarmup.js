/**
 * Warm the signed-in account's own profile and lists so the first visit to
 * /profile or the save-to-list modal is not a cold Firestore handshake.
 *
 * Session caches die on reload. localStorage already remembers lists and
 * follow counters; this module hydrates the session caches from that, then
 * revalidates in the background. The first paint of those screens can then
 * use data this device already had, instead of waiting for a channel that
 * has not opened yet.
 */

import { collection, getDocs, limit, query } from 'firebase/firestore';
import { IS_DEMO, db } from './firebase.js';
import { OWN_LISTS_PAGE_SIZE, readOwnUserProfile } from './userProfileService.js';
import { queryIsAuthoritative } from '../utils/cacheAuthority.js';
import {
  ownListsCache,
  ownProfileCache,
  ownProfileKey,
  rememberOwnLists,
  rememberOwnProfile,
  reviseOwnLists,
} from '../utils/profileSessionCaches.js';
import {
  clearStoredProfile,
  readStoredLists,
  readStoredProfile,
  saveStoredLists,
  saveStoredProfile,
} from '../utils/userScopedStorage.js';

const warmed = new Set();

export function resetAccountWarmup(uid) {
  if (uid) warmed.delete(uid);
  else warmed.clear();
}

/**
 * Synchronous: copy last-known lists and profile into the session caches.
 * Call this before the first screen that needs them renders.
 */
export function hydrateAccountCaches(uid, { storage } = {}) {
  if (!uid) return;
  if (!ownListsCache.get(uid)) {
    const lists = readStoredLists(uid, storage);
    if (lists) reviseOwnLists(uid, lists);
  }
  const profileKey = ownProfileKey(uid);
  if (profileKey && ownProfileCache.get(profileKey) === undefined) {
    const profile = readStoredProfile(uid, storage);
    if (profile) rememberOwnProfile(uid, profile);
  }
}

async function defaultReadLists(uid) {
  return getDocs(query(
    collection(db, 'users', uid, 'lists'),
    limit(OWN_LISTS_PAGE_SIZE),
  ));
}

export async function warmAccountCaches(uid, {
  storage,
  readProfile = readOwnUserProfile,
  readLists = defaultReadLists,
} = {}) {
  if (!uid || IS_DEMO || warmed.has(uid)) return;
  warmed.add(uid);
  hydrateAccountCaches(uid, { storage });
  const [profileRead, listsSnapshot] = await Promise.all([
    // A failed read and "no profile" are different answers, and only the
    // second one may erase what this device remembers: an unpublished
    // profile that came back from storage on every reload was the first
    // one wearing the second one's clothes.
    readProfile().then(profile => ({ profile }), () => null),
    readLists(uid).catch(() => null),
  ]);
  if (profileRead?.profile) {
    rememberOwnProfile(uid, profileRead.profile);
    saveStoredProfile(uid, profileRead.profile, storage);
  } else if (profileRead) {
    rememberOwnProfile(uid, null);
    clearStoredProfile(uid, storage);
  }
  if (listsSnapshot && queryIsAuthoritative(listsSnapshot)) {
    const lists = [];
    listsSnapshot.forEach(item => lists.push({ id: item.id, ...item.data() }));
    rememberOwnLists(uid, lists);
    saveStoredLists(uid, lists, storage);
  }
}
