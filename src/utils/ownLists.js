/**
 * Reading an account's own `lists` collection.
 *
 * Two screens read this collection — the save-and-organize modal and the lists
 * page — and both used to draw the same wrong conclusion from the same
 * snapshot, so the mapping lives here once instead of twice. The rule about
 * *whether the snapshot is worth believing* lives in `cacheAuthority.js`,
 * because three other screens need the same rule.
 */
import { queryIsAuthoritative } from './cacheAuthority.js';

export { queryIsAuthoritative as snapshotIsAuthoritative };

/**
 * Turns a lists snapshot into the two things both screens need: the lists
 * themselves, and which of them already hold this paper.
 *
 * `authoritative: false` means "we could not find out" and must never be
 * rendered as an empty account — that is what made the modal tell an account
 * with four lists that it had none and offer to create one.
 */
export function readOwnLists(snapshot, paperId) {
  if (!queryIsAuthoritative(snapshot)) {
    return { lists: [], inLists: new Set(), authoritative: false };
  }

  const lists = [];
  snapshot.forEach((item) => {
    lists.push({ id: item.id, ...item.data() });
  });

  return { lists, inLists: listsHolding(lists, paperId), authoritative: true };
}

/**
 * Which of these lists already hold this paper.
 *
 * Split out of `readOwnLists` because the same question has to be answered
 * about lists that never came from a snapshot: the save modal now paints from
 * a session cache, and membership is per paper while the cached lists are not.
 */
export function listsHolding(lists, paperId) {
  const inLists = new Set();
  if (!paperId || !Array.isArray(lists)) return inLists;
  lists.forEach((list) => {
    if (Array.isArray(list?.paperIds) && list.paperIds.includes(paperId)) {
      inLists.add(list.id);
    }
  });
  return inLists;
}

/**
 * The lists as they stand after a save, without re-reading them.
 *
 * The save modal paints from a shared session cache, so the cache has to learn
 * what the save just wrote — otherwise reopening the modal on the same paper
 * shows the checkbox it had *before* the save, which is a worse lie than the
 * spinner the cache exists to remove. This mirrors, in memory, exactly what
 * `handleSave` sends to Firestore: `arrayUnion` for `added`, `arrayRemove` for
 * `removed`, both idempotent, so replaying it is always safe.
 *
 * Pure, and it copies rather than mutates: the cached array is shared with
 * whatever is already on screen.
 */
export function withPaperMembership(lists, paperId, { added = [], removed = [] } = {}) {
  if (!Array.isArray(lists) || !paperId) return lists;
  const toAdd = new Set(added);
  const toRemove = new Set(removed);
  if (toAdd.size === 0 && toRemove.size === 0) return lists;

  return lists.map((list) => {
    const paperIds = Array.isArray(list?.paperIds) ? list.paperIds : [];
    if (toAdd.has(list?.id) && !paperIds.includes(paperId)) {
      return { ...list, paperIds: [...paperIds, paperId] };
    }
    if (toRemove.has(list?.id) && paperIds.includes(paperId)) {
      return { ...list, paperIds: paperIds.filter((id) => id !== paperId) };
    }
    return list;
  });
}
