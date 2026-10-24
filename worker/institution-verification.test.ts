import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { WorkerEnv } from './env.ts';
import type { TestNamespace } from './test-types.ts';
import type { LedgerTransaction } from './ledger-storage.ts';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { handleInstitutionVerificationRequest } from './institution-verification.ts';
import { resetAccessTokenCache } from './firebase-service-account.ts';
import { applyEmailDeliveryLedgerAction, type DeliveryLedgerState } from './email-delivery-ledger.ts';
import { RequestQuotaLedger } from './request-quota-ledger.ts';
import worker from './index.ts';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const token = fakeIdToken({ aud: 'papertok-168df', sub: 'primary' });
const nonce = '4cfcdddf-40ac-40b1-89c4-269dbfa6518a';

function request(body: unknown = { email: 'Student@comunidadunir.net', nonce }, {
  origin = 'https://papertok.app', authorization = `Bearer ${token}`, method = 'POST',
  url = 'https://api.papertok.app/institution/verification',
} = {}) {
  return new Request(url, {
    method, headers: { origin, authorization, 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function harness(t: TestContext) {
  resetAccessTokenCache();
  let ledger: DeliveryLedgerState = {};
  let recipient = 'reader@example.org';
  let uid = 'primary';
  let verified = true;
  let providers: { providerId: string; email?: string }[] = [];
  let resendStatus = 201;
  let generationStatus = 200;
  let timeout = false;
  const generated: Record<string, unknown>[] = [];
  const messages: { from: string; to: string[]; html: string; text: string; headers?: Record<string, string> }[] = [];
  const deliveries: TestNamespace = {
    idFromName: name => name,
    get: () => ({ fetch: async (_url, init) => {
      const outcome = applyEmailDeliveryLedgerAction(ledger, JSON.parse(init!.body as string));
      ledger = outcome.state;
      return Response.json(outcome.result, { status: outcome.status });
    } }),
  };
  const quotas = new Map<string, RequestQuotaLedger>();
  const quotaNamespace: TestNamespace = {
    idFromName: name => name,
    get: id => ({ fetch: async (url, init) => {
      const key = String(id);
      if (!quotas.has(key)) {
        const values = new Map<string, unknown>();
        const transaction: LedgerTransaction = {
          get: <T>(key: string) => values.get(key) as T | undefined,
          put: (key, value) => values.set(key, value), delete: key => values.delete(key),
        };
        quotas.set(key, new RequestQuotaLedger({ storage: {
          transaction: callback => callback(transaction), getAlarm: async () => 1,
          setAlarm: async () => {}, deleteAll: async () => values.clear(),
        } }));
      }
      return quotas.get(key)!.fetch(new Request(url, init));
    } }),
  };
  const env: WorkerEnv = {
    FIREBASE_PROJECT_ID: 'papertok-168df', FIREBASE_WEB_API_KEY: 'web-key',
    FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@papertok-168df.iam.gserviceaccount.com',
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
    RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: 'PaperTok <hello@papertok.app>',
    EMAIL_DELIVERY_LEDGER: deliveries as Env['EMAIL_DELIVERY_LEDGER'],
    REQUEST_QUOTA_LEDGER: quotaNamespace as Env['REQUEST_QUOTA_LEDGER'],
    EMAIL_DAILY_SEND_LIMIT: '290',
  };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('accounts:lookup')) {
      return Response.json({ users: [{ localId: uid, email: recipient, emailVerified: verified, providerUserInfo: providers }] });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init!.body as string).get('assertion')!.split('.')[1], 'base64url').toString());
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/cloud-platform');
      return Response.json({ access_token: 'synthetic-access-token', expires_in: 3600 });
    }
    if (url.endsWith('accounts:sendOobCode')) {
      const body = JSON.parse(init!.body as string);
      generated.push(body);
      assert.equal(body.returnOobLink, true, 'Firebase must never deliver the email');
      assert.equal(body.requestType, 'EMAIL_SIGNIN');
      assert.equal(body.targetProjectId, 'papertok-168df');
      const link = new URL('https://papertok-168df.firebaseapp.com/__/auth/action');
      link.search = new URLSearchParams({ mode: 'signIn', apiKey: 'web-key', oobCode: 'secret-proof', continueUrl: body.continueUrl }).toString();
      return Response.json({ oobLink: link.href }, { status: generationStatus });
    }
    if (url === 'https://api.resend.com/emails') {
      messages.push(JSON.parse(init!.body as string));
      if (timeout) throw new DOMException('Timed out', 'TimeoutError');
      return Response.json(resendStatus === 201 ? { id: 'delivered' } : { code: 'provider-rejection' }, { status: resendStatus });
    }
    throw new Error('Unexpected upstream');
  });
  return {
    env, generated, messages, ledger: () => ledger,
    setLedger: (value: DeliveryLedgerState) => { ledger = value; },
    setVerified: (value: boolean) => { verified = value; },
    setProviders: (value: { providerId: string; email?: string }[]) => { providers = value; },
    setIdentity: (value: string) => { uid = value; recipient = `${value}@example.org`; },
    rejectResend: (status: number) => { resendStatus = status; },
    rejectGeneration: () => { generationStatus = 403; },
    timeout: () => { timeout = true; },
  };
}

test('UNIR verification sends a Firebase credential through Resend without returning or storing the credential', async t => {
  const h = harness(t);
  const response = await worker.fetch(request(), h.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(h.generated.length, 1);
  assert.equal(h.generated[0].email, 'student@comunidadunir.net');
  assert.equal(h.messages.length, 1);
  const message = h.messages[0];
  assert.equal(message.from, 'PaperTok <hello@papertok.app>');
  assert.deepEqual(message.to, ['student@comunidadunir.net']);
  assert.equal(message.headers, undefined);
  assert.match(message.html, /<html lang="en">/);
  assert.match(message.html, /Verify and link university/);
  const link = new URL(message.text.split('\n').find(line => line.startsWith('https://'))!);
  assert.equal(link.origin, 'https://papertok.app');
  assert.equal(link.pathname, '/institution/verify');
  assert.equal(link.searchParams.get('state'), nonce);
  assert.equal(link.searchParams.get('mode'), 'signIn');
  assert.equal(link.searchParams.get('oobCode'), 'secret-proof');
  // The button and the fallback link carry the same credential as the text part.
  const hrefs = [...message.html.matchAll(/href="(https:\/\/papertok\.app\/[^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  assert.deepEqual(hrefs, [link.href, link.href]);
  assert.match(message.html, /<strong[^>]*>student@comunidadunir\.net<\/strong>/);
  assert.match(message.html, /<img src="https:\/\/papertok\.app\/email\/petri-key\.png"[^>]* alt=""/);
  assert.equal(h.ledger().committed, 1);
  assert.doesNotMatch(JSON.stringify(h.ledger()), /secret-proof|student@|oobCode/);
  assert.equal(Object.values(h.ledger().reservations!)[0].delivery?.kind, 'verification');
});

test('origin, method, authentication, verified account and input gates prevent sending', async t => {
  const h = harness(t);
  for (const [req, status] of [
    [request(undefined, { origin: 'https://attacker.test' }), 403],
    [request(undefined, { method: 'GET' }), 405],
    [request(undefined, { authorization: '' }), 401],
    [request({ email: 'bad\r\n@example.org', nonce }), 400],
    [request({ email: 'student@comunidadunir.net', nonce: '../redirect' }), 400],
    [request(null), 400],
    [request({ email: 'x'.repeat(3_000), nonce }), 413],
  ] as const) assert.equal((await worker.fetch(req, h.env)).status, status);
  h.setVerified(false);
  await assert.rejects(handleInstitutionVerificationRequest(request(), h.env), { code: 'INSTITUTION_ACCOUNT_NOT_VERIFIED' });
  assert.equal(h.generated.length, 0);
  assert.equal(h.messages.length, 0);
});

test('the emailed link leads to the production app, or to a loopback app only from a Worker on loopback', async t => {
  // CORS admits loopback and the legacy GitHub Pages origin against the
  // production API, but the link carries a one-time sign-in credential.
  const h = harness(t);
  for (const origin of ['http://localhost:5173', 'https://mugar123.github.io']) {
    const response = await worker.fetch(request(undefined, { origin }), h.env);
    assert.equal(response.status, 403, origin);
    assert.deepEqual(await response.json(), { code: 'ORIGIN_NOT_ALLOWED' });
  }
  assert.equal(h.generated.length, 0);
  assert.equal(h.messages.length, 0);

  const sentTo: string[] = [];
  for (const [account, origin, url] of [
    ['www-reader', 'https://www.papertok.app', 'https://api.papertok.app/institution/verification'],
    ['local-developer', 'http://localhost:5173', 'http://localhost:8787/institution/verification'],
  ]) {
    h.setIdentity(account);
    const response = await worker.fetch(request({ email: `${account}@comunidadunir.net`, nonce }, { origin, url }), h.env);
    assert.equal(response.status, 200, origin);
    const link = h.messages.at(-1)!.text.split('\n').find(line => /^https?:\/\//.test(line))!;
    sentTo.push(new URL(link).origin);
  }
  assert.deepEqual(sentTo, ['https://www.papertok.app', 'http://localhost:5173']);
});

test('an account that signed in with GitHub can request a link although Firebase never flags it as verified', async t => {
  // Issue #267: Firebase sets `emailVerified` only for providers that verify the
  // address themselves, so a GitHub account was refused with an instruction the
  // app has no screen for. The provider that vouched for the same address is
  // the proof, as it already is for the digest.
  const h = harness(t);
  h.setVerified(false);
  h.setProviders([{ providerId: 'github.com', email: 'Reader@example.org' }]);
  const response = await worker.fetch(request(), h.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true });
  assert.equal(h.messages.length, 1);
  // A provider record for another address proves nothing about this one.
  h.setIdentity('second');
  h.setProviders([{ providerId: 'google.com', email: 'someone-else@example.org' }]);
  await assert.rejects(
    handleInstitutionVerificationRequest(request({ email: 'other@comunidadunir.net', nonce: crypto.randomUUID() }), h.env),
    { code: 'INSTITUTION_ACCOUNT_NOT_VERIFIED', status: 403 },
  );
  assert.equal(h.messages.length, 1);
});

test('per-account and per-recipient limits survive different nonces and accounts', async t => {
  const h = harness(t);
  await handleInstitutionVerificationRequest(request(), h.env);
  await assert.rejects(handleInstitutionVerificationRequest(request({ email: 'other@comunidadunir.net', nonce: crypto.randomUUID() }), h.env), { code: 'INSTITUTION_VERIFICATION_LIMIT', status: 429 });
  h.setIdentity('second');
  await assert.rejects(handleInstitutionVerificationRequest(request({ email: 'student@comunidadunir.net', nonce: crypto.randomUUID() }), h.env), { code: 'INSTITUTION_VERIFICATION_LIMIT' });
  assert.equal(h.messages.length, 1);
});

test('the digest daily budget also caps verification emails before generating a credential', async t => {
  const h = harness(t);
  h.setLedger({ committed: 290, reserved: 0 });
  await assert.rejects(handleInstitutionVerificationRequest(request(), h.env), { code: 'INSTITUTION_VERIFICATION_LIMIT' });
  assert.equal(h.generated.length, 0);
  assert.equal(h.messages.length, 0);
});

test('missing quota infrastructure fails closed without generating or sending', async t => {
  const h = harness(t);
  delete h.env.REQUEST_QUOTA_LEDGER;
  await assert.rejects(handleInstitutionVerificationRequest(request(), h.env), { code: 'INSTITUTION_VERIFICATION_UNAVAILABLE' });
  assert.equal(h.generated.length, 0);
});

test('Firebase refusal releases the email budget and never calls Resend', async t => {
  const h = harness(t);
  h.rejectGeneration();
  await assert.rejects(handleInstitutionVerificationRequest(request(), h.env), { code: 'INSTITUTION_VERIFICATION_UNAVAILABLE' });
  assert.equal(h.messages.length, 0);
  assert.equal(h.ledger().reserved, 0);
});

test('a definite Resend rejection releases budget, while uncertain delivery keeps it reserved', async t => {
  for (const outcome of ['rejected', 'timeout', 'server-error']) {
    await t.test(outcome, async t => {
      const h = harness(t);
      if (outcome === 'timeout') h.timeout();
      else h.rejectResend(outcome === 'rejected' ? 400 : 500);
      await assert.rejects(handleInstitutionVerificationRequest(request(), h.env), {
        code: outcome === 'rejected' ? 'INSTITUTION_VERIFICATION_UNAVAILABLE' : 'INSTITUTION_VERIFICATION_UNCERTAIN',
      });
      assert.equal(h.ledger().reserved, outcome === 'rejected' ? 0 : 1);
      assert.equal(h.messages.length, 1);
      assert.doesNotMatch(JSON.stringify(h.ledger()), /secret-proof|student@/);
    });
  }
});
