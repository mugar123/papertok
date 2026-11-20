import type { Paper } from '../models/paper.ts';
import { collection, doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.ts';
import { encodeFirestoreDocId } from '../utils/firestore-doc-id.ts';
import { buildSavedPaperPayload } from '../utils/saved-paper-payload.ts';
import { copyForMergeWrite } from '../utils/stored-copy-write.ts';

export function savedPapersRef(userId: string) {
  return collection(db, 'users', userId, 'savedPapers');
}

/**
 * The one way to address a saved paper's document. The id is encoded
 * (utils/firestore-doc-id.ts): a raw `doc(..., 'hep-th/0603001')` threw on the
 * slash and the save failed for good, with the aggregate already told.
 */
export function savedPaperDocRef(userId: string, paperId: string) {
  return doc(savedPapersRef(userId), encodeFirestoreDocId(paperId));
}

export function writeSavedPaperCopy(uid: string, paper: Paper, newSave: boolean) {
  const payload = buildSavedPaperPayload(paper, newSave ? serverTimestamp() : undefined);
  return setDoc(savedPaperDocRef(uid, paper.id), copyForMergeWrite(payload), { merge: true });
}
