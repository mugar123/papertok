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

  const inLists = new Set();
  if (paperId) {
    lists.forEach((list) => {
      if (Array.isArray(list.paperIds) && list.paperIds.includes(paperId)) {
        inLists.add(list.id);
      }
    });
  }

  return { lists, inLists, authoritative: true };
}
