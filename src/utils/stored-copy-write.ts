import type { FieldValue } from 'firebase/firestore';
import type { Paper } from '../models/paper.ts';

import { deleteField } from 'firebase/firestore';

/**
 * A stored copy of a paper as a write sends it: the interaction's `paper` map
 * (`serializeLibraryPaper`) or the `savedPapers` document
 * (`buildSavedPaperPayload`). Every write of either is a
 * `setDoc(..., { merge: true })`, which keeps a stored field the write leaves
 * out, a key of a map included. A copy that writes a text and credits no
 * source for it (ENG-109) therefore deletes the stored `abstractSource`: kept,
 * an earlier copy's credit would name its source under the new text. A copy
 * that writes no text leaves the stored text, and its credit, as they are.
 */
export function copyForMergeWrite<T extends Pick<Partial<Paper>, 'summary' | 'abstractSource'>>(copy: T): Omit<T, 'abstractSource'> & { abstractSource?: T['abstractSource'] | FieldValue } {
  return copy.summary === undefined || copy.abstractSource ? copy : { ...copy, abstractSource: deleteField() };
}
