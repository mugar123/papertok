/**
 * Firebase Configuration
 * Live project configuration for PaperTok
 */

export const IS_DEMO = false;

import { initializeApp } from 'firebase/app';
import { getAuth, GithubAuthProvider, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

export const ANALYTICS_MEASUREMENT_ID = import.meta.env?.VITE_GA_MEASUREMENT_ID || 'G-LHG0SGJ6G8';

const firebaseConfig = {
  apiKey: "AIzaSyAQKtRz0-PJH7_xOBrFhGeQdbIAHkzV4Q0",
  authDomain: "papertok-168df.firebaseapp.com",
  projectId: "papertok-168df",
  storageBucket: "papertok-168df.firebasestorage.app",
  messagingSenderId: "310243065214",
  appId: "1:310243065214:web:623735321262c6e154c72f",
  measurementId: ANALYTICS_MEASUREMENT_ID,
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
