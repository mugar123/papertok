type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

import type { OwnList } from './ownLists.ts';

const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_seenIds:';
const DRIFT_CHECK_KEY_PREFIX = 'papertok_profileDriftCheckedAt:';
const FOLLOW_STATS_KEY_PREFIX = 'papertok_followStats:';
const OWN_LISTS_KEY_PREFIX = 'papertok_ownLists:';
const OWN_PROFILE_KEY_PREFIX = 'papertok_ownProfile:';
const ONBOARDING_KEY_PREFIX = 'papertok_onboarding:';
// The comments a reporter chose not to see, from when the app had comments.
// Nothing writes it any more; sign-out still sweeps it so a list left in a
// browser does not outlive the feature.
const LOCAL_HIDDEN_PREFIX = 'papertok:locallyHiddenComments';
// The key this list lived under before it was scoped. Never migrated — one
// browser's two accounts have no shared answer to migrate to — only swept.
const LEGACY_LOCAL_HIDDEN_KEY = LOCAL_HIDDEN_PREFIX;

function getStorage<T extends ScopedStorage>(storage?: T | null) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getSeenPapersStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${SEEN_PAPERS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/** No uid, no key: an anonymous hide would be a global hide again. */
export function getLocalHiddenStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${LOCAL_HIDDEN_PREFIX}:${encodeURIComponent(userId)}`;
}

export function readSeenPaperIds(userId: string | null | undefined, storage?: ScopedStorage | null): Set<string> {
  const key = getSeenPapersStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return new Set();

  try {
    const parsed = JSON.parse(target.getItem(key) || '[]') as string[] | null;
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function saveSeenPaperIds(userId: string | null | undefined, paperIds: Iterable<string>, storage?: ScopedStorage | null, limit = 500) {
  const key = getSeenPapersStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    const ids = Array.from(paperIds || []).slice(-limit);
    target.setItem(key, JSON.stringify(ids));
  } catch {
    // The feed can continue when storage is unavailable or full.
  }
}

export function getDriftCheckStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${DRIFT_CHECK_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * When this device last verified the interaction aggregate against its
 * subcollection. Kept per device rather than in the aggregate so the check needs
 * no extra Firestore write and no schema change.
 */
export function readProfileDriftCheckedAt(userId: string | null, storage?: ScopedStorage | null) {
  const key = getDriftCheckStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return 0;

  try {
    const parsed = Number(target.getItem(key));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveProfileDriftCheckedAt(userId: string, timestamp: number, storage?: ScopedStorage | null) {
  const key = getDriftCheckStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    target.setItem(key, String(timestamp));
  } catch {
    // Losing the throttle only means checking again sooner than needed.
  }
}

export function getOwnListsStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${OWN_LISTS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

// Written by the removed public-profile editor. Nothing writes it now;
// sign-out still sweeps it from devices that stored one.
function getOwnProfileStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${OWN_PROFILE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * Roughly how much of this device's storage the lists may occupy.
 *
 * Not a guess at a quota — a bound on a payload that scales with the account.
 * The rules cap a list at 500 paper ids and a page at 60 lists, so an extreme
 * account would serialise to something like a third of a megabyte, written on
 * every visit. A realistic one is a few kilobytes. This keeps the extreme from
 * being paid for by everyone.
 */
export const OWN_LISTS_STORAGE_BUDGET_BYTES = 262_144;

/**
 * The owner's lists, as this device last saw them.
 *
 * `ownListsCache` already spares every re-entry within a tab, but it dies on
 * reload — and the first visit after one is exactly where the seam showed:
 * Favorites, Read later and Reading history are assembled from data already in
 * memory and paint in the first frame, while the owner's own lists waited on a
 * read and dropped in behind them. Two of the five cards arriving late is not a
 * slow screen, it is a screen that looks finished before it is.
 *
 * The cost: a list renamed on another device keeps its old name for as long
 * as the read takes. What is NOT accepted is a card that cannot be opened — so
 * a list is stored whole, with its paper ids, or it is not stored at all. A
 * seeded card that opened onto an empty list would be the "we could not find
 * out" lie wearing yet another hat.
 */
export function readStoredLists(userId: string, storage?: ScopedStorage | null): OwnList[] | null {
  const key = getOwnListsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!Array.isArray(parsed)) return null;
    const lists = parsed.filter(entry => (
      entry && typeof entry === 'object'
      && typeof entry.id === 'string' && entry.id
      && Array.isArray(entry.paperIds)
    ));
    return lists.length > 0 ? lists : null;
  } catch {
    return null;
  }
}

export function saveStoredLists(userId: string | undefined, lists: OwnList[] | null | undefined, storage?: ScopedStorage | null, budgetBytes = OWN_LISTS_STORAGE_BUDGET_BYTES) {
  const key = getOwnListsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !Array.isArray(lists)) return;

  try {
    // Only what a card renders and what opening one needs. `updatedAt` and
    // `publicSyncedAt` are deliberately dropped: they drive the public-sync
    // freshness check, and a stale pair read back from a previous session
    // could make a published list look out of date — or worse, up to date —
    // before the real documents have said anything.
    const stored = [];
    let bytes = 2;
    for (const list of lists) {
      if (!list?.id) continue;
      const entry = {
        id: list.id,
        name: typeof list.name === 'string' ? list.name : '',
        emoji: list.emoji ?? null,
        color: list.color ?? null,
        paperIds: Array.isArray(list.paperIds) ? list.paperIds : [],
        publicShareId: list.publicShareId ?? null,
      };
      const size = JSON.stringify(entry).length + 1;
      // Whole lists, never partial ones: a list that does not fit is simply not
      // seeded, and arrives with the read like it does today.
      if (bytes + size > budgetBytes) break;
      bytes += size;
      stored.push(entry);
    }

    if (stored.length === 0) target.removeItem(key);
    else target.setItem(key, JSON.stringify(stored));
  } catch {
    // A device that cannot store them just pays the read, as before.
  }
}

export function getOnboardingStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${ONBOARDING_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * Interests onboarding, as this device last finished it.
 *
 * Firestore's in-memory cache dies on reload. A returning visit then waits on
 * `users/{uid}` before it knows `onboardingComplete`, and a slow or empty
 * answer sent the account through the interest picker again. Remembering the
 * flag here lets the router keep them in the app until the document confirms.
 */
export function readStoredOnboarding(userId: string, storage?: ScopedStorage | null): { complete: boolean; preferences: string[] } | null {
  const key = getOnboardingStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences.filter((value: unknown) => typeof value === 'string')
      : [];
    if (parsed.complete !== true && preferences.length === 0) return null;
    return { complete: parsed.complete === true || preferences.length > 0, preferences };
  } catch {
    return null;
  }
}

export function saveStoredOnboarding(userId: string, state: { preferences?: unknown[]; complete?: boolean }, storage?: ScopedStorage | null) {
  const key = getOnboardingStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !state) return;

  try {
    const preferences = Array.isArray(state.preferences)
      ? state.preferences.filter(value => typeof value === 'string')
      : [];
    const complete = state.complete === true || preferences.length > 0;
    if (!complete && preferences.length === 0) {
      target.removeItem(key);
      return;
    }
    target.setItem(key, JSON.stringify({ complete, preferences }));
  } catch {
    // Missing local memory only means the next visit waits on Firestore.
  }
}

// Written by the follow counters of the removed profile page. Nothing writes
// it now; sign-out still sweeps it from devices that stored one.
function getFollowStatsStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${FOLLOW_STATS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

export function removeLegacySeenPaperIds(storage?: ScopedStorage | null) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(LEGACY_SEEN_PAPERS_KEY);
  } catch {
    // Storage cleanup is best effort.
  }
}

export function clearUserScopedStorage(userId: string | undefined, storage?: (ScopedStorage & Pick<Storage, 'key' | 'length'>) | null) {
  const target = getStorage(storage);
  if (!target || !userId) return;
  const encodedUserId = encodeURIComponent(userId);
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const exactKeys = new Set([
    getSeenPapersStorageKey(userId),
    getDriftCheckStorageKey(userId),
    getFollowStatsStorageKey(userId),
    getOwnListsStorageKey(userId),
    getOwnProfileStorageKey(userId),
    getOnboardingStorageKey(userId),
    getLocalHiddenStorageKey(userId),
    LEGACY_LOCAL_HIDDEN_KEY,
    `papertok_following_${safeUserId}`,
    `papertok_following_updates_${safeUserId}`,
    `papertok_readingLibrary_${userId}`,
  ]);
  const feedPrefix = `papertok_feed_snapshot_${encodedUserId}_`;

  try {
    const keys = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key) keys.push(key);
    }
    keys.filter(key => exactKeys.has(key) || key.startsWith(feedPrefix))
      .forEach(key => target.removeItem(key));
  } catch {
    // Cleanup must not prevent Firebase from ending the session.
  }
}
