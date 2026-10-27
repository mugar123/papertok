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

/**
 * Whether a popup of one Auth instance would open its window inside the press:
 * `preparing` while the load runs, `ready` once it has finished, `failed` when
 * it failed or ran past LOAD_WAIT_MS. A failed load is not ready: a press
 * would make Firebase load again before it opens the window, and Safari blocks
 * a window opened that late.
 */
export type PopupReadinessState = 'preparing' | 'ready' | 'failed';

export interface PopupReadiness {
  readonly state: PopupReadinessState;
  /** Calls `onChange` after each change of `state`. Returns the unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** After a failure, loads again and waits another LOAD_WAIT_MS. */
  retry(): void;
}

// How long controls wait for the load before they report it failed and offer
// a retry. The load took about 2 s on an emulated mid-range phone over Slow 4G.
const LOAD_WAIT_MS = 10_000;

/**
 * Once `auth` has reported the session, starts the load Firebase would have
 * made while Auth started, on the devices where it makes it (phones, Safari).
 *
 * A popup opens its window only after this load, and Safari can block a window
 * opened after the tap. As with `getAuth`, every visitor loads it, signed in or
 * not. The controls that open a popup stay disabled until `state` is `ready`
 * (usePopupReady). A load that ends after LOAD_WAIT_MS still makes it `ready`.
 * On other desktop browsers Firebase loads the resolver inside the first
 * popup's press, so nothing loads here and `state` is `ready` from the start.
 */
export function preparePopupRedirectResolver(auth: Auth): PopupReadiness {
  // eslint-disable-next-line no-restricted-syntax -- Firebase publishes PopupRedirectResolver and Auth without the members above
  const resolver = (auth as unknown as AuthInternals)._popupRedirectResolver;
  const listeners = new Set<() => void>();
  let state: PopupReadinessState = 'ready';
  let attempt = 0;
  const change = (next: PopupReadinessState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const load = (loader: FirebaseResolver) => {
    attempt += 1;
    const current = attempt;
    change('preparing');
    const fail = () => {
      if (attempt === current && state !== 'ready') change('failed');
    };
    const deadline = setTimeout(fail, LOAD_WAIT_MS);
    // Firebase forgets a failed load, so a retry loads again. A retry while
    // the first load still runs waits on that same load.
    void auth.authStateReady()
      .then(() => loader._initialize(auth))
      .then(() => change('ready'), fail)
      .finally(() => clearTimeout(deadline));
  };
  if (resolver?._loadBeforeTap) load(resolver);
  return {
    get state() {
      return state;
    },
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    retry() {
      if (resolver && state === 'failed') load(resolver);
    },
  };
}
