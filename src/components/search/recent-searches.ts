type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;
const keyFor = (uid: string) => `papertok_recentSearches_${uid}`;

export function readRecentSearches(uid: string | undefined, storage?: RecentStorage): string[] {
  if (!uid) return [];
  try {
    const value: unknown = JSON.parse((storage ?? globalThis.localStorage)?.getItem(keyFor(uid)) || '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim()))].slice(0, 5);
  } catch {
    return [];
  }
}

export function updateRecentSearches(uid: string | undefined, query: string, remove = false, storage?: RecentStorage): string[] {
  if (!uid) return [];
  const term = query.trim();
  const previous = readRecentSearches(uid, storage).filter(item => item.toLowerCase() !== term.toLowerCase());
  const next = (remove || !term ? previous : [term, ...previous]).slice(0, 5);
  try { (storage ?? globalThis.localStorage)?.setItem(keyFor(uid), JSON.stringify(next)); } catch { /* Storage can be unavailable; keep this session usable. */ }
  return next;
}
