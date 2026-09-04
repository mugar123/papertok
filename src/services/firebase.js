/**
 * Firebase Configuration
 * Live project configuration for PaperTok
 */

export const IS_DEMO = false;

import { initializeApp } from 'firebase/app';
import { getAuth, GithubAuthProvider, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyAQKtRz0-PJH7_xOBrFhGeQdbIAHkzV4Q0",
  // Google's sign-in page shows the host of the redirect URI ("Ir a ..."), so
  // the default `papertok-168df.firebaseapp.com` greeted every visitor with a
  // project id nobody recognises. Point it at our own domain: Vercel proxies
  // /__/auth/* straight through to Firebase's handler (see vercel.json), which
  // as a bonus makes the auth cookies first-party. Both OAuth clients must
  // send their callback here — Google's authorized redirect URIs and GitHub's
  // single Authorization callback URL — or sign-in fails with redirect_uri
  // mismatch.
  authDomain: "papertok.app",
  projectId: "papertok-168df",
  storageBucket: "papertok-168df.firebasestorage.app",
  messagingSenderId: "310243065214",
  appId: "1:310243065214:web:623735321262c6e154c72f",
  // No `measurementId`: it named the GA4 property this app used to report to,
  // and the only thing Firebase does with it is hand it to `firebase/analytics`.
  // Measurement is Vercel Web Analytics now (src/services/analyticsService.js),
  // so leaving the id here would only invite that import back.
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();
// `user:email` is requested on purpose (F5). Without it GitHub only hands over
// the public profile, so an account whose email is private arrives with no
// email at all — and an identity with no email can never collide with the
// Google account the same person already has. Firebase would silently mint a
// second uid instead of raising `account-exists-with-different-credential`,
// which is the one case this phase is here to catch. Read-only scope: it lets
// Firebase read the addresses, never write or send.
githubProvider.addScope('user:email');
// Keep Firestore's default in-memory cache. Persistent multi-tab storage can
// exhaust Safari's quota and turn an otherwise recoverable cache miss into a
// fatal internal assertion. PaperTok already keeps its bounded feed snapshot
// separately, so database persistence is unnecessary here.
const db = getFirestore(app);

export { auth, googleProvider, githubProvider, db };
export default app;
