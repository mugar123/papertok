import type { FirestoreData, FirestoreWrite } from './firestore-admin.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { decodeFields, FirestoreAdminError } from './firestore-admin.ts';
import { OrcidError, handleOrcidRequest } from './orcid.ts';

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const PROJECT_ID = 'papertok-168df';
const ORIGIN = 'https://papertok.app';
const ENV = {
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
  ORCID_CLIENT_ID: 'APP-TESTCLIENT0001',
  ORCID_CLIENT_SECRET: 'client-secret-for-tests',
  ORCID_ENVIRONMENT: 'production',
};
// ORCID's documented example iD, whose check digit is valid.
const IDENTIFIER = '0000-0002-1825-0097';
const ACCESS_TOKEN = 'f5af9f51-07e6-4332-8f1a-c0c11c1e3728';
const NOW = Date.parse('2026-11-18T10:00:00Z');

function memoryAdmin(seed: Record<string, FirestoreData> = {}) {
  const documents: Record<string, FirestoreData> = { ...seed };
  const path = (name: string) => name.split('/documents/')[1];
  return {
    documents,
    name: (segments: string[]) => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async getDocument<T>(segments: string[]) { return (documents[segments.join('/')] ?? null) as T | null; },
    async commit(writes: FirestoreWrite[]) {
      for (const write of writes) {
        const key = path(write.delete ?? write.update!.name);
        if (write.currentDocument?.exists === true && !documents[key]) throw new FirestoreAdminError('FAILED_PRECONDITION', 409);
      }
      for (const write of writes) {
        if (write.delete) { delete documents[path(write.delete)]; continue; }
        const key = path(write.update!.name);
        const fields = decodeFields(write.update!.fields);
        if (!write.updateMask) { documents[key] = fields; continue; }
        const next = { ...(documents[key] || {}) };
        for (const field of write.updateMask.fieldPaths) {
          if (field in fields) next[field] = fields[field];
          else delete next[field];
        }
        documents[key] = next;
      }
    },
  };
}

type Handler = (url: string, init: RequestInit) => Response;

// Nothing in this file reaches a real service: a request no test stubbed fails.
globalThis.fetch = async (input) => { throw new Error(`unstubbed request to ${String(input)}`); };

/** Identity Toolkit names the account of the token; every other request goes to `handler`. */
function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('accounts:lookup')) {
      const { idToken } = JSON.parse(String(init.body));
      const { sub } = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Response.json({ users: [{ localId: sub, email: `${sub}@example.com`, emailVerified: true }] });
    }
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function request(path: string, uid = ALICE, body?: unknown) {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${fakeIdToken({ aud: PROJECT_ID, sub: uid })}`, 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body ?? {}),
  });
}

const orcidAnswer = (overrides: Record<string, unknown> = {}) => Response.json({
  access_token: ACCESS_TOKEN, token_type: 'bearer', refresh_token: 'refresh-token', expires_in: 631138518,
  scope: '/authenticate', name: 'Josiah Carberry', orcid: IDENTIFIER, ...overrides,
});

async function connect(admin: ReturnType<typeof memoryAdmin>, { uid = ALICE, env = ENV, now = NOW } = {}) {
  const { authorizeUrl } = await handleOrcidRequest(request('/orcid/connect', uid), env, ORIGIN, { admin, now: () => now }) as { authorizeUrl: string };
  return new URL(authorizeUrl);
}

function complete(admin: ReturnType<typeof memoryAdmin>, state: string | null, { uid = ALICE, now = NOW, code = 'Q70Y3A' } = {}) {
  return handleOrcidRequest(request('/orcid/complete', uid, { code, state }), ENV, ORIGIN, { admin, now: () => now });
}

const rejectsWith = (code: string) => (error: OrcidError) => error instanceof OrcidError && error.code === code;

test('connecting asks ORCID to authenticate the iD and keeps only a hash of the state', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => new Response('unexpected', { status: 500 }));
  try {
    const authorize = await connect(admin);
    assert.equal(`${authorize.origin}${authorize.pathname}`, 'https://orcid.org/oauth/authorize');
    assert.equal(authorize.searchParams.get('client_id'), ENV.ORCID_CLIENT_ID);
    assert.equal(authorize.searchParams.get('response_type'), 'code');
    assert.equal(authorize.searchParams.get('scope'), '/authenticate');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://papertok.app/orcid/callback');
    const state = authorize.searchParams.get('state')!;
    assert.ok(state.length >= 40, 'the state is long enough not to be guessed');
    assert.equal(upstream.calls.length, 0, 'connecting asks ORCID nothing');
    const link = admin.documents[`users/${ALICE}/orcid/link`];
    assert.deepEqual(Object.keys(link).sort(), ['createdAt', 'stateHash']);
    assert.equal(link.createdAt, NOW);
    assert.notEqual(link.stateHash, state);
  } finally {
    upstream.restore();
  }
});

test('the sandbox environment sends the reader to the sandbox registry', async () => {
  const upstream = stubFetch(() => new Response('unexpected', { status: 500 }));
  try {
    const authorize = await connect(memoryAdmin(), { env: { ...ENV, ORCID_ENVIRONMENT: 'sandbox' } });
    assert.equal(authorize.origin, 'https://sandbox.orcid.org');
  } finally {
    upstream.restore();
  }
});

test('completing stores the iD and the name on the account and never the token', async () => {
  const admin = memoryAdmin({ [`users/${ALICE}`]: { onboardingComplete: true } });
  const upstream = stubFetch(() => orcidAnswer());
  try {
    const state = (await connect(admin)).searchParams.get('state');
    const answer = await complete(admin, state, { now: NOW + 60_000 });
    const expected = { id: IDENTIFIER, name: 'Josiah Carberry', host: 'orcid.org', connectedAt: '2026-11-18T10:01:00.000Z' };
    assert.deepEqual(answer, { orcid: expected });

    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, 'https://orcid.org/oauth/token');
    const exchange = new URLSearchParams(String(upstream.calls[0].init.body));
    assert.equal(exchange.get('client_id'), ENV.ORCID_CLIENT_ID);
    assert.equal(exchange.get('client_secret'), ENV.ORCID_CLIENT_SECRET);
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('code'), 'Q70Y3A');
    assert.equal(exchange.get('redirect_uri'), 'https://papertok.app/orcid/callback');
  } finally {
    upstream.restore();
  }
  assert.deepEqual(admin.documents[`users/${ALICE}`], {
    onboardingComplete: true,
    orcid: { id: IDENTIFIER, name: 'Josiah Carberry', host: 'orcid.org', connectedAt: '2026-11-18T10:01:00.000Z' },
  });
  assert.equal(admin.documents[`users/${ALICE}/orcid/link`], undefined, 'the state cannot be used again');
  assert.ok(!JSON.stringify(admin.documents).includes(ACCESS_TOKEN));
  assert.ok(!JSON.stringify(admin.documents).includes('refresh-token'));
});

test('a record that shares no name is stored with the name unknown', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer({ name: null }));
  try {
    const state = (await connect(admin)).searchParams.get('state');
    const { orcid } = await complete(admin, state) as { orcid: { name: unknown } };
    assert.equal(orcid.name, null);
    assert.equal((admin.documents[`users/${ALICE}`].orcid as { name: unknown }).name, null);
  } finally {
    upstream.restore();
  }
});

test('a state this account did not ask for, or asked for too long ago, connects nothing and asks ORCID nothing', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  try {
    const state = (await connect(admin)).searchParams.get('state');
    await assert.rejects(complete(admin, 'a-state-someone-else-made'), rejectsWith('ORCID_CONNECTION_EXPIRED'));
    // Bob holds Alice's authorize link: his account has no pending state of its own.
    await assert.rejects(complete(admin, state, { uid: BOB }), rejectsWith('ORCID_CONNECTION_EXPIRED'));
    await assert.rejects(complete(admin, state, { now: NOW + 15 * 60_000 + 1 }), rejectsWith('ORCID_CONNECTION_EXPIRED'));
    await assert.rejects(complete(admin, null), rejectsWith('INVALID_BODY'));
    assert.equal(upstream.calls.length, 0);
    assert.equal(admin.documents[`users/${ALICE}`], undefined);
    assert.equal(admin.documents[`users/${BOB}`], undefined);

    await complete(admin, state, { now: NOW + 15 * 60_000 });
    await assert.rejects(complete(admin, state), rejectsWith('ORCID_CONNECTION_EXPIRED'), 'a state works once');
  } finally {
    upstream.restore();
  }
});

test('an answer without a valid iD is an ORCID failure, not a connection', async () => {
  for (const orcid of ['0000-0002-1825-0098', 'https://orcid.org/0000-0002-1825-0097', undefined]) {
    const admin = memoryAdmin();
    const upstream = stubFetch(() => orcidAnswer({ orcid }));
    try {
      const state = (await connect(admin)).searchParams.get('state');
      await assert.rejects(complete(admin, state), rejectsWith('ORCID_UNAVAILABLE'), String(orcid));
      assert.equal(admin.documents[`users/${ALICE}`], undefined);
    } finally {
      upstream.restore();
    }
  }
});

test("ORCID refusing PaperTok's credentials says the client is not set up; refusing the code says start again", async () => {
  const cases: Array<[Response, string]> = [
    [Response.json({ error: 'invalid_client', error_description: 'Client not found' }, { status: 401 }), 'ORCID_NOT_CONFIGURED'],
    [Response.json({ error: 'invalid_grant', error_description: 'Invalid authorization code' }, { status: 400 }), 'ORCID_CONNECTION_EXPIRED'],
    [new Response('busy', { status: 429, headers: { 'retry-after': '30' } }), 'ORCID_RATE_LIMITED'],
    [new Response('down', { status: 502 }), 'ORCID_UNAVAILABLE'],
  ];
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const [response, code] of cases) {
      const admin = memoryAdmin();
      const upstream = stubFetch(() => response);
      try {
        const state = (await connect(admin)).searchParams.get('state');
        await assert.rejects(complete(admin, state), rejectsWith(code), code);
        assert.equal(admin.documents[`users/${ALICE}`], undefined);
      } finally {
        upstream.restore();
      }
    }
  } finally {
    console.warn = warn;
  }
});

test('without a client, or with an unknown environment, every route answers not configured before reading the session', async () => {
  const upstream = stubFetch(() => orcidAnswer());
  try {
    for (const env of [{ ...ENV, ORCID_CLIENT_ID: '' }, { ...ENV, ORCID_CLIENT_SECRET: '' }, { ...ENV, ORCID_ENVIRONMENT: 'staging' }]) {
      await assert.rejects(handleOrcidRequest(request('/orcid/connect'), env, ORIGIN, { admin: memoryAdmin() }), rejectsWith('ORCID_NOT_CONFIGURED'));
    }
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('disconnecting forgets the iD and any pending state, also for an account with no user document', async () => {
  const connectedAccount = memoryAdmin({
    [`users/${ALICE}`]: { onboardingComplete: true, orcid: { id: IDENTIFIER, name: 'Josiah Carberry', host: 'orcid.org', connectedAt: '2026-11-18T10:01:00.000Z' } },
    [`users/${ALICE}/orcid/link`]: { stateHash: 'abc', createdAt: NOW },
  });
  const newAccount = memoryAdmin({ [`users/${ALICE}/orcid/link`]: { stateHash: 'abc', createdAt: NOW } });
  const upstream = stubFetch(() => new Response('unexpected', { status: 500 }));
  try {
    assert.deepEqual(await handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin: connectedAccount }), { orcid: null });
    assert.deepEqual(await handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin: newAccount }), { orcid: null });
    assert.equal(upstream.calls.length, 0, 'disconnecting asks ORCID nothing');
  } finally {
    upstream.restore();
  }
  assert.deepEqual(connectedAccount.documents, { [`users/${ALICE}`]: { onboardingComplete: true } });
  assert.deepEqual(newAccount.documents, {});
});

test('only POST is answered', async () => {
  const get = new Request('https://worker.test/orcid/connect', { headers: { origin: ORIGIN } });
  await assert.rejects(handleOrcidRequest(get, ENV, ORIGIN, { admin: memoryAdmin() }), rejectsWith('METHOD_NOT_ALLOWED'));
});
