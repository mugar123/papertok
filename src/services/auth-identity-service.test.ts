import test from 'node:test';
import assert from 'node:assert/strict';
import { settleWithin } from '../test-support/deadline-harness.ts';
import { clearAuthReturn, offerAuthReturn, peekAuthReturn } from '../utils/auth-return.ts';
import {
  EmailAlreadyUsedError,
  IdentityAlreadyLinkedError,
  SIGN_IN_PROVIDERS,
  abandonRedirectTrip,
  completeRedirectSignIn,
  hasSignInProvider,
  linkSignInProvider,
  providerIdsOf,
  reauthenticateCurrentUser,
  signInEvents,
  signInWithProvider,
} from './auth-identity-service.ts';

const GITHUB = SIGN_IN_PROVIDERS.github;
const GOOGLE = SIGN_IN_PROVIDERS.google;

function authError(code?: string, email?: string) {
  const error = new Error(code) as Error & { code?: string; customData?: { email: string }; email?: string };
  error.code = code;
  if (email) error.customData = { email };
  return error;
}

const PROVIDER_IDS_BY_STUB: Record<string, string> = { 'google-provider': GOOGLE, 'github-provider': GITHUB };

type IdentityApi = NonNullable<Parameters<typeof signInWithProvider>[1]>;

function fakeApi(overrides: IdentityApi = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    api: {
      authentication: { currentUser: null },
      providers: { [GOOGLE]: 'google-provider', [GITHUB]: 'github-provider' },
      popupSignIn: async (authentication, provider) => {
        calls.push(['signIn', provider]);
        return { user: { uid: 'user-1', providerData: [{ providerId: GITHUB }] } };
      },
      popupLink: async (user, provider) => {
        calls.push(['link', user.uid, provider]);
        const providerId = Object.keys(PROVIDER_IDS_BY_STUB).includes(provider as string)
          ? PROVIDER_IDS_BY_STUB[provider as string]
          : provider as string;
        return { user: { ...user, providerData: [...user.providerData, { providerId }] } };
      },
      popupReauthenticate: async (user, provider) => {
        calls.push(['reauthenticate', user.uid, provider]);
        return { user };
      },
      credentialReauthenticate: async (user, credential) => {
        calls.push(['reauthenticateWithCredential', user.uid, JSON.parse(credential.idToken ?? '')]);
        return { user };
      },
      additionalUserInfo: () => ({ isNewUser: false }),
      ...overrides,
    } satisfies IdentityApi,
  };
}

// --- signing up and signing in --------------------------------------------

test('F5: a brand new GitHub account is reported as new, so it is routed to onboarding', async () => {
  const { api, calls } = fakeApi({ additionalUserInfo: () => ({ isNewUser: true }) });

  const result = await signInWithProvider(GITHUB, api);

  assert.equal(result.isNewUser, true);
  assert.equal(result.providerId, GITHUB);
  assert.equal(result.user.uid, 'user-1');
  assert.deepEqual(calls, [['signIn', 'github-provider']]);
});

test('F5: an account that already exists signs in through GitHub without being new', async () => {
  const { api } = fakeApi({ additionalUserInfo: () => ({ isNewUser: false }) });

  const result = await signInWithProvider(GITHUB, api);

  assert.equal(result.isNewUser, false);
  assert.equal(result.user.uid, 'user-1', 'the same uid, not a second account');
});

test('F5: a provider that reports nothing about novelty is treated as an existing account', async () => {
  // Never invent a sign-up event: `sign_up` analytics and the onboarding
  // redirect both hang off this flag.
  const { api } = fakeApi({ additionalUserInfo: () => null });

  const result = await signInWithProvider(GITHUB, api);

  assert.equal(result.isNewUser, false);
});

test('F5: Google still signs in through the same door, untouched', async () => {
  const { api, calls } = fakeApi({ additionalUserInfo: () => ({ isNewUser: true }) });

  const result = await signInWithProvider(GOOGLE, api);

  assert.equal(result.isNewUser, true);
  assert.deepEqual(calls, [['signIn', 'google-provider']], 'Google gets the Google provider');
});

test('F5: an unknown provider is a programming error, not a popup', async () => {
  const { api, calls } = fakeApi();

  await assert.rejects(() => signInWithProvider('twitter.com', api), TypeError);
  assert.deepEqual(calls, [], 'no popup was opened');
});

// --- the email collision ---------------------------------------------------

test('F5: an email that already has an account is a collision, carrying the address', async () => {
  const { api } = fakeApi({
    popupSignIn: async () => {
      throw authError('auth/account-exists-with-different-credential', 'nico@gmail.com');
    },
  });

  const error = await signInWithProvider(GITHUB, api).then(
    () => null,
    caught => caught,
  );

  assert.ok(error instanceof EmailAlreadyUsedError);
  assert.equal(error.code, 'AUTH_EMAIL_ALREADY_USED');
  assert.equal(error.email, 'nico@gmail.com');
  assert.equal(error.providerId, GITHUB, 'the door that was refused, for the copy');
});

test('F5: the collision reads the address from the legacy field too', async () => {
  const error = authError('auth/account-exists-with-different-credential');
  error.email = 'legacy@example.org';
  const { api } = fakeApi({ popupSignIn: async () => { throw error; } });

  const caught = await signInWithProvider(GITHUB, api).catch(failure => failure);

  assert.equal(caught.email, 'legacy@example.org');
});

test('F5: a collision with no address at all still classifies, with empty copy', async () => {
  // Email enumeration protection can strip the address. The guidance survives
  // without it; naming the account is a nicety, not the message.
  const { api } = fakeApi({
    popupSignIn: async () => { throw authError('auth/account-exists-with-different-credential'); },
  });

  const caught = await signInWithProvider(GITHUB, api).catch(failure => failure);

  assert.ok(caught instanceof EmailAlreadyUsedError);
  assert.equal(caught.email, '');
});

test('F5: every other popup failure passes through untranslated', async () => {
  const { api } = fakeApi({
    popupSignIn: async () => { throw authError('auth/popup-closed-by-user'); },
  });

  const caught = await signInWithProvider(GITHUB, api).catch(failure => failure);

  assert.equal(caught.code, 'auth/popup-closed-by-user');
  assert.ok(!(caught instanceof EmailAlreadyUsedError));
});

// --- a blocked window: the sign-in goes through this tab ------------------

// This tab's sessionStorage: what survives the trip to the provider and back.
function tabStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)); },
    removeItem: (key: string) => { items.delete(key); },
  };
}

// A browser that refuses the popup window, as Mobile Safari does when the
// window opens too long after the tap. Its redirect leaves the page, so the
// promise Firebase returns never settles.
function blockingBrowser(tab: ReturnType<typeof tabStorage> | null, overrides: IdentityApi = {}) {
  return fakeApi({
    popupSignIn: async () => { throw authError('auth/popup-blocked'); },
    redirectSignIn: async () => new Promise<never>(() => {}),
    tripStorage: tab,
    ...overrides,
  });
}

// The page the redirect comes back to, after Firebase has finished the sign-in.
function returningPage(tab: ReturnType<typeof tabStorage>, redirectResult: IdentityApi['redirectResult'], overrides: IdentityApi = {}) {
  const results: string[] = [];
  const { api } = fakeApi({
    tripStorage: tab,
    redirectResult: async (authentication) => {
      results.push('read');
      return redirectResult!(authentication);
    },
    ...overrides,
  });
  return { api, results };
}

test('a blocked popup window sends the sign-in through this tab, and the page leaves', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  const redirects: unknown[] = [];
  const { api } = blockingBrowser(tab, {
    redirectSignIn: async (_authentication, provider) => {
      redirects.push(provider);
      return new Promise<never>(() => {});
    },
  });

  const signIn = signInWithProvider(GOOGLE, api, { surface: 'auth_prompt' });

  assert.equal(await settleWithin(100, () => signIn), 'still waiting', 'no error reaches the buttons while the page leaves');
  assert.deepEqual(redirects, ['google-provider'], 'the provider the reader chose');
});

test('the page the redirect comes back to learns the provider, the place and the destination once', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  // A guest bounced off /lists pressed GitHub in the sign-in dialog.
  offerAuthReturn('/lists');
  void signInWithProvider(GITHUB, blockingBrowser(tab).api, { surface: 'auth_prompt' });
  await settleWithin(50, () => undefined);
  // The reload forgets what lived in memory.
  clearAuthReturn();

  const page = returningPage(tab, async () => ({ user: { uid: 'user-1', providerData: [{ providerId: GITHUB }] } }), {
    additionalUserInfo: () => ({ isNewUser: true }),
  });
  const outcome = await completeRedirectSignIn(page.api);

  assert.deepEqual(outcome, { providerId: GITHUB, surface: 'auth_prompt', returnTo: '/lists', result: 'success', isNewUser: true });
  assert.equal(peekAuthReturn(), '/lists', 'the bounced guest still ends on /lists');
  assert.equal(await completeRedirectSignIn(page.api), null, 'a second read, or a reload, finds no sign-in to report');
  assert.deepEqual(page.results, ['read'], 'Firebase is asked once');
});

test('a reader who backs out of the provider page comes back cancelled, not failed', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  void signInWithProvider(GOOGLE, blockingBrowser(tab).api, { surface: 'onboarding' });
  await settleWithin(50, () => undefined);

  const outcome = await completeRedirectSignIn(returningPage(tab, async () => null).api);

  assert.deepEqual(outcome, { providerId: GOOGLE, surface: 'onboarding', returnTo: null, result: 'cancelled' });
});

test('a page shown again after Back, from Safari\'s cache, abandons its trip: a later load reports nothing', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  offerAuthReturn('/lists');
  void signInWithProvider(GITHUB, blockingBrowser(tab).api, { surface: 'auth_prompt' });
  await settleWithin(50, () => undefined);

  // The page was left for the provider and comes back as it was left, in the
  // same tab, with its trip still in the storage.
  const abandoned = abandonRedirectTrip({ tripStorage: tab });

  assert.deepEqual(abandoned, { providerId: GITHUB, surface: 'auth_prompt', returnTo: '/lists', result: 'cancelled' });
  assert.equal(peekAuthReturn(), '/lists', 'the page still shows its dialog and keeps its destination');
  assert.equal(abandonRedirectTrip({ tripStorage: tab }), null, 'the trip ends once');
  const later = returningPage(tab, async () => null);
  assert.equal(await completeRedirectSignIn(later.api), null, 'a later load of this tab finds no sign-in to report');
  assert.deepEqual(later.results, [], 'and does not ask Firebase for one');
});

test('a page that left for no provider has no trip to abandon', () => {
  assert.equal(abandonRedirectTrip({ tripStorage: tabStorage() }), null);
  assert.equal(abandonRedirectTrip({ tripStorage: null }), null);
});

test('a redirect refused for an address another door owns comes back as the collision', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  void signInWithProvider(GITHUB, blockingBrowser(tab).api, { surface: 'auth_prompt' });
  await settleWithin(50, () => undefined);

  const outcome = await completeRedirectSignIn(returningPage(tab, async () => {
    throw authError('auth/account-exists-with-different-credential', 'nico@gmail.com');
  }).api);

  assert.deepEqual(outcome, { providerId: GITHUB, surface: 'auth_prompt', returnTo: null, result: 'error', code: 'AUTH_EMAIL_ALREADY_USED' });
});

test('a page that no redirect sign-in left reads nothing from Firebase', async () => {
  const page = returningPage(tabStorage(), async () => null);

  assert.equal(await completeRedirectSignIn(page.api), null);
  assert.deepEqual(page.results, []);
});

test('a redirect that cannot start reports its own error and leaves nothing to report later', async (t) => {
  t.after(clearAuthReturn);
  const tab = tabStorage();
  const { api } = blockingBrowser(tab, {
    redirectSignIn: async () => { throw authError('auth/unauthorized-domain'); },
  });

  const caught = await signInWithProvider(GOOGLE, api).catch(failure => failure);

  assert.equal(caught.code, 'auth/unauthorized-domain');
  assert.equal(await completeRedirectSignIn(returningPage(tab, async () => null).api), null);
});

test('without this tab\'s storage the blocked window is reported as blocked, with no redirect', async () => {
  const redirects: unknown[] = [];
  const { api } = blockingBrowser(null, {
    redirectSignIn: async (_authentication, provider) => {
      redirects.push(provider);
      return new Promise<never>(() => {});
    },
  });

  const caught = await signInWithProvider(GOOGLE, api).catch(failure => failure);

  assert.equal(caught.code, 'auth/popup-blocked');
  assert.deepEqual(redirects, []);
});

test('a popup that opens never goes through this tab', async () => {
  const tab = tabStorage();
  const redirects: unknown[] = [];
  const { api } = fakeApi({
    redirectSignIn: async (_authentication, provider) => {
      redirects.push(provider);
      return new Promise<never>(() => {});
    },
    tripStorage: tab,
  });

  await signInWithProvider(GOOGLE, api, { surface: 'auth_prompt' });

  assert.deepEqual(redirects, []);
  assert.equal(await completeRedirectSignIn(returningPage(tab, async () => null).api), null);
});

test('a stored trip is checked before it is trusted', async (t) => {
  t.after(clearAuthReturn);
  // Whatever the trip is stored under, a tampered or outdated value replaces it.
  const tamperedTrip = async (trip: unknown) => {
    const tab = tabStorage();
    void signInWithProvider(GOOGLE, blockingBrowser(tab).api);
    await settleWithin(50, () => undefined);
    for (const key of tab.items.keys()) tab.items.set(key, JSON.stringify(trip));
    return completeRedirectSignIn(returningPage(tab, async () => null).api);
  };

  assert.equal(await tamperedTrip({ providerId: 'twitter.com', surface: 'auth_prompt', returnTo: '/lists' }), null, 'an unknown provider is no sign-in of ours');
  const offSite = await tamperedTrip({ providerId: GOOGLE, surface: 'auth_prompt', returnTo: '//evil.example' });
  assert.equal(offSite?.returnTo, null, 'a destination off the site is dropped');
  assert.equal(peekAuthReturn(), null);
});

// --- what a finished sign-in reports ------------------------------------------

test('a redirect sign-in reports what the popup would have: one result, one sign-up', () => {
  assert.deepEqual(signInEvents(GITHUB, 'auth_prompt', { result: 'success', isNewUser: true }), [
    ['auth_result', { method: 'github', surface: 'auth_prompt', result: 'success' }],
    ['sign_up', { method: 'github' }],
  ]);
  assert.deepEqual(signInEvents(GOOGLE, 'onboarding', { result: 'success', isNewUser: false }), [
    ['auth_result', { method: 'google', surface: 'onboarding', result: 'success' }],
    ['login', { method: 'google' }],
  ]);
});

test('a cancellation is reported apart from an error, and neither counts a sign-up', () => {
  assert.deepEqual(signInEvents(GOOGLE, 'auth_prompt', { result: 'cancelled' }), [
    ['auth_result', { method: 'google', surface: 'auth_prompt', result: 'cancelled' }],
  ]);
  assert.deepEqual(signInEvents(GOOGLE, 'auth_prompt', { result: 'error', code: 'auth/network-request-failed' }), [
    ['auth_result', { method: 'google', surface: 'auth_prompt', result: 'error', error_code: 'auth/network-request-failed' }],
  ]);
});

// --- linking a second door -------------------------------------------------

test('F5: linking GitHub attaches it to the account already signed in', async () => {
  const currentUser = { uid: 'user-1', providerData: [{ providerId: GOOGLE }] };
  const { api, calls } = fakeApi({ authentication: { currentUser } });

  const result = await linkSignInProvider(GITHUB, api);

  assert.equal(result.alreadyLinked, false);
  assert.deepEqual(calls, [['link', 'user-1', 'github-provider']]);
  assert.deepEqual(
    providerIdsOf(result.user),
    [GOOGLE, GITHUB],
    'one uid, two doors — no second account, nothing to migrate',
  );
});

test('F5: linking what is already linked costs no popup and is not an error', async () => {
  const currentUser = {
    uid: 'user-1',
    providerData: [{ providerId: GOOGLE }, { providerId: GITHUB }],
  };
  const { api, calls } = fakeApi({ authentication: { currentUser } });

  const result = await linkSignInProvider(GITHUB, api);

  assert.equal(result.alreadyLinked, true);
  assert.deepEqual(calls, [], 'no popup for something already true');
});

test('F5: losing the race to another tab reports already-linked, not a failure', async () => {
  const currentUser = { uid: 'user-1', providerData: [{ providerId: GOOGLE }] };
  const { api } = fakeApi({
    authentication: { currentUser },
    popupLink: async () => { throw authError('auth/provider-already-linked'); },
  });

  const result = await linkSignInProvider(GITHUB, api);

  assert.equal(result.alreadyLinked, true);
});

test('F5: a GitHub identity owned by another account is the accidental-account case', async () => {
  const currentUser = { uid: 'good-account', providerData: [{ providerId: GOOGLE }] };
  const { api } = fakeApi({
    authentication: { currentUser },
    popupLink: async () => { throw authError('auth/credential-already-in-use', 'nico@dev.io'); },
  });

  const caught = await linkSignInProvider(GITHUB, api).catch(failure => failure);

  assert.ok(caught instanceof IdentityAlreadyLinkedError);
  assert.equal(caught.code, 'AUTH_IDENTITY_TAKEN');
  assert.equal(caught.email, 'nico@dev.io');
});

test('F5: an address owned by another account lands on the same explanation', async () => {
  const currentUser = { uid: 'good-account', providerData: [{ providerId: GOOGLE }] };
  const { api } = fakeApi({
    authentication: { currentUser },
    popupLink: async () => { throw authError('auth/email-already-in-use', 'nico@dev.io'); },
  });

  const caught = await linkSignInProvider(GITHUB, api).catch(failure => failure);

  assert.ok(caught instanceof IdentityAlreadyLinkedError, 'one situation, one message');
});

test('F5: linking without a session is refused before any popup', async () => {
  const { api, calls } = fakeApi({ authentication: { currentUser: null } });

  await assert.rejects(() => linkSignInProvider(GITHUB, api), /Authentication is required/);
  assert.deepEqual(calls, []);
});

test('F5: an explicit currentUser override wins over the auth singleton', async () => {
  const { api, calls } = fakeApi({
    authentication: { currentUser: { uid: 'wrong', providerData: [] } },
    currentUser: { uid: 'right', providerData: [{ providerId: GOOGLE }] },
  });

  await linkSignInProvider(GITHUB, api);

  assert.deepEqual(calls, [['link', 'right', 'github-provider']]);
});

// --- signing in again before account deletion ------------------------------

test('signing in again uses a door the account already has', async () => {
  const googleUser = { uid: 'user-1', providerData: [{ providerId: GOOGLE }, { providerId: GITHUB }] };
  const githubUser = { uid: 'user-2', providerData: [{ providerId: GITHUB }] };
  const { api, calls } = fakeApi({ authentication: { currentUser: googleUser } });

  await reauthenticateCurrentUser(api);
  await reauthenticateCurrentUser({ ...api, authentication: { currentUser: githubUser } });

  assert.deepEqual(calls, [
    ['reauthenticate', 'user-1', 'google-provider'],
    ['reauthenticate', 'user-2', 'github-provider'],
  ]);
});

test('choosing another account in the popup reaches the caller as user-mismatch', async () => {
  const currentUser = { uid: 'user-1', providerData: [{ providerId: GOOGLE }] };
  const { api } = fakeApi({
    authentication: { currentUser },
    popupReauthenticate: async () => { throw authError('auth/user-mismatch'); },
  });

  await assert.rejects(() => reauthenticateCurrentUser(api), error => (error as { code?: string }).code === 'auth/user-mismatch');
});

test('signing in again reports the account that confirmed, even if the session switched meanwhile', async () => {
  const alice = { uid: 'alice', providerData: [{ providerId: GOOGLE }] };
  const bob = { uid: 'bob', providerData: [{ providerId: GOOGLE }] };
  const authentication = { currentUser: alice };
  const { api } = fakeApi({
    authentication,
    popupReauthenticate: async (user) => {
      authentication.currentUser = bob; // another tab signs this one in as Bob
      return { user };
    },
  });

  assert.equal(await reauthenticateCurrentUser(api), 'alice');
});

test('a missing session opens no popup', async () => {
  const { api, calls } = fakeApi();

  await assert.rejects(
    () => reauthenticateCurrentUser({ ...api, authentication: { currentUser: null } }),
    /Authentication is required/,
  );
  assert.deepEqual(calls, []);
});

test('the emulator signs in again with the credential it signs in with, without a popup', async () => {
  const currentUser = {
    uid: 'emulator-uid',
    providerData: [{ providerId: GOOGLE, uid: 'alice', email: 'alice@example.com' }],
  };
  const { api, calls } = fakeApi({
    authentication: {
      currentUser,
      emulatorConfig: { protocol: 'http', host: '127.0.0.1', port: 9099, options: { disableWarnings: true } },
    },
  });

  await reauthenticateCurrentUser(api);

  assert.equal(calls.length, 1);
  const [operation, uid, claims] = calls[0] as [string, string, { sub?: string; email?: string }];
  assert.equal(operation, 'reauthenticateWithCredential');
  assert.equal(uid, 'emulator-uid');
  assert.equal(claims.sub, 'alice', 'the Google identity the emulator account was created with');
  assert.equal(claims.email, 'alice@example.com');
});

// --- reading the doors an account has --------------------------------------

test('F5: provider ids survive a malformed providerData without throwing', () => {
  assert.deepEqual(providerIdsOf(null), []);
  assert.deepEqual(providerIdsOf({ providerData: null }), []);
  assert.deepEqual(providerIdsOf({ providerData: [null, { providerId: '' }] }), []);
  assert.deepEqual(
    providerIdsOf({ providerData: [{ providerId: GOOGLE }, { providerId: GITHUB }] }),
    [GOOGLE, GITHUB],
  );
  assert.equal(hasSignInProvider({ providerData: [{ providerId: GOOGLE }] }, GITHUB), false);
  assert.equal(hasSignInProvider({ providerData: [{ providerId: GITHUB }] }, GITHUB), true);
});
