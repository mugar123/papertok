import type { Auth, PopupRedirectResolver } from 'firebase/auth';

// Firebase does not publish these members. Its browser and Cordova resolvers
// share `_initialize` (the load) and `_shouldInitProactively` (overridden
// below), and Auth keeps the resolver it was given in `_popupRedirectResolver`.
interface AuthInternals {
  _popupRedirectResolver: { _initialize(auth: Auth): Promise<unknown> } | null;
}

/**
 * Firebase's popup and redirect resolver, without its start-up load.
 *
 * On phones and in Safari, Firebase's resolver loads Google's gapi scripts and
 * the auth iframe while Auth starts, and Auth reports no session, signed in or
 * not, until the scripts arrive. On an emulated mid-range phone over Slow 4G
 * that held the first screen about 2 s. With this subclass Auth reports the
 * session without them, and they load for the first popup or redirect instead.
 *
 * The early load lets a popup open inside the tap: `signInWithPopup` opens the
 * window only once the load is done, and Safari blocks a window opened later.
 * Screens with sign-in buttons start the load when the buttons appear
 * (`preparePopupSignIn` in firebase.ts), so it is done before the tap.
 *
 * Firebase's Node build, which the unit tests import, has no popup resolver.
 * There Auth starts without one, as `getAuth` does.
 */
export function deferPopupRedirectResolver(resolver: PopupRedirectResolver) {
  if (typeof resolver !== 'function') return undefined;
  const FirebaseResolver = resolver as unknown as new () => object;
  class DeferredPopupRedirectResolver extends FirebaseResolver {
    // Auth reads this once while it starts. Firebase's resolver answers true
    // on phones and in Safari.
    get _shouldInitProactively() {
      return false;
    }
  }
  return DeferredPopupRedirectResolver as unknown as PopupRedirectResolver;
}

/** Starts loading the popup resolver `auth` was given, if it has one. */
export function preparePopupRedirectResolver(auth: Auth) {
  // Firebase forgets a failed load, so the popup tries again and reports the
  // error itself.
  (auth as unknown as AuthInternals)._popupRedirectResolver?._initialize(auth).catch(() => undefined);
}
