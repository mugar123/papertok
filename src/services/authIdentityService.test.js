import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AuthIdentityUnsupportedError,
  EmailAlreadyUsedError,
  IdentityAlreadyLinkedError,
  SIGN_IN_PROVIDERS,
  hasSignInProvider,
  linkSignInProvider,
  providerIdsOf,
  signInWithProvider,
} from './authIdentityService.js';

const GITHUB = SIGN_IN_PROVIDERS.github;
const GOOGLE = SIGN_IN_PROVIDERS.google;

function authError(code, email) {
  const error = new Error(code);
  error.code = code;
  if (email) error.customData = { email };
  return error;
}

const PROVIDER_IDS_BY_STUB = { 'google-provider': GOOGLE, 'github-provider': GITHUB };

function fakeApi(overrides = {}) {
  const calls = [];
  return {
    calls,
    api: {
      authentication: { currentUser: null },
      providers: { [GOOGLE]: 'google-provider', [GITHUB]: 'github-provider' },
      isDemo: false,
      popupSignIn: async (authentication, provider) => {
        calls.push(['signIn', provider]);
        return { user: { uid: 'user-1', providerData: [{ providerId: GITHUB }] } };
      },
      popupLink: async (user, provider) => {
        calls.push(['link', user.uid, provider]);
        const providerId = Object.keys(PROVIDER_IDS_BY_STUB).includes(provider)
          ? PROVIDER_IDS_BY_STUB[provider]
          : provider;
        return { user: { ...user, providerData: [...user.providerData, { providerId }] } };
      },
      additionalUserInfo: () => ({ isNewUser: false }),
      ...overrides,
    },
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

test('F5: demo mode has no providers to sign in with', async () => {
  const { api } = fakeApi({ isDemo: true });

  await assert.rejects(() => signInWithProvider(GITHUB, api), AuthIdentityUnsupportedError);
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

// --- structural ------------------------------------------------------------

test('SOURCE: signing in never writes a profile, so the F8 choice cannot be skipped', async () => {
  // "Nobody gets in without choosing" holds because the door and the profile
  // are separate acts: this module has no way to create `userProfiles/{uid}`,
  // and `createUserProfile` refuses without a visibility choice. A GitHub
  // sign-up therefore meets the exact same gate a Google sign-up meets.
  const source = await readFile(new URL('./authIdentityService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /firebase\/firestore/, 'the identity module stays out of Firestore');
  assert.doesNotMatch(source, /userProfiles|createUserProfile|setDoc|writeBatch/);

  const profiles = await readFile(new URL('./userProfileService.js', import.meta.url), 'utf8');
  assert.match(
    profiles,
    /if \(!isVisibilityChoice\(input\?\.visibility\)\) \{\s*\n\s*throw new TypeError/,
    'creating a profile still requires the choice, whichever door was used',
  );
});

test('SOURCE: the pending credential is deliberately never stashed', async () => {
  // `03-AUTH.md` routes the collision through settings, not through a credential
  // held in memory across a sign-in. If that decision is ever revisited, this
  // test is where it gets revisited on purpose.
  const source = await readFile(new URL('./authIdentityService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /credentialFromError|linkWithCredential|signInWithCredential/);
});

test('SOURCE: nothing on the feed path imports the identity service', async () => {
  // The feed-load invariant (one document read) asserted where it can break.
  for (const path of [
    '../context/FeedContext.jsx',
    '../components/Feed/FeedContainer.jsx',
    '../components/Feed/PaperCard.jsx',
    '../utils/interactionProfileLoader.js',
    '../services/interactionProfileStore.js',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /authIdentityService/, `${path} must stay off the auth providers`);
  }
});
