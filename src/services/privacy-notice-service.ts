import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase.ts';
import { patientRead } from '../utils/bounded-read.ts';
import { documentIsAuthoritative } from '../utils/cache-authority.ts';

/**
 * The account's own record of the newest privacy policy version whose change
 * notice it was shown (src/utils/nudges.ts decides who is told). One document,
 * users/{uid}/settings/privacyNotice, holding `shownVersion` and nothing else,
 * so writing it touches no other field of the account. It records that the
 * notice was on screen, not that anything was accepted. firestore.rules lets
 * only the owner read or write it, and only as a policy version.
 */
function privacyNoticeDoc(uid: string) {
  return doc(db, 'users', uid, 'settings', 'privacyNotice');
}

/** What the record holds once `version` has been shown. */
export function privacyNoticeRecord(version: string) {
  return { shownVersion: version };
}

/**
 * The version the account's record holds, or null when it holds none. A
 * failed or timed-out read rejects, so it is never mistaken for an account
 * with no record, and an absence only the local cache vouches for is not an
 * answer (patientRead asks again): it would open the notice for an account
 * whose record the server holds.
 */
export async function readAccountPrivacyNotice(uid: string, signal: AbortSignal) {
  const snapshot = await patientRead(() => getDoc(privacyNoticeDoc(uid)), {
    label: 'privacy notice',
    isAnswer: documentIsAuthoritative,
    signal,
  });
  const version: unknown = snapshot.get('shownVersion');
  return typeof version === 'string' ? version : null;
}

/** Records `version` as shown to the account. */
export async function saveAccountPrivacyNotice(uid: string, version: string) {
  await setDoc(privacyNoticeDoc(uid), privacyNoticeRecord(version), { merge: true });
}
