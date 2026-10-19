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
 * On phones and in Safari, Firebase's resolver loads Google's gapi scripts
 * while Auth starts, and Auth reports no session, signed in or not, until they
 * arrive. On an emulated mid-range phone over Slow 4G that held the first
 * screen about 2 s. With this subclass Auth reports the session without them,
 * and preparePopupRedirectResolver starts the same load right after.
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
 * Once `auth` has reported the session, starts the load Firebase would have
 * made while Auth started, on the devices where it makes it (phones, Safari).
 *
 * A popup opens its window only after this load, and Safari can block a window
 * opened after the tap. As with `getAuth`, every visitor loads it, signed in or
 * not, so a sign-in, a provider link or a re-authentication finds it done. A
 * tap made before it finishes still opens the window late. On other desktop
 * browsers Firebase loads the resolver at the first popup, and this does
 * nothing.
 */
export async function preparePopupRedirectResolver(auth: Auth) {
  await auth.authStateReady();
  const resolver = (auth as unknown as AuthInternals)._popupRedirectResolver;
  // Firebase forgets a failed load, so the popup tries again and reports the
  // error itself.
  if (resolver?._loadBeforeTap) resolver._initialize(auth).catch(() => undefined);
}
