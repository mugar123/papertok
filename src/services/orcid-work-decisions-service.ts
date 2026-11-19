import { arrayRemove, arrayUnion, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.ts';

/**
 * What the reader said about the works OpenAlex attributes to their ORCID iD
 * that their ORCID record does not list (My profile, "Might also be yours"):
 * `mine` holds those they added to their publications, `notMine` those they
 * said are someone else's. One document, users/{uid}/orcid/works, holding only
 * the works' identifiers as orcid-service.ts names them (`doi:<DOI>` or
 * `openalex:<work id>`), and `connectedAt`, the time of the connection they
 * were made for as users/{uid}.orcid records it (worker/orcid.ts).
 * firestore.rules lets only its owner read it, and write it only naming the
 * connection the account holds now, so a tab still showing an earlier
 * connection cannot add to the next one; the Worker deletes it when ORCID is
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

/** The decisions `snapshot` holds when they were made for the connection made at `connectedAt`; none otherwise. */
export function decisionsForConnection(snapshot: { get(field: string): unknown }, connectedAt: string | null): OrcidWorkDecisions {
  if (connectedAt === null || snapshot.get('connectedAt') !== connectedAt) return { mine: [], notMine: [] };
  return { mine: keysOf(snapshot.get('mine')), notMine: keysOf(snapshot.get('notMine')) };
}

/** The account's decisions about the connection made at `connectedAt`; none when it has made none. A failed read rejects. */
export async function readOrcidWorkDecisions(uid: string, connectedAt: string | null): Promise<OrcidWorkDecisions> {
  return decisionsForConnection(await getDoc(decisionsDoc(uid)), connectedAt);
}

/**
 * The write that records `decision` about a work, kept under its first name in
 * `keys` (orcidWorkKeys in orcid-service.ts), or that forgets it when null,
 * for the connection made at `connectedAt`. The rules refuse it once that is
 * no longer the account's connection.
 * Every name of the work leaves the other list, so a work is never in both;
 * each list changes atomically, so two tabs deciding about different works
 * keep both decisions.
 */
export function orcidWorkDecisionWrite(connectedAt: string | null, keys: string[], decision: OrcidWorkDecision | null) {
  return {
    connectedAt,
    mine: decision === 'mine' ? arrayUnion(keys[0]) : arrayRemove(...keys),
    notMine: decision === 'notMine' ? arrayUnion(keys[0]) : arrayRemove(...keys),
    updatedAt: serverTimestamp(),
  };
}

export async function saveOrcidWorkDecision(uid: string, connectedAt: string | null, keys: string[], decision: OrcidWorkDecision | null) {
  await setDoc(decisionsDoc(uid), orcidWorkDecisionWrite(connectedAt, keys, decision), { merge: true });
}
