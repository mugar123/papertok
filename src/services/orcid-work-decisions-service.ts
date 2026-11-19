import { arrayRemove, arrayUnion, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.ts';

/**
 * What the reader said about the works OpenAlex attributes to their ORCID iD
 * that their ORCID record does not list (My profile, "Might also be yours"):
 * `mine` holds those they added to their publications, `notMine` those they
 * said are someone else's. One document, users/{uid}/orcid/works, holding only
 * the works' identifiers as orcid-service.ts names them (`doi:<DOI>` or
 * `openalex:<work id>`). firestore.rules lets only its owner read it, and
 * write it only while an ORCID iD is connected; the Worker deletes it when ORCID is
 * disconnected or connected again, and with the account.
 */
export interface OrcidWorkDecisions { mine: string[]; notMine: string[] }
export type OrcidWorkDecision = 'mine' | 'notMine';

function decisionsDoc(uid: string) {
  return doc(db, 'users', uid, 'orcid', 'works');
}

function keysOf(value: unknown) {
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
}

/** The account's decisions; none when it has made none. A failed read rejects. */
export async function readOrcidWorkDecisions(uid: string): Promise<OrcidWorkDecisions> {
  const snapshot = await getDoc(decisionsDoc(uid));
  return { mine: keysOf(snapshot.get('mine')), notMine: keysOf(snapshot.get('notMine')) };
}

/**
 * The write that records `decision` about a work, kept under its first name in
 * `keys` (orcidWorkKeys in orcid-service.ts), or that forgets it when null.
 * Every name of the work leaves the other list, so a work is never in both;
 * each list changes atomically, so two tabs deciding about different works
 * keep both decisions.
 */
export function orcidWorkDecisionWrite(keys: string[], decision: OrcidWorkDecision | null) {
  return {
    mine: decision === 'mine' ? arrayUnion(keys[0]) : arrayRemove(...keys),
    notMine: decision === 'notMine' ? arrayUnion(keys[0]) : arrayRemove(...keys),
    updatedAt: serverTimestamp(),
  };
}

export async function saveOrcidWorkDecision(uid: string, keys: string[], decision: OrcidWorkDecision | null) {
  await setDoc(decisionsDoc(uid), orcidWorkDecisionWrite(keys, decision), { merge: true });
}
