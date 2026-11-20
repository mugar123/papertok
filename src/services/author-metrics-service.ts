import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { AUTHOR_METRIC_CONSENT, AUTHOR_METRIC_RECEIPTS, AUTHOR_METRIC_SAVE_PATH, AUTHOR_METRICS_DEFAULT } from '../utils/author-metrics.ts';
import { auth, db } from './firebase.ts';
import { authenticatedWorkerFetch, workerSourceUrl } from './worker-api-client.ts';

function consentRef(uid: string) {
  return doc(db, 'users', uid, AUTHOR_METRIC_CONSENT, 'saves');
}

export async function readAuthorMetricsConsent(uid: string) {
  const snapshot = await getDoc(consentRef(uid));
  const data = snapshot.data();
  return data?.enabled === undefined ? AUTHOR_METRICS_DEFAULT : data.enabled === true;
}

export function writeAuthorMetricsConsent(uid: string, enabled: boolean) {
  return setDoc(consentRef(uid), { enabled, changedAt: serverTimestamp() });
}

async function submitSave(uid: string, paperId: string) {
  const currentUser = auth.currentUser;
  const url = workerSourceUrl(AUTHOR_METRIC_SAVE_PATH);
  if (!url || currentUser?.uid !== uid || !currentUser.emailVerified) return;
  if (!await readAuthorMetricsConsent(uid) || auth.currentUser !== currentUser) return;
  const receipt = crypto.randomUUID();
  const ref = doc(db, 'users', uid, AUTHOR_METRIC_RECEIPTS, receipt);
  await setDoc(ref, { paperId, savedAt: serverTimestamp(), expiresAt: new Date(Date.now() + 5 * 60_000) });
  try {
    if (auth.currentUser !== currentUser) return;
    await authenticatedWorkerFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paperId, receipt }),
      keepalive: true,
    });
  } finally {
    if (auth.currentUser === currentUser) await deleteDoc(ref);
  }
}

export function submitAuthorSave(uid: string, paperId: string) {
  void submitSave(uid, paperId).catch(() => {});
}
