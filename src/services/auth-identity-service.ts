import type { Auth, OAuthCredential, User, UserInfo } from 'firebase/auth';
import type { ProductAnalyticsEvent } from './analytics-service.ts';
interface IdentityUser {
  uid: string;
  providerData: Array<Pick<UserInfo, 'providerId'> & Partial<Pick<UserInfo, 'uid'>>>;
}
interface IdentityAuth {
  currentUser: IdentityUser | null;
  emulatorConfig?: Auth['emulatorConfig'];
}
interface IdentityOperations {
  authentication?: IdentityAuth;
  providers?: Record<string, unknown>;
  popupSignIn?(authentication: IdentityAuth, provider: unknown): Promise<{ user: IdentityUser }>;
  redirectSignIn?(authentication: IdentityAuth, provider: unknown): Promise<never>;
  redirectResult?(authentication: IdentityAuth): Promise<{ user: IdentityUser } | null>;
  /** This tab's sessionStorage, which carries a redirect sign-in across the reload. */
  tripStorage?: TripStorage | null;
  popupLink?(user: IdentityUser, provider: unknown): Promise<{ user: IdentityUser }>;
  popupReauthenticate?(user: IdentityUser, provider: unknown): Promise<unknown>;
  credentialReauthenticate?(user: IdentityUser, credential: OAuthCredential): Promise<unknown>;
  additionalUserInfo?(result: { user: IdentityUser }): { isNewUser: boolean } | null;
  currentUser?: IdentityUser | null;
}

/**
 * Sign-in identities (F5).
 *
 * The Firebase `uid` is the identity. Google and GitHub are two doors into the
 * same `uid` — never two accounts — so everything here is about which doors an
 * account has and how a second one gets attached to it. Nothing in this module
 * touches Firestore, and signing in creates no profile. A door is not an
 * account.
 *
 * The awkward case is the email collision. Firebase enforces one account per
 * email address, so the second provider carrying an address that already exists
 * fails with `auth/account-exists-with-different-credential` instead of signing
 * anybody in. `03-AUTH.md` settles what to do: guide the person back to the
 * door they already have and let them attach GitHub from settings with
 * `linkWithPopup`. Note what is deliberately absent — the credential riding on
 * that error is *not* stashed for a later automatic link. Holding a live OAuth
 * credential across a sign-in is state this phase does not need, and the plan
 * asks for the settings route by name.
 *
 * The error does not say *which* provider owns the address, and with email
 * enumeration protection turned on `fetchSignInMethodsForEmail` will not say
 * either. So the copy never names one. It says "the method you already use",
 * which is both honest and the only thing that can be proven from here.
 */

import {
  getAdditionalUserInfo,
  getRedirectResult,
  linkWithPopup,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { isInAppPath, offerAuthReturn, peekAuthReturn } from '../utils/auth-return.ts';
import { auth, emulatorGoogleCredential, githubProvider, googleProvider } from './firebase.ts';

/** Firebase provider ids, used as-is: they are what `providerData` reports. */
export const SIGN_IN_PROVIDERS = Object.freeze({
  google: 'google.com',
  github: 'github.com',
});

/**
 * The address already opens an account through some other door. Carries the
 * email because the UI shows it back — that is not a disclosure, the person
 * just typed it into the provider they came from.
 */
export class EmailAlreadyUsedError extends Error {
  declare code: string;
  declare email: string;
  declare providerId: string;
  constructor(email: string, providerId: string) {
    super('That email address already belongs to an account.');
    this.name = 'EmailAlreadyUsedError';
    this.code = 'AUTH_EMAIL_ALREADY_USED';
    this.email = email || '';
    this.providerId = providerId || '';
  }
}

/**
 * The GitHub identity is already a door into a *different* `uid`. This is the
 * accidental-account case of `03-AUTH.md`: two providers with two different
 * emails, used blind, leaving two Firestore trees. They are never merged
 * automatically, and this error is what the UI turns into that explanation.
 */
export class IdentityAlreadyLinkedError extends Error {
  declare code: string;
  declare email: string;
  declare providerId: string;
  constructor(providerId: string, email: string) {
    super('That identity already signs in to another PaperTok account.');
    this.name = 'IdentityAlreadyLinkedError';
    this.code = 'AUTH_IDENTITY_TAKEN';
    this.providerId = providerId || '';
    this.email = email || '';
  }
}

function operations(overrides: IdentityOperations = {}): Required<Omit<IdentityOperations, 'currentUser'>> {
  return {
    authentication: overrides.authentication || auth,
    providers: overrides.providers || {
      [SIGN_IN_PROVIDERS.google]: googleProvider,
      [SIGN_IN_PROVIDERS.github]: githubProvider,
    },
    popupSignIn: overrides.popupSignIn || signInWithPopup,
    redirectSignIn: overrides.redirectSignIn || signInWithRedirect,
    redirectResult: overrides.redirectResult || getRedirectResult,
    tripStorage: overrides.tripStorage === undefined ? sessionTripStorage() : overrides.tripStorage,
    popupLink: overrides.popupLink || linkWithPopup,
    popupReauthenticate: overrides.popupReauthenticate || reauthenticateWithPopup,
    credentialReauthenticate: overrides.credentialReauthenticate || reauthenticateWithCredential,
    additionalUserInfo: overrides.additionalUserInfo || getAdditionalUserInfo,
  };
}

function requireProvider(api: ReturnType<typeof operations>, providerId: string) {
  const provider = api.providers[providerId];
  if (!provider) throw new TypeError(`Unknown sign-in provider: ${providerId}`);
  return provider;
}

function emailFromError(error: unknown) {
  return (error as { customData?: { email?: string } } | null)?.customData?.email || (error as { email?: string } | null)?.email || '';
}

/** Every door this account already has, as Firebase provider ids. */
export function providerIdsOf(user: { providerData?: Array<Pick<User['providerData'][number], 'providerId'> | null> | null } | null | undefined) {
  const entries = Array.isArray(user?.providerData) ? user.providerData : [];
  return entries
    .map(entry => entry?.providerId)
    .filter(providerId => typeof providerId === 'string' && providerId) as string[];
}

export function hasSignInProvider(user: { providerData?: Array<Pick<User['providerData'][number], 'providerId'> | null> | null } | null | undefined, providerId: string) {
  return providerIdsOf(user).includes(providerId);
}

/**
 * Signs in through one provider. The return says whether Firebase had to
 * create the account, which is the whole signal the caller needs: a new account
 * goes to onboarding, an existing one goes home. That routing is identical for
 * every provider, which is precisely why a GitHub sign-up cannot skip a step a
 * Google sign-up takes.
 *
 * The popup comes first everywhere. When the browser blocks its window, as
 * Mobile Safari often does, this tab goes to the provider instead
 * (continueInThisTab) and the promise never settles: the page leaves.
 * `surface` names the place that asked, for the analytics the page it comes
 * back to sends (completeRedirectSignIn).
 */
export async function signInWithProvider(providerId: string, overrides?: IdentityOperations, { surface = 'other' }: { surface?: string } = {}) {
  const api = operations(overrides);
  const provider = requireProvider(api, providerId);

  try {
    const result = await api.popupSignIn(api.authentication, provider);
    return {
      providerId,
      isNewUser: Boolean(api.additionalUserInfo(result)?.isNewUser),
      user: result?.user || null,
    };
  } catch (error) {
    if ((error as { code?: string } | null)?.code === 'auth/account-exists-with-different-credential') {
      throw new EmailAlreadyUsedError(emailFromError(error), providerId);
    }
    if ((error as { code?: string } | null)?.code === 'auth/popup-blocked') {
      return continueInThisTab(api, provider, { providerId, surface, returnTo: peekAuthReturn() }, error);
    }
    throw error;
  }
}

/**
 * What the page a redirect sign-in comes back to needs from the page that
 * left: the provider and the place that asked, for analytics, and the route a
 * guest bounced off a protected page was going to (auth-return.ts), which
 * lives in memory and would not survive the reload. It stays in this tab's
 * sessionStorage from the press until completeRedirectSignIn reads it.
 */
interface RedirectTrip {
  providerId: string;
  surface: string;
  returnTo: string | null;
}
type TripStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const REDIRECT_TRIP_KEY = 'papertok_sign_in_redirect';

function sessionTripStorage(): TripStorage | null {
  // Reading the property throws where the browser blocks storage for the site.
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Firebase's redirect sign-in needs no window, so a browser that blocked the
 * popup cannot block it. This tab goes to the provider through `authDomain`
 * (papertok.app, proxied to Firebase by vercel.json) and comes back to the
 * same address. Rejects when the redirect could not start; on success the
 * page leaves, so there is nothing to resolve with.
 */
async function continueInThisTab(api: ReturnType<typeof operations>, provider: unknown, trip: RedirectTrip, blocked: unknown): Promise<never> {
  // Firebase keeps its own redirect state in the same storage, so without it
  // the sign-in could not finish on the page it comes back to.
  const storage = api.tripStorage;
  if (!storage) throw blocked;
  try {
    storage.setItem(REDIRECT_TRIP_KEY, JSON.stringify(trip));
  } catch {
    throw blocked;
  }
  try {
    return await api.redirectSignIn(api.authentication, provider);
  } catch (error) {
    storage.removeItem(REDIRECT_TRIP_KEY);
    throw error;
  }
}

function takeRedirectTrip(storage: TripStorage | null): RedirectTrip | null {
  let stored: unknown;
  try {
    const raw = storage?.getItem(REDIRECT_TRIP_KEY) ?? null;
    if (raw === null) return null;
    storage?.removeItem(REDIRECT_TRIP_KEY);
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const { providerId, surface, returnTo } = (stored ?? {}) as Partial<Record<keyof RedirectTrip, unknown>>;
  if (typeof providerId !== 'string' || !Object.values<string>(SIGN_IN_PROVIDERS).includes(providerId)) return null;
  return {
    providerId,
    surface: typeof surface === 'string' ? surface : 'other',
    returnTo: isInAppPath(returnTo) ? returnTo : null,
  };
}

/** A sign-in that ended without a session: closed or replaced by the reader, or failed. */
export function signInFailure(error: unknown) {
  const code = (error as { code?: string } | null)?.code || 'other';
  const cancelled = code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request';
  return { result: cancelled ? 'cancelled' as const : 'error' as const, code };
}

type RedirectSignInOutcome = RedirectTrip & (
  | { result: 'success'; isNewUser: boolean }
  | { result: 'cancelled' }
  | { result: 'error'; code: string }
);

/**
 * The redirect sign-in this page comes back from, or null when it comes back
 * from none. Firebase finishes the sign-in itself while Auth starts, so the
 * session arrives as it does after a popup; this reads what the popup's caller
 * would have learnt. It reads once: the trip is removed as it is read, so a
 * second call, or a reload, returns null.
 *
 * The carried destination is offered back before the first `await`: the
 * session can arrive as soon as Auth has started, and app.tsx takes the
 * destination then. A reader who comes back without signing in, from the
 * provider's own Back or Cancel, is `cancelled`, as a closed popup is.
 */
export async function completeRedirectSignIn(overrides?: IdentityOperations): Promise<RedirectSignInOutcome | null> {
  const api = operations(overrides);
  const trip = takeRedirectTrip(api.tripStorage);
  if (!trip) return null;
  offerAuthReturn(trip.returnTo);
  try {
    const result = await api.redirectResult(api.authentication);
    if (!result) return { ...trip, result: 'cancelled' };
    return { ...trip, result: 'success', isNewUser: Boolean(api.additionalUserInfo(result)?.isNewUser) };
  } catch (error) {
    // The collision's address stays behind: the dialog that shows this has
    // only the code, and its copy reads without the address.
    const code = (error as { code?: string } | null)?.code === 'auth/account-exists-with-different-credential'
      ? 'AUTH_EMAIL_ALREADY_USED'
      : signInFailure(error).code;
    return { ...trip, result: 'error', code };
  }
}

/**
 * What a finished sign-in reports, the same for a popup and a redirect: one
 * `auth_result`, and after a success one `sign_up` or `login`. `error_code`
 * is the Firebase code when there is one; a redirect the reader backed out of
 * has none.
 */
export function signInEvents(
  providerId: string,
  surface: string,
  outcome: { result: 'success'; isNewUser: boolean } | { result: 'cancelled' | 'error'; code?: string },
): Array<[ProductAnalyticsEvent, Record<string, unknown>]> {
  const method = Object.entries(SIGN_IN_PROVIDERS).find(([, id]) => id === providerId)?.[0] ?? 'other';
  if (outcome.result === 'success') {
    return [
      ['auth_result', { method, surface, result: 'success' }],
      [outcome.isNewUser ? 'sign_up' : 'login', { method }],
    ];
  }
  return [['auth_result', { method, surface, result: outcome.result, ...(outcome.code ? { error_code: outcome.code } : {}) }]];
}

/**
 * Attaches a second door to the account that is already signed in. Both
 * providers open the same `uid` from here on, so there is no data to migrate:
 * the Firestore tree never moved.
 *
 * Already-linked is success, not failure. Asking for something that is already
 * true is not an error worth showing anybody.
 */
export async function linkSignInProvider(providerId: string, overrides?: IdentityOperations) {
  const api = operations(overrides);
  const provider = requireProvider(api, providerId);
  const user = overrides?.currentUser === undefined
    ? api.authentication?.currentUser
    : overrides.currentUser;
  if (!user) throw new Error('Authentication is required to link a sign-in method.');

  if (hasSignInProvider(user, providerId)) {
    return { providerId, alreadyLinked: true, user };
  }

  try {
    const result = await api.popupLink(user, provider);
    return { providerId, alreadyLinked: false, user: result?.user || user };
  } catch (error) {
    // `provider-already-linked` only reaches here when the link landed between
    // the check above and the popup — a race, and a harmless one.
    if ((error as { code?: string } | null)?.code === 'auth/provider-already-linked') {
      return { providerId, alreadyLinked: true, user };
    }
    // Two different codes, one situation: the identity (or its address) is
    // spoken for by another uid.
    if ((error as { code?: string } | null)?.code === 'auth/credential-already-in-use'
      || (error as { code?: string } | null)?.code === 'auth/email-already-in-use') {
      throw new IdentityAlreadyLinkedError(providerId, emailFromError(error));
    }
    throw error;
  }
}

/**
 * Asks the signed-in person to sign in again through a door the account
 * already has. Firebase deletes a sign-in account only when the session's
 * sign-in is recent, and a session kept open for days is not.
 *
 * Call it directly from the click, before any other `await`: browsers block a
 * popup that a user gesture did not open. Choosing a different account in the
 * popup fails with `auth/user-mismatch` and leaves the session as it was.
 *
 * Resolves with the uid that signed in again, read when the click started.
 * Another tab can switch this tab's session while the window is open, so a
 * caller that acts on the confirmed account uses this uid, not the session.
 */
export async function reauthenticateCurrentUser(overrides?: IdentityOperations) {
  const api = operations(overrides);
  const user = api.authentication?.currentUser;
  if (!user) throw new Error('Authentication is required to confirm the sign-in.');

  // The emulator signs in with an unsigned credential rather than a provider
  // popup (firebase.ts), so it confirms the sign-in the same way.
  if (api.authentication.emulatorConfig) {
    const google = user.providerData.find(entry => entry.providerId === SIGN_IN_PROVIDERS.google);
    if (!google?.uid) throw new Error('The emulator account has no Google identity to confirm.');
    await api.credentialReauthenticate(user, emulatorGoogleCredential(google.uid));
    return user.uid;
  }
  // Any door the account has proves the same uid, so the first one listed is used.
  const providerId = providerIdsOf(user).find(id => api.providers[id]);
  if (!providerId) throw new TypeError('The account has no sign-in provider to confirm.');
  await api.popupReauthenticate(user, requireProvider(api, providerId));
  return user.uid;
}
