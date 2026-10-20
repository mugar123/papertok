declare const window: { location: { href: string }; history: { state: unknown; replaceState(data: unknown, unused: string, url: URL): void } };

/**
 * Firebase Configuration
 * Live project configuration for PaperTok
 */

export const IS_DEMO = false;

import type { PopupReadiness } from './popupRedirectResolver.ts';
import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  connectAuthEmulator,
  GithubAuthProvider,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  initializeAuth,
  signInWithCredential,
} from 'firebase/auth';
import { connectFirestoreEmulator, disableNetwork, enableNetwork, getFirestore } from 'firebase/firestore';
import { isOffline, registerStallRecovery } from '../utils/boundedRead.ts';
import { createStreamRecovery } from '../utils/streamRecovery.ts';
import { deferPopupRedirectResolver, preparePopupRedirectResolver } from './popupRedirectResolver.ts';

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
  // Measurement is Vercel Web Analytics and PostHog now (src/services/analyticsService.ts),
  // so leaving the id here would only invite that import back.
};

const app = initializeApp(firebaseConfig);
// Firebase's popup resolver, without its start-up load (popupRedirectResolver.ts).
// The institution link's second Auth instance takes it too (institutionService.ts).
export const popupRedirectResolver = deferPopupRedirectResolver(browserPopupRedirectResolver);
// What `getAuth` sets up, with a popup resolver that loads its scripts after
// Auth reports the session instead of before (popupRedirectResolver.ts).
// Popup and redirect calls pass no resolver, so they use this one. Passing
// `browserPopupRedirectResolver` would get a separate instance that nothing
// has loaded ahead of the tap.
const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
  popupRedirectResolver,
});
// Whether a Google or GitHub window would open inside the press
// (usePopupReady). Demo mode opens no popups, so it loads nothing and no
// control waits.
const popupReadiness: PopupReadiness = IS_DEMO
  ? { ready: true, subscribe: () => () => {} }
  : preparePopupRedirectResolver(auth);

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

// The Auth emulator accepts an unsigned JSON claim set as a Google credential.
// Emulator sign-in below and re-authentication (authIdentityService.ts) both
// build it here, so the same name always reaches the same emulator account.
export function emulatorGoogleCredential(name: string) {
  return GoogleAuthProvider.credential(JSON.stringify({
    sub: name,
    email: `${name}@example.com`,
    email_verified: true,
    name,
  }));
}

// `npm run dev:emulators` starts the Firebase emulators and runs Vite in
// `emulators` mode, which points both SDKs at them, so every account and every
// Firestore read and write stays on this machine. Ports match firebase.json.
//
// A page load with nobody signed in signs in as `tester@example.com`, and
// `?as=<name>` switches to `<name>@example.com`. The same name always
// reopens the same account, and a new one goes through onboarding like any
// first sign-in. The production build drops this whole block.
if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'emulators') {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);

  const url = new URL(window.location.href);
  const requested = url.searchParams.get('as')?.trim().toLowerCase();
  if (requested && !/^[a-z0-9._-]+$/.test(requested)) {
    console.error(`?as=${requested} is not usable as an email local part; use letters, digits, ".", "_" or "-".`);
  } else {
    if (requested) {
      url.searchParams.delete('as');
      window.history.replaceState(window.history.state, '', url);
    }
    auth.authStateReady().then(() => {
      const name = requested || (auth.currentUser ? '' : 'tester');
      if (!name || auth.currentUser?.email === `${name}@example.com`) return undefined;
      return signInWithCredential(auth, emulatorGoogleCredential(name));
    }).catch(error => console.error('Emulator sign-in failed', error));
  }
}

// The one listen stream every SDK read rides can die under a live client and
// the SDK will never notice (utils/streamRecovery.js: 96 s unanswered,
// measured). This is the app's only way to rebuild it: a `patientRead` whose
// attempt is still unanswered at DEFAULT_STALL_MS asks for it, the hostages
// flush as the "not now" it already waits out, and the retry meets the new
// stream. Registered once, here, so no screen has to know about streams.
registerStallRecovery(createStreamRecovery({
  disable: () => disableNetwork(db),
  enable: () => enableNetwork(db),
  isOffline,
}));

export { auth, googleProvider, githubProvider, db, popupReadiness };
export default app;
