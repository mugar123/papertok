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
  // eslint-disable-next-line no-restricted-syntax -- Firebase publishes PopupRedirectResolver and Auth without the members above
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
  // eslint-disable-next-line no-restricted-syntax -- Firebase publishes PopupRedirectResolver and Auth without the members above
  return DeferredPopupRedirectResolver as unknown as PopupRedirectResolver;
}

/** Whether a popup of one Auth instance would open its window inside the press. */
export interface PopupReadiness {
  readonly ready: boolean;
  /** Calls `onReady` once `ready` turns true. Returns the unsubscribe. */
  subscribe(onReady: () => void): () => void;
}

// How long controls wait for the load. After that a press goes through as it
// did before they waited: Firebase finishes the load at the press and reports
// a blocked window itself. The load took about 2 s on an emulated mid-range
// phone over Slow 4G.
const LOAD_WAIT_MS = 10_000;

/**
 * Once `auth` has reported the session, starts the load Firebase would have
 * made while Auth started, on the devices where it makes it (phones, Safari).
 *
 * A popup opens its window only after this load, and Safari can block a window
 * opened after the tap. As with `getAuth`, every visitor loads it, signed in or
 * not. Until the load finishes or fails, or LOAD_WAIT_MS after this call,
 * `ready` is false and the controls that open a popup ignore presses
 * (usePopupReady). On other desktop browsers Firebase loads the resolver
 * inside the first popup's press, so nothing loads here and `ready` is true
 * from the start.
 */
export function preparePopupRedirectResolver(auth: Auth): PopupReadiness {
  // eslint-disable-next-line no-restricted-syntax -- Firebase publishes PopupRedirectResolver and Auth without the members above
  const resolver = (auth as unknown as AuthInternals)._popupRedirectResolver;
  const listeners = new Set<() => void>();
  let ready = true;
  if (resolver?._loadBeforeTap) {
    ready = false;
    const release = () => {
      if (ready) return;
      ready = true;
      for (const listener of listeners) listener();
      listeners.clear();
    };
    const deadline = setTimeout(release, LOAD_WAIT_MS);
    void auth.authStateReady()
      .then(() => resolver._initialize(auth))
      // Firebase forgets a failed load, so the popup tries again at the press
      // and reports the error itself.
      .catch(() => undefined)
      .then(() => {
        clearTimeout(deadline);
        release();
      });
  }
  return {
    get ready() {
      return ready;
    },
    subscribe(onReady) {
      listeners.add(onReady);
      return () => {
        listeners.delete(onReady);
      };
    },
  };
}
