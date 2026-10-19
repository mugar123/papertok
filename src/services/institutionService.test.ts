import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { institutionDomainOf } from '../utils/institutionDomain.ts';
import {
  InstitutionLinkError,
  institutionLabel,
  linkInstitution,
  needsUniversityProof,
  normalizeInstitution,
  unlinkInstitution,
} from './institutionService.ts';

const INSTITUTION = {
  domain: 'usal.es',
  rorId: 'https://ror.org/02f40zc51',
  name: 'Universidad de Salamanca',
  acronym: 'USAL',
  entityId: 'https://idp.usal.es/entity',
  verifiedAt: '2026-10-13T10:00:00.000Z',
};

function workerAnswering(status: number, body: { institution?: { domain: string; rorId: string; name: string; acronym: string; entityId: string; verifiedAt: string; }|null; code?: string; }) {
  const calls: { url: string | URL; body: unknown }[] = [];
  return {
    calls,
    request: async (url: string | URL, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify(body), { status });
    },
  };
}

/** A second Auth instance and a Google window, recorded rather than opened. */
function popupStub({ email = 'alice@usal.es', isNewUser = true } = {}) {
  const log: unknown[][] = [];
  const holder = { email, getIdToken: async () => 'university-token' };
  const secondary = { name: 'secondary' };
  return {
    log,
    overrides: {
      secondaryAuth: () => secondary,
      provider: () => ({ setCustomParameters(params) { log.push(['params', params]); } }),
      popupSignIn: async (instance: { name: string; }) => { log.push(['popup', instance === secondary]); return { user: holder }; },
      additionalUserInfo: () => ({ isNewUser }),
      deleteUser: async (user: { email: string; getIdToken: () => Promise<string>; }) => { log.push(['delete', user === holder]); },
      signOut: async (instance: { name: string; }) => { log.push(['signOut', instance === secondary]); },
    } as NonNullable<Parameters<typeof linkInstitution>[1]>,
  };
}

const BASE = {
  isDemo: false,
  apiBase: 'https://worker.test',
};

test('institutionDomainOf reads one lowercased domain and refuses everything else', () => {
  assert.equal(institutionDomainOf(' Alice@USAL.es '), 'usal.es');
  assert.equal(institutionDomainOf('alice@sub.uni-example.ac.uk'), 'sub.uni-example.ac.uk');
  for (const bad of ['', 'alice', '@usal.es', 'alice@', 'alice@localhost', 'a@b@usal.es', 'Alice <alice@usal.es>', 'alice@-usal.es']) {
    assert.equal(institutionDomainOf(bad), '', bad);
  }
});

test('normalizeInstitution keeps the stored shape and drops anything without a domain', () => {
  assert.deepEqual(normalizeInstitution(INSTITUTION), INSTITUTION);
  assert.deepEqual(normalizeInstitution({ domain: 'USAL.ES', name: ' Universidad de Salamanca ' }), {
    domain: 'usal.es',
    rorId: null,
    name: 'Universidad de Salamanca',
    acronym: null,
    entityId: null,
    verifiedAt: null,
  });
  assert.equal(normalizeInstitution({ domain: '' }), null);
  assert.equal(normalizeInstitution('usal.es'), null);
  assert.equal(normalizeInstitution(null), null);
  assert.equal(institutionLabel(INSTITUTION), 'USAL');
  assert.equal(institutionLabel({ ...INSTITUTION, acronym: null }), 'Universidad de Salamanca');
  assert.equal(institutionLabel(null), '');
});

test('an account already on the university address links without a second sign-in', async () => {
  const worker = workerAnswering(200, { institution: INSTITUTION });
  const popup = popupStub();
  const linked = await linkInstitution('Alice@USAL.es', {
    ...BASE,
    ...popup.overrides,
    request: worker.request,
    currentUser: () => ({ uid: 'alice', email: 'alice@usal.es', emailVerified: true }),
  });
  assert.deepEqual(linked, INSTITUTION);
  assert.deepEqual(worker.calls, [{ url: 'https://worker.test/institution/link', body: {} }]);
  assert.deepEqual(popup.log, [], 'no Google window was opened');
});

test('a personal account proves the university through a second sign-in that is then released', async () => {
  const worker = workerAnswering(200, { institution: INSTITUTION });
  const popup = popupStub({ isNewUser: true });
  const linked = await linkInstitution('alice@usal.es', {
    ...BASE,
    ...popup.overrides,
    request: worker.request,
    currentUser: () => ({ uid: 'alice', email: 'alice@gmail.com', emailVerified: true }),
  });
  assert.deepEqual(linked, INSTITUTION);
  assert.deepEqual(worker.calls, [{ url: 'https://worker.test/institution/link', body: { institutionToken: 'university-token' } }]);
  assert.deepEqual(popup.log, [
    ['params', { login_hint: 'alice@usal.es', hd: 'usal.es', prompt: 'select_account' }],
    ['popup', true],
    // Firebase had to create an account for the proof: it is removed again.
    ['delete', true],
  ]);
});

// Safari can block a window opened after the tap, so nothing is awaited
// between the press and the request for Google's window.
test('the press asks for Google\'s window before it awaits anything', async () => {
  const popup = popupStub();
  const linking = linkInstitution('alice@usal.es', {
    ...BASE,
    ...popup.overrides,
    request: workerAnswering(200, { institution: INSTITUTION }).request,
    currentUser: () => ({ uid: 'alice', email: 'alice@gmail.com', emailVerified: true }),
  });
  assert.deepEqual(popup.log.at(-1), ['popup', true]);
  await linking;
});

// The link form and the onboarding's primary hold a press only while it would
// open Google's window, so the answer has to be what linking then does.
test('needsUniversityProof says whether linking that address opens Google\'s window', async () => {
  const cases = [
    { account: { email: 'alice@usal.es', emailVerified: true }, typed: 'Alice@USAL.es', opens: false },
    { account: { email: 'alice@gmail.com', emailVerified: true }, typed: 'alice@usal.es', opens: true },
    { account: { email: 'alice@usal.es', emailVerified: false }, typed: 'alice@usal.es', opens: true },
    { account: { email: 'alice@usal.es', emailVerified: true }, typed: 'alice@cs.usal.es', opens: true },
  ];
  for (const { account, typed, opens } of cases) {
    const currentUser = () => ({ uid: 'alice', ...account });
    assert.equal(needsUniversityProof(typed, { currentUser }), opens, `${account.email} (verified: ${account.emailVerified}) typing ${typed}`);
    const popup = popupStub({ email: typed.toLowerCase() });
    await linkInstitution(typed, { ...BASE, ...popup.overrides, request: workerAnswering(200, { institution: INSTITUTION }).request, currentUser });
    assert.equal(popup.log.some(([step]) => step === 'popup'), opens, `linking ${typed} as ${account.email}`);
  }
  // An account without an address proves no domain, not even an empty one.
  assert.equal(needsUniversityProof('alice', { currentUser: () => ({ uid: 'alice', email: null, emailVerified: true }) }), true);
});

// The proof's sign-in must not outlive the tab. The second instance starts in
// memory, rather than switching to it at the press.
test('SOURCE: the second instance keeps its sign-in in memory from the start', async () => {
  const code = await readFile(new URL('./institutionService.ts', import.meta.url), 'utf8');
  assert.match(code, /initializeAuth\(initializeApp\(app\.options, SECONDARY_APP_NAME\), \{\s*persistence: inMemoryPersistence,/);
});

test('an existing account used as proof is signed out of the second instance, not deleted', async () => {
  const worker = workerAnswering(200, { institution: INSTITUTION });
  const popup = popupStub({ isNewUser: false });
  await linkInstitution('alice@usal.es', {
    ...BASE,
    ...popup.overrides,
    request: worker.request,
    currentUser: () => ({ uid: 'alice', email: 'alice@gmail.com', emailVerified: true }),
  });
  assert.deepEqual(popup.log.slice(-1), [['signOut', true]]);
});

test('the account Google returns must be in the typed domain', async () => {
  const worker = workerAnswering(200, { institution: INSTITUTION });
  const popup = popupStub({ email: 'alice@gmail.com', isNewUser: false });
  await assert.rejects(
    linkInstitution('alice@usal.es', {
      ...BASE,
      ...popup.overrides,
      request: worker.request,
      currentUser: () => ({ uid: 'alice', email: 'other@gmail.com', emailVerified: true }),
    }),
    (error) => error instanceof InstitutionLinkError && error.code === 'INSTITUTION_EMAIL_MISMATCH',
  );
  assert.equal(worker.calls.length, 0, 'nothing reached the Worker');
  assert.deepEqual(popup.log.slice(-1), [['signOut', true]], 'the stray sign-in was released');
});

test('the second sign-in is released even when the Worker refuses', async () => {
  const worker = workerAnswering(404, { code: 'INSTITUTION_NOT_FOUND' });
  const popup = popupStub({ isNewUser: true });
  await assert.rejects(
    linkInstitution('alice@usal.es', {
      ...BASE,
      ...popup.overrides,
      request: worker.request,
      currentUser: () => ({ uid: 'alice', email: 'alice@gmail.com', emailVerified: true }),
    }),
    (error) => (error as InstitutionLinkError).code === 'INSTITUTION_NOT_FOUND' && (error as InstitutionLinkError).status === 404,
  );
  assert.deepEqual(popup.log.slice(-1), [['delete', true]]);
});

test('refuses before any window opens: a bad address, no session, demo mode, no Worker', async () => {
  const popup = popupStub();
  const signedIn = () => ({ uid: 'alice', email: 'alice@gmail.com', emailVerified: true });
  const code = async (promise: Promise<unknown>) => promise.then(() => null, (error: InstitutionLinkError) => error.code);
  assert.equal(await code(linkInstitution('alice', { ...BASE, ...popup.overrides, currentUser: signedIn })), 'INSTITUTION_EMAIL_INVALID');
  assert.equal(await code(linkInstitution('alice@usal.es', { ...BASE, ...popup.overrides, currentUser: () => null })), 'AUTH_REQUIRED');
  assert.equal(await code(linkInstitution('alice@usal.es', { ...BASE, ...popup.overrides, isDemo: true, currentUser: signedIn })), 'INSTITUTION_UNSUPPORTED_IN_DEMO');
  assert.equal(await code(linkInstitution('alice@usal.es', {
    ...BASE,
    ...popup.overrides,
    apiBase: '',
    currentUser: () => ({ uid: 'alice', email: 'alice@usal.es', emailVerified: true }),
  })), 'INSTITUTION_LINK_NOT_CONFIGURED');
  assert.deepEqual(popup.log, []);
});

test('a Worker that cannot be reached, or a dead session, keep their own codes', async () => {
  const signedIn = () => ({ uid: 'alice', email: 'alice@usal.es', emailVerified: true });
  const unreachable = async () => { throw new TypeError('Failed to fetch'); };
  const expired = async () => { const error = new Error('expired') as Error & { code: string }; error.code = 'WORKER_AUTH_REQUIRED'; throw error; };
  await assert.rejects(linkInstitution('alice@usal.es', { ...BASE, request: unreachable, currentUser: signedIn }),
    error => (error as InstitutionLinkError).code === 'INSTITUTION_LINK_UNREACHABLE' && (error as InstitutionLinkError).status === 0);
  await assert.rejects(linkInstitution('alice@usal.es', { ...BASE, request: expired, currentUser: signedIn }),
    error => (error as InstitutionLinkError).code === 'AUTH_REQUIRED' && (error as InstitutionLinkError).status === 401);
});

test('unlinking posts to the Worker and resolves to null', async () => {
  const worker = workerAnswering(200, { institution: null });
  const result = await unlinkInstitution({ ...BASE, request: worker.request, currentUser: () => ({ uid: 'alice' }) });
  assert.equal(result, null);
  assert.deepEqual(worker.calls, [{ url: 'https://worker.test/institution/unlink', body: {} }]);
});
