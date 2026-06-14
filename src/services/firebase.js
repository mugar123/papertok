/**
 * Firebase Service — with Demo Mode fallback
 * When VITE_FIREBASE_API_KEY is not set, runs in demo mode using localStorage.
 */

export const IS_DEMO = !import.meta.env.VITE_FIREBASE_API_KEY ||
  import.meta.env.VITE_FIREBASE_API_KEY === 'your-api-key-here';

let auth = null;
let googleProvider = null;
let db = null;
let app = null;

if (!IS_DEMO) {
  try {
    const firebaseApp = await import('firebase/app');
    const firebaseAuth = await import('firebase/auth');
    const firebaseFirestore = await import('firebase/firestore');

    const firebaseConfig = {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };

    app = firebaseApp.initializeApp(firebaseConfig);
    auth = firebaseAuth.getAuth(app);
    googleProvider = new firebaseAuth.GoogleAuthProvider();
    db = firebaseFirestore.getFirestore(app);
  } catch (e) {
    console.warn('Firebase init failed, running in demo mode:', e);
  }
}

export { auth, googleProvider, db };
export default app;
