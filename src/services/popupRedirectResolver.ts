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
 * not, until the scripts arrive. On an emulated mid-range phone that held the
 * first screen about 2 s. With this subclass Auth reports the session from
 * storage alone, and the scripts load for the first popup or redirect instead.
 *
 * Firebase loads early there because Safari blocks a popup that does not open
 * inside the tap, and `signInWithPopup` opens the window only once the load is
 * done. Screens with sign-in buttons call `preparePopupRedirectResolver` when
 * the buttons appear, so the load is done before the tap.
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
