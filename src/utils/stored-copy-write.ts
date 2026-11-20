import type { FieldValue } from 'firebase/firestore';
import type { Paper } from '../models/paper.ts';

import { deleteField } from 'firebase/firestore';

type SourceField = 'abstractSource' | 'trialRegistrationSource';
type StoredCopy = Pick<Partial<Paper>, 'summary' | 'studyType' | 'trialRegistration' | SourceField>;

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
export function copyForMergeWrite<T extends StoredCopy>(copy: T): Omit<T, SourceField | 'studyType'> & {
  [K in SourceField]?: T[K] | FieldValue;
} & { studyTypes?: Partial<Record<NonNullable<Paper['studyType']>, true>> } {
  const { studyType, ...fields } = copy;
  return {
    ...fields,
    ...(studyType && { studyTypes: { [studyType]: true } }),
    ...(copy.summary !== undefined && !copy.abstractSource && { abstractSource: deleteField() }),
    ...(copy.trialRegistration !== undefined && !copy.trialRegistrationSource && { trialRegistrationSource: deleteField() }),
  };
}
