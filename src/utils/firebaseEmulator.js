/** Explicit opt-in: normal builds keep the production Firebase configuration. */
export function firebaseEmulatorConfig(env = {}) {
  if (env.VITE_USE_FIREBASE_EMULATORS !== 'true') return null;
  if (!env.DEV) throw new Error('Firebase emulators are only supported by the development server.');
  return {
    apiKey: 'demo-papertok',
    authDomain: 'localhost',
    projectId: 'demo-papertok',
    appId: 'demo-papertok',
  };
}

export const LOCAL_AUTH_URL = 'http://localhost:9099';
export const LOCAL_FIRESTORE_BASE = 'http://localhost:8080/v1';
