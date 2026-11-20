/**
 * What `services/firebase.ts` exports, for the DOM tests (see `app-modules.ts`).
 * Only the session is real enough to use: the Worker client reads
 * `auth.currentUser` for its ID token, and the Auth provider listens for it. The Firestore handle is opaque, so a
 * read or write through it rejects, as it does for a signed-out client.
 */
export interface StubUser { uid: string; getIdToken: () => Promise<string> }

export const auth = {
  currentUser: null as StubUser | null,
  // A signed-out session, which is what the Auth provider reads when nobody signed in.
  onAuthStateChanged(report: (user: StubUser | null) => void) {
    queueMicrotask(() => { report(auth.currentUser); });
    return () => {};
  },
};
export const db = {};
export const googleProvider = {};
export const githubProvider = {};
export const popupReadiness = {};
export const popupRedirectResolver = {};
export function emulatorGoogleCredential(name: string) { return name; }
export default { options: { projectId: 'papertok-test' } };

export type FirebaseStub = { auth: typeof auth };
