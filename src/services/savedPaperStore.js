import { collection, doc } from 'firebase/firestore';
import { db } from './firebase';
import { encodeFirestoreDocId } from '../utils/firestoreDocId.js';

export function savedPapersRef(userId) {
  return collection(db, 'users', userId, 'savedPapers');
}

/**
 * The one way to address a saved paper's document. The id is encoded
 * (utils/firestoreDocId.js): a raw `doc(..., 'hep-th/0603001')` threw on the
 * slash and the save failed for good, with the aggregate already told.
 */
export function savedPaperDocRef(userId, paperId) {
  return doc(savedPapersRef(userId), encodeFirestoreDocId(paperId));
}
