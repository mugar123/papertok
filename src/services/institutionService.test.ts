import test from 'node:test';
import assert from 'node:assert/strict';
import type { Auth, User, UserCredential } from 'firebase/auth';
import { institutionDomainOf } from '../utils/institutionDomain.ts';
import {
  institutionLabel, normalizeInstitution, needsUniversityProof,
  linkInstitution, unlinkInstitution, sendInstitutionVerification,
  completeInstitutionVerification, cancelInstitutionVerification, pendingInstitutionVerification,
} from './institutionService.ts';

const INSTITUTION = {
  domain: 'usal.es', rorId: 'https://ror.org/02f40zc51', name: 'Universidad de Salamanca',
  acronym: 'USAL', entityId: 'https://idp.usal.es/entity', verifiedAt: '2026-10-20T12:00:00.000Z',
};

function scenario() {
  const saved = new Map<string, string>();
  const calls: { path: string; body: unknown }[] = [];
  const sent: { email: string; url: string }[] = [];
  const cleanup: string[] = [];
  let account: { uid: string; email: string; emailVerified: boolean } | null = { uid: 'primary', email: 'reader@example.com', emailVerified: true };
  const holder = { email: 'alice@usal.es', emailVerified: true, getIdToken: async () => 'verified-secondary-token' } as User;
  const options: NonNullable<Parameters<typeof sendInstitutionVerification>[1]> = {
    isDemo: false, apiBase: 'https://worker.test', origin: 'https://papertok.test',
    currentUser: () => account,
    storage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: key => { saved.delete(key); },
    },
    secondaryAuth: () => ({} as Auth),
    sendEmail: async (_auth, email, settings) => { sent.push({ email, url: settings.url }); },
    emailSignIn: async () => ({ user: holder } as UserCredential),
    additionalUserInfo: () => ({ isNewUser: true, providerId: 'password', profile: null }),
    deleteUser: async () => { cleanup.push('delete'); },
    signOut: async () => { cleanup.push('signOut'); },
    request: async (url, init) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(init!.body as string) });
      return Response.json({ institution: INSTITUTION });
    },
  };
  return { options, calls, sent, cleanup, holder, switchAccount: (next: typeof account) => { account = next; },
    link: () => `${sent.at(-1)!.url}&apiKey=test&mode=signIn&oobCode=one-use-proof` };
}

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


test('a verified primary university address links directly; typed addresses never prove membership', async () => {
  const s = scenario();
  s.switchAccount({ uid: 'primary', email: 'alice@usal.es', emailVerified: true });
  assert.equal(needsUniversityProof('Alice@USAL.es', s.options), false);
  assert.deepEqual(await linkInstitution('Alice@USAL.es', s.options), INSTITUTION);
  assert.deepEqual(s.calls, [{ path: '/institution/link', body: {} }]);
  assert.equal(s.sent.length, 0);
  s.switchAccount({ uid: 'primary', email: 'alice@usal.es', emailVerified: false });
  await assert.rejects(linkInstitution('alice@usal.es', s.options), { code: 'INSTITUTION_EMAIL_NOT_VERIFIED' });
  assert.equal(needsUniversityProof('alice@cs.usal.es', s.options), true);
});

test('email delivery is not membership; completing the proof keeps the primary account and releases the secondary', async () => {
  const s = scenario();
  await sendInstitutionVerification('Alice@USAL.es', s.options);
  assert.equal(s.calls.length, 0);
  assert.equal(s.sent[0].email, 'alice@usal.es');
  assert.equal(s.sent[0].url.includes('alice'), false, 'the email is never in the callback URL');
  assert.deepEqual(await completeInstitutionVerification(s.link(), s.options), INSTITUTION);
  assert.deepEqual(s.calls, [{ path: '/institution/link', body: { institutionToken: 'verified-secondary-token' } }]);
  assert.equal(s.options.currentUser!()?.uid, 'primary');
  assert.deepEqual(s.cleanup, ['delete', 'signOut']);
  assert.equal(pendingInstitutionVerification(s.options), null);
  await assert.rejects(completeInstitutionVerification(s.link(), s.options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
  assert.equal(s.calls.length, 1);
});

test('existing secondary accounts are signed out, never deleted', async () => {
  const s = scenario();
  s.options.additionalUserInfo = () => ({ isNewUser: false, providerId: 'password', profile: null });
  await sendInstitutionVerification('alice@usal.es', s.options);
  await completeInstitutionVerification(s.link(), s.options);
  assert.deepEqual(s.cleanup, ['signOut']);
});

test('cancel, expiry, replacement and switching accounts reject the outstanding proof', async () => {
  for (const action of ['cancel', 'expire', 'replace', 'switch', 'unlink']) {
    const s = scenario();
    await sendInstitutionVerification('alice@usal.es', s.options);
    const link = s.link();
    if (action === 'cancel') cancelInstitutionVerification(s.options);
    if (action === 'expire') s.options.now = () => Date.now() + 61 * 60 * 1000;
    if (action === 'replace') await sendInstitutionVerification('bob@tum.de', s.options);
    if (action === 'switch') s.switchAccount({ uid: 'other', email: 'other@example.com', emailVerified: true });
    if (action === 'unlink') await unlinkInstitution(s.options);
    await assert.rejects(completeInstitutionVerification(link, s.options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
    assert.equal(s.calls.some(call => call.path === '/institution/link'), false, action);
  }
});

test('switching or canceling during credential exchange cannot write to either account', async () => {
  for (const change of ['switch', 'cancel']) {
    const s = scenario();
    s.holder.getIdToken = async () => {
      if (change === 'switch') s.switchAccount({ uid: 'other', email: 'other@example.com', emailVerified: true });
      else cancelInstitutionVerification(s.options);
      return 'token';
    };
    await sendInstitutionVerification('alice@usal.es', s.options);
    await assert.rejects(completeInstitutionVerification(s.link(), s.options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.cleanup, ['delete', 'signOut']);
  }
});

test('invalid, expired and reused Firebase proofs do not reach the Worker', async () => {
  for (const code of ['auth/invalid-action-code', 'auth/expired-action-code']) {
    const s = scenario();
    s.options.emailSignIn = async () => { throw Object.assign(new Error(code), { code }); };
    await sendInstitutionVerification('alice@usal.es', s.options);
    await assert.rejects(completeInstitutionVerification(s.link(), s.options), { code });
    assert.equal(s.calls.length, 0);
  }
  const s = scenario();
  await sendInstitutionVerification('alice@usal.es', s.options);
  await assert.rejects(completeInstitutionVerification(s.sent[0].url, s.options), { code: 'INSTITUTION_TOKEN_INVALID' });
});

test('unsupported institutions and Worker outages remain errors and release temporary credentials', async () => {
  for (const code of ['INSTITUTION_NOT_FOUND', 'INSTITUTION_LOOKUP_UNAVAILABLE']) {
    const s = scenario();
    s.options.request = async () => Response.json({ code }, { status: 502 });
    await sendInstitutionVerification('alice@usal.es', s.options);
    await assert.rejects(completeInstitutionVerification(s.link(), s.options), { code });
    assert.deepEqual(s.cleanup, ['delete', 'signOut']);
  }
});

test('email failures and invalid inputs do not leave an active request', async () => {
  const s = scenario();
  await assert.rejects(sendInstitutionVerification('alice', s.options), { code: 'INSTITUTION_EMAIL_INVALID' });
  s.options.sendEmail = async () => { throw Object.assign(new Error(), { code: 'auth/operation-not-allowed' }); };
  await assert.rejects(sendInstitutionVerification('alice@usal.es', s.options), { code: 'auth/operation-not-allowed' });
  assert.equal(pendingInstitutionVerification(s.options), null);
  assert.equal(s.calls.length, 0);
});

test('unverified or mismatched secondary addresses never reach the Worker', async () => {
  for (const changes of [{ emailVerified: false }, { email: 'other@tum.de' }]) {
    const s = scenario();
    Object.assign(s.holder, changes);
    await sendInstitutionVerification('alice@usal.es', s.options);
    await assert.rejects(completeInstitutionVerification(s.link(), s.options), { code: 'INSTITUTION_EMAIL_NOT_VERIFIED' });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.cleanup, ['delete', 'signOut']);
  }
});

test('blocked browser storage prevents delivery and does not break account loading', async () => {
  const s = scenario();
  s.options.storage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.equal(pendingInstitutionVerification(s.options), null);
  cancelInstitutionVerification(s.options);
  await assert.rejects(sendInstitutionVerification('alice@usal.es', s.options), { code: 'INSTITUTION_STORAGE_UNAVAILABLE' });
  assert.equal(s.sent.length, 0);
});

test('switching accounts during delivery cannot leave a usable request', async () => {
  const s = scenario();
  s.options.sendEmail = async () => { s.switchAccount({ uid: 'other', email: 'other@example.com', emailVerified: true }); };
  await assert.rejects(sendInstitutionVerification('alice@usal.es', s.options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
  assert.equal(pendingInstitutionVerification(s.options), null);
  assert.equal(s.calls.length, 0);
});

test('cleanup failure cannot hide a successful institution write', async () => {
  const s = scenario();
  s.options.deleteUser = async () => { throw new Error('offline'); };
  await sendInstitutionVerification('alice@usal.es', s.options);
  assert.deepEqual(await completeInstitutionVerification(s.link(), s.options), INSTITUTION);
  assert.deepEqual(s.cleanup, ['signOut']);
});

test('the callback credential is removed before routing and analytics can see it', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('./institutionService.ts', import.meta.url).href;
  for (const path of ['/institution/verify', '/institution/verify/']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      globalThis.location = { pathname: ${JSON.stringify(path)}, href: 'https://papertok.test${path}?oobCode=private-test-proof&state=test' };
      let address;
      globalThis.history = { state: null, replaceState(_state, _title, next) { address = next; } };
      const { institutionVerificationLink } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(address, '/institution/verify');
      assert.equal(institutionVerificationLink.includes('private-test-proof'), true);
    `], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
});
