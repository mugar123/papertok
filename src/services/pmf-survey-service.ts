import { doc, getDoc, runTransaction } from 'firebase/firestore';
import { db } from './firebase.ts';
import { patientRead } from '../utils/bounded-read.ts';
import { documentIsFromServer } from '../utils/cache-authority.ts';
import { pmfSurveyVersionCovers } from '../utils/pmf-survey.ts';

/**
 * The account's own record of the newest app version the fit survey opened
 * for (src/utils/pmf-survey.ts decides who is asked). One document,
 * users/{uid}/settings/pmfSurvey, holding `askedVersion` and nothing else,
 * so writing it touches no other field of the account and no answer is kept
 * in it. firestore.rules lets only the owner read or write it, and only as an
 * app version. It lets one device's ask settle every other device.
 */
function pmfSurveyDoc(uid: string) {
  return doc(db, 'users', uid, 'settings', 'pmfSurvey');
}

/** What the record holds once the survey opened for `version`. */
export function pmfSurveyRecord(version: string) {
  return { askedVersion: version };
}

/**
 * The version the account's record holds, or null when it holds none. A
 * failed or timed-out read rejects, so it is never mistaken for an account
 * that was never asked. Only the server's answer counts, as for the privacy
 * notice's record.
 */
export async function readAccountPmfSurvey(uid: string, signal: AbortSignal) {
  const snapshot = await patientRead(() => getDoc(pmfSurveyDoc(uid)), {
    label: 'fit survey',
    isAnswer: documentIsFromServer,
    signal,
  });
  const version: unknown = snapshot.get('askedVersion');
  return typeof version === 'string' ? version : null;
}

/** Records the survey as asked for `version`, keeping a later version already recorded. */
export async function saveAccountPmfSurvey(uid: string, version: string) {
  const ref = pmfSurveyDoc(uid);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(ref);
    const asked: unknown = snapshot.get('askedVersion');
    if (typeof asked === 'string' && pmfSurveyVersionCovers(asked, version)) return;
    transaction.set(ref, pmfSurveyRecord(version));
  });
}
