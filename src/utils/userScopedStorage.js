const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_seenIds:';
const DRIFT_CHECK_KEY_PREFIX = 'papertok_profileDriftCheckedAt:';

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
