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

export function forgetOwnProfile(uid, handle) {
  const key = ownProfileKey(uid);
  if (key) ownProfileCache.delete(key);
  if (handle) ownProfileCache.delete(handleProfileKey(handle));
  if (uid) {
    ownListsCache.delete(uid);
    pinnableListsCache.delete(uid);
  }
}
