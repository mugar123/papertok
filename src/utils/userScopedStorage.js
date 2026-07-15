const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_seenIds:';

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

export function removeLegacySeenPaperIds(storage) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(LEGACY_SEEN_PAPERS_KEY);
  } catch {
    // Storage cleanup is best effort.
  }
}

