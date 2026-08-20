/**
 * Sign-in identities (F5).
 *
 * The Firebase `uid` is the identity. Google and GitHub are two doors into the
 * same `uid` — never two accounts — so everything here is about which doors an
 * account has and how a second one gets attached to it. Nothing in this module
 * touches Firestore: signing in creates no profile, and the privacy choice of
 * F8 keeps happening where it always happened, in the profile editor. A door is
 * not an account.
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
  linkWithPopup,
  signInWithPopup,
} from 'firebase/auth';
import { auth, githubProvider, googleProvider, IS_DEMO } from './firebase.js';

/** Firebase provider ids, used as-is: they are what `providerData` reports. */
export const SIGN_IN_PROVIDERS = Object.freeze({
  google: 'google.com',
  github: 'github.com',
});

export class AuthIdentityUnsupportedError extends Error {
  constructor() {
    super('Sign-in providers are unavailable in demo mode.');
    this.name = 'AuthIdentityUnsupportedError';
    this.code = 'AUTH_PROVIDERS_UNSUPPORTED_IN_DEMO';
  }
}

/**
 * The address already opens an account through some other door. Carries the
 * email because the UI shows it back — that is not a disclosure, the person
 * just typed it into the provider they came from.
 */
export class EmailAlreadyUsedError extends Error {
  constructor(email, providerId) {
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
  constructor(providerId, email) {
    super('That identity already signs in to another PaperTok account.');
    this.name = 'IdentityAlreadyLinkedError';
    this.code = 'AUTH_IDENTITY_TAKEN';
    this.providerId = providerId || '';
    this.email = email || '';
  }
}

function operations(overrides = {}) {
  return {
    authentication: overrides.authentication || auth,
    providers: overrides.providers || {
      [SIGN_IN_PROVIDERS.google]: googleProvider,
      [SIGN_IN_PROVIDERS.github]: githubProvider,
    },
    popupSignIn: overrides.popupSignIn || signInWithPopup,
    popupLink: overrides.popupLink || linkWithPopup,
    additionalUserInfo: overrides.additionalUserInfo || getAdditionalUserInfo,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new AuthIdentityUnsupportedError();
}

function requireProvider(api, providerId) {
  const provider = api.providers[providerId];
  if (!provider) throw new TypeError(`Unknown sign-in provider: ${providerId}`);
  return provider;
}

function emailFromError(error) {
  return error?.customData?.email || error?.email || '';
}

/** Every door this account already has, as Firebase provider ids. */
export function providerIdsOf(user) {
  const entries = Array.isArray(user?.providerData) ? user.providerData : [];
  return entries
    .map(entry => entry?.providerId)
    .filter(providerId => typeof providerId === 'string' && providerId);
}

export function hasSignInProvider(user, providerId) {
  return providerIdsOf(user).includes(providerId);
}

/**
 * Signs in through one provider. The return says whether Firebase had to
 * create the account, which is the whole signal the caller needs: a new account
 * goes to onboarding, an existing one goes home. That routing is identical for
 * every provider, which is precisely why a GitHub sign-up cannot skip a step a
 * Google sign-up takes.
 */
export async function signInWithProvider(providerId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const provider = requireProvider(api, providerId);

  try {
    const result = await api.popupSignIn(api.authentication, provider);
    return {
      providerId,
      isNewUser: Boolean(api.additionalUserInfo(result)?.isNewUser),
      user: result?.user || null,
    };
  } catch (error) {
    if (error?.code === 'auth/account-exists-with-different-credential') {
      throw new EmailAlreadyUsedError(emailFromError(error), providerId);
    }
    throw error;
  }
}

/**
 * Attaches a second door to the account that is already signed in. Both
 * providers open the same `uid` from here on, so there is no data to migrate:
 * the Firestore tree never moved.
 *
 * Already-linked is success, not failure. Asking for something that is already
 * true is not an error worth showing anybody.
 */
export async function linkSignInProvider(providerId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
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
    if (error?.code === 'auth/provider-already-linked') {
      return { providerId, alreadyLinked: true, user };
    }
    // Two different codes, one situation: the identity (or its address) is
    // spoken for by another uid.
    if (error?.code === 'auth/credential-already-in-use'
      || error?.code === 'auth/email-already-in-use') {
      throw new IdentityAlreadyLinkedError(providerId, emailFromError(error));
    }
    throw error;
  }
}
