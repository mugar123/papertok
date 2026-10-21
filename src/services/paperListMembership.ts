import type { Paper } from '../models/Paper.ts';
import type { OwnList } from '../utils/ownLists.ts';

import { arrayRemove, arrayUnion, collection, doc, getDocs, limit, query, serverTimestamp, where, writeBatch } from 'firebase/firestore';
import { db } from './firebase.ts';
import { queuePublicListSync } from './publicListSync.ts';
import { patientRead } from '../utils/boundedRead.ts';
import { queryIsAuthoritative } from '../utils/cacheAuthority.ts';
import { OWN_LISTS_PAGE_SIZE, readOwnLists, withPaperMembership } from '../utils/ownLists.ts';
import { ownListsCache, reviseOwnLists } from '../utils/profileSessionCaches.ts';
import { publicListSyncKey } from '../utils/publicListFreshness.ts';
import { saveStoredLists } from '../utils/userScopedStorage.ts';

/**
 * The reader's lists that hold this paper, or null when a full page may have
 * stopped short of them. Always asked of Firestore: the session's cached lists
 * are one page of them, and a list past that page would keep the paper while
 * the card said it was gone. Read through `patientRead`: a bare `getDocs` on a
 * listen stream that died under an open tab never settled, and the unsave
 * waiting on it left Save pressed. It also waits past an empty answer served
 * from the local cache.
 */
export async function readListsHoldingPaper(uid: string, paperId: string): Promise<OwnList[] | null> {
  const snapshot = await patientRead(() => getDocs(query(
    collection(db, 'users', uid, 'lists'),
    where('paperIds', 'array-contains', paperId),
    limit(OWN_LISTS_PAGE_SIZE),
  )), { label: 'lists holding paper', isAnswer: queryIsAuthoritative });
  if (snapshot.size >= OWN_LISTS_PAGE_SIZE) return null;
  return readOwnLists(snapshot, paperId).lists;
}

/**
 * Adds the paper to these lists, or takes it out of them: the list documents,
 * the public copy of any published list, and the session's cached lists. The
 * list documents change together or not at all, so a refused write never
 * leaves the paper in some of them.
 */
export async function writeListMembership({ uid, paper, lists, added, language }: {
  uid: string; paper: Paper; lists: OwnList[]; added: boolean; language: string;
}) {
  if (lists.length === 0) return;
  const batch = writeBatch(db);
  for (const list of lists) {
    batch.update(doc(db, 'users', uid, 'lists', list.id), {
      paperIds: added ? arrayUnion(paper.id) : arrayRemove(paper.id),
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
  const cached = ownListsCache.get(uid);
  for (const passed of lists) {
    // The session's own copy is newer than a list handed over from before an
    // Undo, so a published list is republished as it is now.
    const list = cached?.find(entry => entry.id === passed.id) ?? passed;
    if (!list.publicShareId) continue;
    queuePublicListSync({
      key: publicListSyncKey(uid, list.id),
      shareId: list.publicShareId,
      listId: list.id,
      title: list.name,
      description: list.description,
      language,
      paperIds: added
        ? [...new Set([...(list.paperIds || []), paper.id])]
        : (list.paperIds || []).filter(id => id !== paper.id),
      papers: added ? [{ ...paper, listPaperId: paper.id }] : [],
    });
  }
  if (cached) {
    const ids = lists.map(list => list.id);
    reviseOwnLists(uid, withPaperMembership(cached, paper.id, added ? { added: ids } : { removed: ids }));
    saveStoredLists(uid, ownListsCache.get(uid));
  }
}
