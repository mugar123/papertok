import type { PaperField } from './list-paper-fields.ts';

import { getDoc, updateDoc } from 'firebase/firestore';
import { copyHoldsField } from '../utils/list-paper-copies.ts';
import { savedPaperDocRef } from './saved-paper-store.ts';

/**
 * Keeps the field a provider gave for a saved paper in its `savedPapers`
 * document, so the provider is asked once and not on every visit to a list.
 * A document that holds a field keeps its own: the row asked because another
 * copy stood in for it. The interaction's copy is left alone: the
 * recommendation profile counts a like or a read under the field it stores.
 */
export async function storePaperField(userId: string, paperId: string, field: PaperField) {
  // Read first: the rules refuse an update of a document that does not exist.
  const saved = await getDoc(savedPaperDocRef(userId, paperId));
  if (saved.exists() && !copyHoldsField({ ...saved.data(), id: paperId })) await updateDoc(saved.ref, field);
}
