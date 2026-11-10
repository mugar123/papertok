import { getCustomFeedDismissedStorageKey } from './user-scoped-storage.ts';

type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// The papers a reader removed from each custom feed, on this device: one key
// per account holding `{ [feedId]: paperIds }`, oldest first, so sign-out
// (clearUserScopedStorage) sweeps every feed's list at once.

export const MAX_DISMISSED_PER_FEED = 200;

function getStorage(storage?: ScopedStorage | null) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

/** Every feed's list as stored; anything that is not an object of lists reads as none. */
function readAll(key: string, target: ScopedStorage): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(target.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function writeAll(key: string, target: ScopedStorage, lists: Record<string, unknown>) {
  try {
    if (Object.keys(lists).length) target.setItem(key, JSON.stringify(lists));
    else target.removeItem(key);
  } catch {
    // A full or locked storage keeps the removal for this visit only.
  }
}

export function readDismissed(userId: string, feedId: string, storage?: ScopedStorage | null): string[] {
  const key = getCustomFeedDismissedStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return [];
  const list = readAll(key, target)[feedId];
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

/** Stores a feed's removed papers, oldest first, keeping the newest MAX_DISMISSED_PER_FEED. */
export function saveDismissed(userId: string, feedId: string, paperIds: string[], storage?: ScopedStorage | null): void {
  const key = getCustomFeedDismissedStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;
  const lists = readAll(key, target);
  const kept = [...new Set(paperIds)].slice(-MAX_DISMISSED_PER_FEED);
  if (kept.length) lists[feedId] = kept;
  else delete lists[feedId];
  writeAll(key, target, lists);
}

export function forgetDismissed(userId: string, feedId: string, storage?: ScopedStorage | null): void {
  saveDismissed(userId, feedId, [], storage);
}
