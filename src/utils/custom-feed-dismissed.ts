import { getCustomFeedDismissedStorageKey } from './user-scoped-storage.ts';

type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// The papers a reader removed from each custom feed, on this device: one key
// per account holding `{ [feedId]: paperIds }`, oldest first, so sign-out
// (clearUserScopedStorage) sweeps every feed's list at once. Each change is
// made to the list as it is when the change runs, also an Undo whose toast
// outlived the visit it came from, and the visit on screen hears it.

export const MAX_DISMISSED_PER_FEED = 200;

/** One account's feed, as the lists below are kept. */
const listKey = (userId: string, feedId: string) => `${userId}\n${feedId}`;
/** The lists whose last change storage refused (full or locked), kept for the session instead. */
const unsaved = new Map<string, string[]>();
/** The list each feed last read as, handed out again while unchanged. */
const lastRead = new Map<string, string[]>();
const listeners = new Map<string, Set<() => void>>();

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

/** Whether storage took the lists. */
function writeAll(key: string, target: ScopedStorage, lists: Record<string, unknown>) {
  try {
    if (Object.keys(lists).length) target.setItem(key, JSON.stringify(lists));
    else target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readStored(userId: string, feedId: string, storage?: ScopedStorage | null): string[] {
  const key = getCustomFeedDismissedStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return [];
  const list = readAll(key, target)[feedId];
  return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
}

function store(userId: string, feedId: string, paperIds: string[], storage?: ScopedStorage | null) {
  const key = getCustomFeedDismissedStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return false;
  const lists = readAll(key, target);
  if (paperIds.length) lists[feedId] = paperIds;
  else delete lists[feedId];
  return writeAll(key, target, lists);
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * A feed's removed papers now, oldest first: as stored, so a visit also reads
 * what another tab stored, unless storage refused this session's last change
 * to them. An unchanged list reads as the same array: React's
 * useSyncExternalStore renders again for every new one.
 */
export function readDismissed(userId: string, feedId: string, storage?: ScopedStorage | null): string[] {
  const at = listKey(userId, feedId);
  const ids = unsaved.get(at) ?? readStored(userId, feedId, storage);
  const last = lastRead.get(at);
  if (last && sameIds(last, ids)) return last;
  lastRead.set(at, ids);
  return ids;
}

/**
 * Changes a feed's removed papers from what they are now, keeping the newest
 * MAX_DISMISSED_PER_FEED, and tells the visits listening. A list storage
 * refuses (full or locked) is kept for the rest of the session.
 */
export function changeDismissed(userId: string, feedId: string, change: (paperIds: string[]) => string[], storage?: ScopedStorage | null): void {
  const at = listKey(userId, feedId);
  const ids = [...new Set(change(readDismissed(userId, feedId, storage)))].slice(-MAX_DISMISSED_PER_FEED);
  if (store(userId, feedId, ids, storage)) unsaved.delete(at);
  else unsaved.set(at, ids);
  for (const listener of listeners.get(at) ?? []) listener();
}

/** Calls `listener` after each change to a feed's removed papers; returns the way to stop. */
export function subscribeDismissed(userId: string, feedId: string, listener: () => void): () => void {
  const at = listKey(userId, feedId);
  const feedListeners = listeners.get(at) ?? new Set();
  feedListeners.add(listener);
  listeners.set(at, feedListeners);
  return () => {
    feedListeners.delete(listener);
    if (!feedListeners.size && listeners.get(at) === feedListeners) listeners.delete(at);
  };
}

export function forgetDismissed(userId: string, feedId: string, storage?: ScopedStorage | null): void {
  changeDismissed(userId, feedId, () => [], storage);
}

/** At sign-out: the lists kept in memory go with the account's storage. */
export function forgetSessionDismissed(): void {
  unsaved.clear();
  lastRead.clear();
}
