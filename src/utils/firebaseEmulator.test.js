import test from 'node:test';
import assert from 'node:assert/strict';
import { firebaseEmulatorConfig, LOCAL_FIRESTORE_BASE } from './firebaseEmulator.js';
import { createFirestoreRest } from './firestoreRest.js';

test('Firebase emulation is opt-in and refuses production builds', () => {
  assert.equal(firebaseEmulatorConfig(), null);
  assert.equal(firebaseEmulatorConfig({ DEV: true }), null);
  assert.throws(() => firebaseEmulatorConfig({ VITE_USE_FIREBASE_EMULATORS: 'true' }), /development server/);
  const config = firebaseEmulatorConfig({ DEV: true, VITE_USE_FIREBASE_EMULATORS: 'true' });
  assert.equal(config.projectId, 'demo-papertok');
  assert.equal(config.apiKey, 'demo-papertok');
});

test('Firestore REST reads use the emulator when configured', async () => {
  const urls = [];
  const client = createFirestoreRest({
    projectId: 'demo-papertok',
    baseUrl: LOCAL_FIRESTORE_BASE,
    fetchImpl: async url => {
      urls.push(String(url));
      return new Response('{}', { status: 404 });
    },
  });
  assert.deepEqual(await client.getDocument('userProfiles/local-user'), {
    exists: false, id: 'local-user', data: null,
  });
  assert.deepEqual(urls, [
    'http://localhost:8080/v1/projects/demo-papertok/databases/(default)/documents/userProfiles/local-user',
  ]);
});
