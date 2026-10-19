import { onAuthStateChanged } from 'firebase/auth';
import type { Auth, PopupRedirectResolver } from 'firebase/auth';

// Firebase does not publish these members. Its browser and Cordova resolvers
// share `_initialize` (the load) and `_shouldInitProactively` (overridden
// below), and Auth keeps the resolver it was given in `_popupRedirectResolver`.
interface FirebaseResolver {
  readonly _shouldInitProactively: boolean;
  _initialize(auth: Auth): Promise<unknown>;
}
interface AuthInternals {
  _popupRedirectResolver: (FirebaseResolver & { readonly _loadBeforeTap?: boolean }) | null;
}

/**
 * Firebase's popup and redirect resolver, without its start-up load.
 *
 * On phones and in Safari, Firebase's resolver loads Google's gapi scripts and
 * the auth iframe while Auth starts, and Auth reports no session, signed in or
 * not, until the scripts arrive. On an emulated mid-range phone over Slow 4G
 * that held the first screen about 2 s. With this subclass Auth reports the
 * session without them.
 *
 * The early load lets a popup open inside the tap: `signInWithPopup` opens the
 * window only once the load is done, and Safari blocks a window opened later.
 * On those devices the load still starts before a sign-in button can be
 * tapped, but after the session is reported: as soon as Auth reports that
 * nobody is signed in (prepareWhileSignedOut), and for a signed-in reader when
 * a screen that opens a popup appears (`preparePopupSignIn` in firebase.ts).
 * A tap that comes before the load finishes still opens the window late.
 *
 * Firebase's Node build, which the unit tests import, has no popup resolver.
 * There Auth starts without one, as `getAuth` does.
 */
export function deferPopupRedirectResolver(resolver: PopupRedirectResolver) {
  if (typeof resolver !== 'function') return undefined;
  const Resolver = resolver as unknown as new () => FirebaseResolver;
  class DeferredPopupRedirectResolver extends Resolver {
    // Firebase's own answer, kept for preparePopupRedirectResolver: true on
    // phones and in Safari.
    readonly _loadBeforeTap = super._shouldInitProactively;

    // Auth reads this once while it starts.
    get _shouldInitProactively() {
      return false;
    }
  }
  return DeferredPopupRedirectResolver as unknown as PopupRedirectResolver;
}

/**
 * Starts loading the popup resolver `auth` was given, where Firebase would
 * have loaded it while Auth started. Elsewhere Firebase loads it when a popup
 * is asked for, as it did before.
 */
export function preparePopupRedirectResolver(auth: Auth) {
  const resolver = (auth as unknown as AuthInternals)._popupRedirectResolver;
  // Firebase forgets a failed load, so the popup tries again and reports the
  // error itself.
  if (resolver?._loadBeforeTap) resolver._initialize(auth).catch(() => undefined);
}

/**
 * Prepares the resolver each time `auth` reports that nobody is signed in.
 * From then on any tap can be a sign-in: the welcome's account button, the
 * guest feed's Sign in, a card's Save, the dialog after a protected route.
 */
export function prepareWhileSignedOut(auth: Auth) {
  return onAuthStateChanged(auth, (user) => {
    if (!user) preparePopupRedirectResolver(auth);
  });
}
