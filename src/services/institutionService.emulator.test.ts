import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase/app';
import {
  connectAuthEmulator, initializeAuth, inMemoryPersistence, signInAnonymously,
  sendSignInLinkToEmail, signInWithEmailLink, signOut,
} from 'firebase/auth';
import {
  sendInstitutionVerification, completeInstitutionVerification, cancelInstitutionVerification,
  unlinkInstitution,
} from './institutionService.ts';

const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;

test('emulator: email proof preserves the primary UID, rejects reuse and invalid proofs, cancels, switches and unlinks', { skip: !emulator }, async () => {
  assert.match(emulator!, /^(127\.0\.0\.1|localhost):\d+$/, 'only a local emulator is allowed');
  const projectId = 'papertok-168df';
  const config = { projectId, apiKey: 'emulator-only' };
  const primaryApp = initializeApp(config, `pap66-primary-${crypto.randomUUID()}`);
  const secondaryApp = initializeApp(config, `pap66-secondary-${crypto.randomUUID()}`);
  const primary = initializeAuth(primaryApp, { persistence: inMemoryPersistence });
  const secondary = initializeAuth(secondaryApp, { persistence: inMemoryPersistence });
  connectAuthEmulator(primary, `http://${emulator}`, { disableWarnings: true });
  connectAuthEmulator(secondary, `http://${emulator}`, { disableWarnings: true });
  const saved = new Map<string, string>();
  const writes: { uid: string; path: string }[] = [];
  const options: NonNullable<Parameters<typeof sendInstitutionVerification>[1]> = {
    apiBase: 'https://worker.test', origin: 'http://localhost:5173', currentUser: () => primary.currentUser,
    secondaryAuth: () => secondary,
    storage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: key => { saved.delete(key); },
    },
    request: async (url, init) => {
      const body = JSON.parse(init!.body as string);
      if (new URL(url).pathname === '/institution/verification') {
        await sendSignInLinkToEmail(secondary, body.email, {
          url: `http://localhost:5173/institution/verify?state=${body.nonce}`, handleCodeInApp: true,
        });
        return Response.json({ sent: true });
      }
      if (body.institutionToken) {
        const claims = JSON.parse(Buffer.from(body.institutionToken.split('.')[1], 'base64url').toString());
        assert.equal(claims.email_verified, true);
        assert.equal(claims.email.endsWith('@mytum.de'), true);
        assert.notEqual(claims.sub, primary.currentUser!.uid);
      }
      writes.push({ uid: primary.currentUser!.uid, path: new URL(url).pathname });
      return Response.json({ institution: { domain: 'mytum.de', name: 'Technical University of Munich' } });
    },
  };
  async function send() {
    const email = `pap66-${crypto.randomUUID()}@mytum.de`;
    await sendInstitutionVerification(email, options);
    const response = await fetch(`http://${emulator}/emulator/v1/projects/${projectId}/oobCodes`);
    const { oobCodes } = await response.json() as { oobCodes: { email: string; oobLink: string }[] };
    const action = new URL(oobCodes.find(code => code.email === email)!.oobLink);
    const link = new URL(action.searchParams.get('continueUrl')!);
    for (const field of ['oobCode', 'apiKey', 'mode']) link.searchParams.set(field, action.searchParams.get(field)!);
    return { email, link: link.href };
  }
  try {
    const { user } = await signInAnonymously(primary);
    const originalUid = user.uid;
    const proof = await send();
    await completeInstitutionVerification(proof.link, options);
    assert.equal(primary.currentUser!.uid, originalUid);
    assert.equal(secondary.currentUser, null);
    assert.deepEqual(writes, [{ uid: originalUid, path: '/institution/link' }]);
    await assert.rejects(signInWithEmailLink(secondary, proof.email, proof.link), { code: 'auth/invalid-action-code' });

    const invalid = await send();
    const badLink = new URL(invalid.link);
    badLink.searchParams.set('oobCode', 'not-a-valid-proof');
    await assert.rejects(completeInstitutionVerification(badLink.href, options), { code: 'auth/invalid-action-code' });
    cancelInstitutionVerification(options);
    await assert.rejects(completeInstitutionVerification(invalid.link, options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });

    const expired = await send();
    await assert.rejects(completeInstitutionVerification(expired.link, { ...options, now: () => Date.now() + 61 * 60 * 1000 }), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
    const switched = await send();
    await signOut(primary);
    await signInAnonymously(primary);
    await assert.rejects(completeInstitutionVerification(switched.link, options), { code: 'INSTITUTION_VERIFICATION_CANCELED' });
    assert.equal(writes.length, 1);
    await unlinkInstitution(options);
    assert.equal(writes.at(-1)!.path, '/institution/unlink');
    assert.equal(writes.at(-1)!.uid, primary.currentUser!.uid);
  } finally {
    await Promise.all([deleteApp(primaryApp), deleteApp(secondaryApp)]);
  }
});
