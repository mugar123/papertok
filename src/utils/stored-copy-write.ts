import type { Paper } from '../models/paper.ts';

import { deleteField } from 'firebase/firestore';

type StoredCopy = Pick<Partial<Paper>, 'summary' | 'studyType' | 'trialRegistration' | 'abstractSource' | 'trialRegistrationSource' | 'acceptedConference' | 'corpusUpdatedAt'>;

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
export function copyForMergeWrite<T extends StoredCopy>(copy: T) {
  const { studyType, abstractSource, trialRegistrationSource, acceptedConference, ...fields } = copy;
  const conference = acceptedConference
    ? { ...acceptedConference, year: acceptedConference.year ?? deleteField() }
    : copy.corpusUpdatedAt !== undefined ? deleteField() : undefined;
  return {
    ...fields,
    // Firestore merges nested maps. An undated venue must not inherit another venue's year.
    ...(conference && { acceptedConference: conference }),
    ...(studyType && { studyTypes: { [studyType]: true as const } }),
    ...(abstractSource || copy.summary !== undefined ? { abstractSource: abstractSource ?? deleteField() } : {}),
    ...(trialRegistrationSource || copy.trialRegistration !== undefined
      ? { trialRegistrationSource: trialRegistrationSource ?? deleteField() } : {}),
  };
}
