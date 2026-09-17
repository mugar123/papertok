/**
 * The one thing the landing can know about you before the app boots.
 *
 * Firebase keeps its session in IndexedDB, which nothing can read
 * synchronously before the first paint; so the app leaves this mark in
 * localStorage when a session exists and takes it away when it ends, and the
 * inline gate at the top of index.html reads it. Only the app writes it — a
 * visitor who has never signed in on this browser gets the landing however
 * many times they come back. Mirror of the gate in index.html.
 */
export const SESSION_MARK_KEY = 'papertok_signed_in';

const storageOf = (storage) => storage || (typeof window !== 'undefined' ? window.localStorage : null);

export function markSignedIn(storage) {
  try { storageOf(storage)?.setItem(SESSION_MARK_KEY, '1'); } catch { /* storage denied: the landing shows */ }
}
export function clearSignedIn(storage) {
  try { storageOf(storage)?.removeItem(SESSION_MARK_KEY); } catch { /* same */ }
}
export function hasSignedIn(storage) {
  try { return storageOf(storage)?.getItem(SESSION_MARK_KEY) === '1'; } catch { return false; }
}
