import { createSessionCache } from './sessionCache.js';
import { profileIsPublic } from '../services/userProfileService.js';

/**
 * The session caches the account's own screens share.
 *
 * They live here rather than inside one component because several screens read
 * the same documents: `/settings/profile` and `/settings/privacy` (each
 * mounting useProfileEditor afresh) read the profile, and the lists page and
 * the save modal read the lists. With a cache per component each crossing paid
 * for the same read again and sat on a spinner while it happened.
 *
 * Sharing one entry makes the screens one view of one document, which also
 * makes staleness a real obligation: `rememberOwnProfile` and `forgetOwnProfile`
 * exist so a save or a deletion updates the shared view instead of leaving the
 * other screen to paint what the account no longer says.
 *
 * Keys carry the identity (`own:{uid}` / `handle:{handle}`) so no account can
 * ever be served another account's entry. Nothing here survives a reload.
 */
export const ownProfileCache = createSessionCache({ maxEntries: 8 });
export const ownListsCache = createSessionCache({ maxEntries: 4 });
/**
 * Paper metadata the lists screen has already paid for, keyed by uid.
 *
 * `savedPapers` on that screen is plain component state, so leaving a list to
 * read a paper and coming back re-fetched every document the tab had in its
 * hands seconds earlier — and Firestore's own cache cannot cover it, because
 * `firebase.js` deliberately keeps the in-memory one with no persistence.
 *
 * One entry per account rather than per paper: the value is the whole
 * `{ [paperId]: paper }` map, which is what the screen seeds its state from, and
 * an LRU over individual papers would evict the middle of a list.
 */
export const listPapersCache = createSessionCache({ maxEntries: 2 });
export const pinnableListsCache = createSessionCache({ maxEntries: 4 });

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
  const previous = ownProfileCache.get(key)?.profile;
  ownProfileCache.set(key, { profile });
  // Nothing reads the handle entry since the public profile page went; it is
  // still kept public-only, and dropped on a rename or sign-out, until the
  // profile editor and handles are removed.
  if (previous?.handle && previous.handle !== profile?.handle) {
    ownProfileCache.delete(handleProfileKey(previous.handle));
  }
  if (profile?.handle) {
    if (profileIsPublic(profile)) ownProfileCache.set(handleProfileKey(profile.handle), { profile });
    else ownProfileCache.delete(handleProfileKey(profile.handle));
  }
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

/** The papers this account's lists screen has already resolved. */
export function readListPapers(uid) {
  return uid ? listPapersCache.get(uid) : undefined;
}

/**
 * Folds newly resolved papers into what the account already had.
 *
 * Merged rather than replaced: a list is opened one at a time, and replacing
 * would throw away the previous list's papers on every visit — which is the
 * re-fetching this cache exists to stop.
 */
export function rememberListPapers(uid, papers) {
  if (!uid || !papers || typeof papers !== 'object') return;
  const known = listPapersCache.get(uid);
  listPapersCache.set(uid, known ? { ...known, ...papers } : { ...papers });
}

export function forgetOwnProfile(uid, handle) {
  const key = ownProfileKey(uid);
  // The handle the caller knows about and the handle this cache actually
  // published are not always the same one — sign-out passes the uid alone —
  // and an entry left under either name outlives the session that wrote it.
  const remembered = key ? ownProfileCache.get(key)?.profile?.handle : undefined;
  if (key) ownProfileCache.delete(key);
  for (const name of [handle, remembered]) if (name) ownProfileCache.delete(handleProfileKey(name));
  if (uid) {
    forgetOwnLists(uid);
    pinnableListsCache.delete(uid);
  }
}
