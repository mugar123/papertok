import { profileIsPublic } from '../../services/userProfileService.js';
import { hydrateAccountCaches } from '../../services/accountWarmup.js';
import { ownProfileCache, ownProfileKey } from '../../utils/profileSessionCaches.js';

/**
 * Who may write, decided from two facts: whether there is a session, and
 * what the viewer's own profile says. Pure, so the sheet's five-way footer
 * can be pinned without a DOM.
 *
 * The composer used to keep a private one-slot cache of the profile that
 * only filled after the sheet itself had resolved it once. The account
 * caches already hold the same document — hydrated from localStorage the
 * moment a session exists and revalidated by `warmAccountCaches` — so the
 * seed reads those, and the footer paints on open instead of waiting for a
 * channel that may not be up yet.
 */

export const LOADING_PROFILE = Object.freeze({ status: 'loading', profile: null, uid: undefined });

export function ownProfileFrom(profile) {
  return { status: 'ready', profile: profile ?? null, uid: profile?.uid ?? undefined };
}

export function composerStateFor({ isAuthenticated, ownProfile }) {
  if (!isAuthenticated) return 'signed-out';
  if (!ownProfile || ownProfile.status !== 'ready') return 'loading';
  if (!ownProfile.profile) return 'no-profile';
  if (!profileIsPublic(ownProfile.profile)) return 'private';
  return 'ready';
}

/**
 * The profile this device already knows for `uid`, or `null` when the
 * caches were never asked. `{ profile: null }` in the cache is an answer —
 * the server said there is no profile — and seeds as such.
 */
export function seedOwnProfile(uid, { cache = ownProfileCache, hydrate = hydrateAccountCaches } = {}) {
  if (!uid) return null;
  hydrate(uid);
  const entry = cache.get(ownProfileKey(uid));
  if (entry === undefined) return null;
  return ownProfileFrom(entry.profile);
}
