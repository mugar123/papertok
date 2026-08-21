import { createSessionCache } from './sessionCache.js';

/**
 * The session caches the profile screens share.
 *
 * They live here rather than inside one component because two screens read the
 * same documents: `/profile` (PublicProfilePage in owner mode) and
 * `/settings/profile` (ProfilePage). Moving between them is the single most
 * common navigation in this part of the app, and with a cache per component
 * each crossing paid for the same read again and sat on a spinner while it
 * happened.
 *
 * Sharing one entry makes the two screens one view of one document, which also
 * makes staleness a real obligation: `rememberOwnProfile` and `forgetOwnProfile`
 * exist so a save or a deletion updates the shared view instead of leaving the
 * other screen to paint what the account no longer says.
 *
 * Keys carry the identity (`own:{uid}` / `handle:{handle}`) so no account can
 * ever be served another account's entry. Nothing here survives a reload.
 */
export const ownProfileCache = createSessionCache({ maxEntries: 8 });
export const ownListsCache = createSessionCache({ maxEntries: 4 });
export const pinnableListsCache = createSessionCache({ maxEntries: 4 });
export const likedExtraCache = createSessionCache({ maxEntries: 4 });
// The showcase (F12): the one `profileLists/{uid}` read a visitor's Listas
// tab costs, keyed by uid so remounts repaint instead of re-reading.
export const showcaseCache = createSessionCache({ maxEntries: 8 });

export function ownProfileKey(uid) {
  return uid ? `own:${uid}` : null;
}

export function handleProfileKey(handle) {
  return handle ? `handle:${handle}` : null;
}

/**
 * Entries are `{ profile }` wrappers, because "this account has no public
 * profile yet" is a null that is itself worth caching — an absent wrapper
 * means "not asked", which is a different thing.
 */
export function rememberOwnProfile(uid, profile) {
  const key = ownProfileKey(uid);
  if (!key) return;
  ownProfileCache.set(key, { profile });
  // The handle-keyed entry is the same document seen from the public side;
  // leaving the old one behind would serve a renamed profile under its
  // previous name.
  if (profile?.handle) ownProfileCache.set(handleProfileKey(profile.handle), { profile });
}

/**
 * How long a lists read stays good enough to reuse without asking again.
 *
 * Saving papers in a burst is the case this exists for: the save modal opens
 * once per paper, and every open used to re-read all sixty list documents.
 * Fifty saves meant fifty full re-reads on a channel already carrying a write
 * per save to the same document, and that is what saturated into an endless
 * skeleton. Inside this window the modal trusts what it has.
 *
 * Correctness comes from write-through, not from luck: `handleSave` folds its
 * own edit into the cached lists before the window expires, and the lists page
 * stamps the cache from its own authoritative read. What is left is a list
 * renamed on ANOTHER device going unnoticed for at most this long — a price
 * worth one thirtieth of the reads.
 */
export const OWN_LISTS_FRESH_MS = 30_000;

const ownListsReadAt = new Map();

/** Caches a lists read and stamps it fresh. Both readers of the collection use it. */
export function rememberOwnLists(uid, lists) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
  ownListsReadAt.set(uid, Date.now());
}

/** Updates the cached lists in place, without claiming they were re-read. */
export function reviseOwnLists(uid, lists) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
}

/**
 * True when the cached lists are recent enough to skip the read entirely.
 * Pure but for the clock, which is injectable so the tests never wait.
 */
export function ownListsAreFresh(uid, now = Date.now(), ttlMs = OWN_LISTS_FRESH_MS) {
  if (!uid || !ownListsCache.get(uid)) return false;
  const readAt = ownListsReadAt.get(uid);
  return typeof readAt === 'number' && now - readAt < ttlMs;
}

export function forgetOwnLists(uid) {
  if (!uid) return;
  ownListsCache.delete(uid);
  ownListsReadAt.delete(uid);
}

export function forgetOwnProfile(uid, handle) {
  const key = ownProfileKey(uid);
  if (key) ownProfileCache.delete(key);
  if (handle) ownProfileCache.delete(handleProfileKey(handle));
  if (uid) {
    forgetOwnLists(uid);
    pinnableListsCache.delete(uid);
  }
}
