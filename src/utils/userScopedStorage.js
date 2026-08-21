const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_seenIds:';
const DRIFT_CHECK_KEY_PREFIX = 'papertok_profileDriftCheckedAt:';
const FOLLOW_STATS_KEY_PREFIX = 'papertok_followStats:';

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
