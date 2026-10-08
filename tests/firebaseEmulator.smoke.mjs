// Run inside the dev container: node tests/firebaseEmulator.smoke.mjs
// Only the fixed Docker emulator hosts are reachable from this smoke test.
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, deleteUser } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { firebaseEmulatorConfig } from '../src/utils/firebaseEmulator.js';
import { createFirestoreRest } from '../src/utils/firestoreRest.js';

const config = firebaseEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true' });
const app = initializeApp(config, 'docker-smoke');
const other = initializeApp(config, 'docker-smoke-anonymous');
const auth = getAuth(app);
connectAuthEmulator(auth, 'http://firebase:9099', { disableWarnings: true });
const db = getFirestore(app);
const anonymousDb = getFirestore(other);
connectFirestoreEmulator(db, 'firebase', 8080);
connectFirestoreEmulator(anonymousDb, 'firebase', 8080);

let user;
let list;
try {
  ({ user } = await createUserWithEmailAndPassword(auth, `smoke-${Date.now()}@example.test`, 'local-test-password'));
  list = doc(db, 'users', user.uid, 'lists', 'docker-smoke');
  const data = { name: 'Docker smoke list', emoji: 'books', paperIds: [] };
  await setDoc(list, data);
  assert.deepEqual((await getDoc(list)).data(), data);

  const rest = createFirestoreRest({
    projectId: config.projectId,
    baseUrl: 'http://firebase:8080/v1',
    getToken: () => user.getIdToken(),
  });
  assert.deepEqual((await rest.getDocument(list.path)).data, data);
  await assert.rejects(getDoc(doc(anonymousDb, list.path)), error => error.code === 'permission-denied');
  console.log('PASS: local Auth signup, SDK list write/read, REST read, and anonymous access denied.');
} finally {
  try {
    if (list) await deleteDoc(list);
    if (user) await deleteUser(user);
  } finally {
    await Promise.all([deleteApp(app), deleteApp(other)]);
  }
}
