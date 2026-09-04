const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_seenIds:';
const DRIFT_CHECK_KEY_PREFIX = 'papertok_profileDriftCheckedAt:';
const FOLLOW_STATS_KEY_PREFIX = 'papertok_followStats:';
const OWN_LISTS_KEY_PREFIX = 'papertok_ownLists:';
const OWN_PROFILE_KEY_PREFIX = 'papertok_ownProfile:';
const ONBOARDING_KEY_PREFIX = 'papertok_onboarding:';

function getStorage(storage) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getSeenPapersStorageKey(userId) {
  if (!userId) return null;
  return `${SEEN_PAPERS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

export function readSeenPaperIds(userId, storage) {
  const key = getSeenPapersStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return new Set();

  try {
    const parsed = JSON.parse(target.getItem(key) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function saveSeenPaperIds(userId, paperIds, storage, limit = 500) {
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

export function getDriftCheckStorageKey(userId) {
  if (!userId) return null;
  return `${DRIFT_CHECK_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * When this device last verified the interaction aggregate against its
 * subcollection. Kept per device rather than in the aggregate so the check needs
 * no extra Firestore write and no schema change.
 */
export function readProfileDriftCheckedAt(userId, storage) {
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

export function saveProfileDriftCheckedAt(userId, timestamp, storage) {
  const key = getDriftCheckStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    target.setItem(key, String(timestamp));
  } catch {
    // Losing the throttle only means checking again sooner than needed.
  }
}

export function getOwnListsStorageKey(userId) {
  if (!userId) return null;
  return `${OWN_LISTS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

export function getOwnProfileStorageKey(userId) {
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
 * The cost is the same one `readStoredFollowStats` accepts one function up: a
 * list renamed on another device keeps its old name for as long as the read
 * takes. What is NOT accepted is a card that cannot be opened — so a list is
 * stored whole, with its paper ids, or it is not stored at all. A seeded card
 * that opened onto an empty list would be the "we could not find out" lie
 * wearing yet another hat.
 */
export function readStoredLists(userId, storage) {
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

export function saveStoredLists(userId, lists, storage, budgetBytes = OWN_LISTS_STORAGE_BUDGET_BYTES) {
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

/**
 * The owner's public profile, as this device last saw it.
 *
 * The session cache already covers remounts inside a tab. After a reload the
 * first visit to `/profile` used to wait on `userProfiles/{uid}` — a document
 * the auth bootstrap never reads (that one is the private `users/{uid}`).
 * Remembering the public half here lets the masthead paint from what this
 * device already knew, and the network read corrects it behind.
 *
 * Photo is deliberately omitted: it can be tens of kilobytes, and the owner
 * masthead already falls back to the private profile photo AuthContext holds.
 */
export function readStoredProfile(userId, storage) {
  const key = getOwnProfileStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const uid = typeof parsed.uid === 'string' ? parsed.uid : '';
    const handle = typeof parsed.handle === 'string' ? parsed.handle : '';
    const displayName = typeof parsed.displayName === 'string' ? parsed.displayName : '';
    if (!uid || !handle || !displayName) return null;
    return {
      uid,
      handle,
      displayName,
      bio: typeof parsed.bio === 'string' ? parsed.bio : '',
      visibility: parsed.visibility === 'private' ? 'private' : 'public',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      pinnedShareIds: Array.isArray(parsed.pinnedShareIds) ? parsed.pinnedShareIds : [],
      showPinnedLists: parsed.showPinnedLists !== false,
    };
  } catch {
    return null;
  }
}

export function saveStoredProfile(userId, profile, storage) {
  const key = getOwnProfileStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !profile?.uid || !profile.handle || !profile.displayName) return;

  try {
    const createdAt = typeof profile.createdAt === 'string'
      ? profile.createdAt
      : (typeof profile.createdAt?.toDate === 'function'
        ? profile.createdAt.toDate()?.toISOString?.()
        : (profile.createdAt instanceof Date ? profile.createdAt.toISOString() : null));
    target.setItem(key, JSON.stringify({
      uid: profile.uid,
      handle: profile.handle,
      displayName: profile.displayName,
      bio: typeof profile.bio === 'string' ? profile.bio : '',
      visibility: profile.visibility === 'private' ? 'private' : 'public',
      createdAt: createdAt || null,
      pinnedShareIds: Array.isArray(profile.pinnedShareIds) ? profile.pinnedShareIds : [],
      showPinnedLists: profile.showPinnedLists !== false,
    }));
  } catch {
    // A profile that cannot be remembered simply waits for its read again.
  }
}

export function clearStoredProfile(userId, storage) {
  const key = getOwnProfileStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    target.removeItem(key);
  } catch {
    // A copy that cannot be removed is corrected by the next read, as before.
  }
}

export function getOnboardingStorageKey(userId) {
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
export function readStoredOnboarding(userId, storage) {
  const key = getOnboardingStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences.filter(value => typeof value === 'string')
      : [];
    if (parsed.complete !== true && preferences.length === 0) return null;
    return { complete: parsed.complete === true || preferences.length > 0, preferences };
  } catch {
    return null;
  }
}

export function saveStoredOnboarding(userId, state, storage) {
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

export function getFollowStatsStorageKey(userId) {
  if (!userId) return null;
  return `${FOLLOW_STATS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * The follower / following counters of your own profile, as this device last
 * saw them.
 *
 * The session cache already spares every re-entry within a tab, but it dies on
 * reload, and the first visit after one showed an ellipsis for a full round
 * trip — a `count()` aggregation is server-only, so there is no local answer to
 * fall back on. Remembering the last pair here means the header opens on the
 * number instead of on a placeholder, and the aggregation corrects it behind.
 *
 * The cost is honest and small: if somebody followed you while the tab was
 * closed, the old number stands for as long as the read takes. A counter that
 * self-corrects in a few hundred milliseconds beats a counter that admits to
 * knowing nothing.
 */
export function readStoredFollowStats(userId, storage) {
  const key = getFollowStatsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const stat = value => (value && typeof value === 'object' && Number.isFinite(value.count)
      ? { count: value.count, capped: value.capped === true }
      : null);
    const followers = stat(parsed.followers);
    const followed = stat(parsed.followed);
    return followers || followed ? { followers, followed } : null;
  } catch {
    return null;
  }
}

export function saveStoredFollowStats(userId, stats, storage) {
  const key = getFollowStatsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !stats) return;

  try {
    const stat = value => (value && Number.isFinite(value.count)
      ? { count: value.count, capped: value.capped === true }
      : null);
    const payload = { followers: stat(stats.followers), followed: stat(stats.followed) };
    if (!payload.followers && !payload.followed) return;
    target.setItem(key, JSON.stringify(payload));
  } catch {
    // A counter that cannot be remembered simply waits for its read again.
  }
}

export function removeLegacySeenPaperIds(storage) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(LEGACY_SEEN_PAPERS_KEY);
  } catch {
    // Storage cleanup is best effort.
  }
}

export function clearUserScopedStorage(userId, storage) {
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
