import type { FirestoreData, FirestoreWrite } from './firestore-admin.ts';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import { FirebaseServiceAccountError } from './firebase-service-account.ts';
import { decodeFields, FirestoreAdminError, mergeWrite } from './firestore-admin.ts';
import { OrcidError, handleOrcidRequest } from './orcid.ts';
import { inMemoryQuotaLedger } from './test-support/quota-ledger.ts';

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
  REQUEST_QUOTA_LEDGER: inMemoryQuotaLedger().binding,
};
// ORCID's documented example iD, whose check digit is valid.
const IDENTIFIER = '0000-0002-1825-0097';
const ACCESS_TOKEN = 'f5af9f51-07e6-4332-8f1a-c0c11c1e3728';
const NOW = Date.parse('2026-11-18T10:00:00Z');
test.beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  ENV.REQUEST_QUOTA_LEDGER = inMemoryQuotaLedger().binding;
});
test.afterEach(() => { mock.timers.reset(); });

/** Documents in memory, each with a version that every write changes, and Firestore's preconditions. */
function memoryAdmin(seed: Record<string, FirestoreData> = {}) {
  const documents: Record<string, FirestoreData> = { ...seed };
  let clock = 0;
  const versions: Record<string, string> = Object.fromEntries(Object.keys(seed).map(key => [key, `v${++clock}`]));
  /** Each commit, as the documents it wrote or deleted. */
  const commits: string[][] = [];
  const reads: string[] = [];
  const path = (name: string) => name.split('/documents/')[1];
  return {
    documents,
    commits,
    reads,
    name: (segments: string[]) => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async getDocument<T>(segments: string[]) {
      const key = segments.join('/');
      reads.push(key);
      return documents[key] ? { data: documents[key] as T, updateTime: versions[key] } : null;
    },
    async commit(writes: FirestoreWrite[]) {
      commits.push(writes.map(write => path(write.delete ?? write.update!.name)));
      for (const write of writes) {
        const key = path(write.delete ?? write.update!.name);
        if (write.currentDocument?.exists === true && !documents[key]) throw new FirestoreAdminError('FAILED_PRECONDITION', 409);
        const updateTime = write.currentDocument?.updateTime;
        if (updateTime && (!documents[key] || versions[key] !== updateTime)) throw new FirestoreAdminError('FAILED_PRECONDITION', 409);
      }
      for (const write of writes) {
        if (write.delete) { delete documents[path(write.delete)]; delete versions[path(write.delete)]; continue; }
        const key = path(write.update!.name);
        versions[key] = `v${++clock}`;
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

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

// Nothing in this file reaches a real service: a request no test stubbed fails.
globalThis.fetch = async (input) => { throw new Error(`unstubbed request to ${String(input)}`); };

/** Identity Toolkit names the account of the token; every other request goes to `handler`. */
function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const lookups: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('accounts:lookup')) {
      lookups.push(url);
      const { idToken } = JSON.parse(String(init.body));
      const { sub } = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return Response.json({ users: [{ localId: sub, email: `${sub}@example.com`, emailVerified: true }] });
    }
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, lookups, restore: () => { globalThis.fetch = original; } };
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

test('each ORCID route has an hourly limit per account', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  const now = () => NOW;
  const disconnect = () => handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin, now });
  const limit = { code: 'ORCID_WRITE_LIMIT', status: 429, retryAfter: '3600' };
  try {
    for (let i = 0; i < 6; i++) {
      const state = (await connect(admin)).searchParams.get('state');
      await complete(admin, state);
      await disconnect();
    }
    const writes = admin.commits.length;
    await assert.rejects(connect(admin), limit);
    await assert.rejects(disconnect(), limit);
    assert.equal(admin.commits.length, writes);
    await connect(admin, { uid: BOB });

    // A pending state started in the previous hour can still be valid after
    // Alice spends the current hour's completion allowance.
    const state = (await connect(admin, { now: NOW - 1000 })).searchParams.get('state');
    await assert.rejects(complete(admin, state), limit);
    assert.equal(upstream.calls.length, 6);
    await connect(admin, { now: NOW + 60 * 60_000 });
  } finally {
    upstream.restore();
  }
});


test('empty disconnects spend no writes and linked accounts can disconnect after the general budget fills', async () => {
  const admin = memoryAdmin({
    [`users/${ALICE}`]: { onboardingComplete: true, orcid: { id: IDENTIFIER } },
    [`users/${ALICE}/orcid/link`]: { stateHash: 'pending', createdAt: NOW },
    [`users/${ALICE}/orcid/works`]: { mine: ['doi:10.1000/a'] },
    ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
      `users/linked-${i}`, { orcid: { id: IDENTIFIER } },
    ])),
  });
  const upstream = stubFetch(() => new Response('down', { status: 502 }));
  const disconnect = (uid: string) => handleOrcidRequest(request('/orcid/disconnect', uid), ENV, ORIGIN, { admin });
  const dailyLimit = { code: 'ORCID_WRITE_LIMIT', status: 429, retryAfter: '50400' };
  try {
    for (let i = 0; i < 500; i++) {
      assert.deepEqual(await disconnect(`empty-${Math.floor(i / 5)}`), { orcid: null });
    }
    assert.equal(admin.commits.length, 0);

    const state = (await connect(admin, { uid: 'callback-reader' })).searchParams.get('state');
    for (let i = 0; i < 1196; i++) await connect(admin, { uid: `reader-${Math.floor(i / 6)}` });
    await assert.rejects(complete(admin, state, { uid: 'callback-reader' }), rejectsWith('ORCID_UNAVAILABLE'));
    await connect(admin, { uid: 'two-connects' });
    await connect(admin, { uid: 'two-connects' });
    const exhausted = { ...admin, async commit() {
      throw new FirestoreAdminError('FIRESTORE_WRITE_FAILED', 502, 'RESOURCE_EXHAUSTED');
    } };
    for (let i = 0; i < 6; i++) await assert.rejects(connect(exhausted, { uid: BOB }), /RESOURCE_EXHAUSTED/);
    await connect(admin, { uid: BOB });
    await assert.rejects(connect(admin, { uid: 'new-reader' }), dailyLimit);
    await assert.rejects(disconnect(BOB), dailyLimit);
    assert.deepEqual(await disconnect('empty-after-cap'), { orcid: null });
    assert.deepEqual(await disconnect(ALICE), { orcid: null });
    assert.deepEqual(admin.documents[`users/${ALICE}`], { onboardingComplete: true });
    assert.equal(admin.documents[`users/${ALICE}/orcid/link`], undefined);
    assert.equal(admin.documents[`users/${ALICE}/orcid/works`], undefined);
    for (let i = 0; i < 99; i++) await disconnect(`linked-${i}`);
    await assert.rejects(disconnect('linked-99'), dailyLimit);
    assert.equal(admin.commits.flat().length, 1500);
  } finally {
    upstream.restore();
  }
});

test('invalid callbacks and failed exchanges spend attempts without spending write units', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => new Response('down', { status: 502 }));
  try {
    const state = (await connect(admin)).searchParams.get('state');
    for (let i = 0; i < 3; i++) {
      await assert.rejects(complete(admin, 'wrong-state'), rejectsWith('ORCID_CONNECTION_EXPIRED'));
      await assert.rejects(complete(admin, state), rejectsWith('ORCID_UNAVAILABLE'));
    }
    await assert.rejects(complete(admin, state), { code: 'ORCID_WRITE_LIMIT', status: 429 });
    assert.equal(admin.reads.length, 6);
    assert.equal(upstream.calls.length, 3);
    assert.equal(admin.commits.length, 1);
  } finally {
    upstream.restore();
  }
});

test('the global callback attempt limit stops reads across accounts', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  try {
    for (let i = 0; i < 2400; i++) {
      await assert.rejects(complete(admin, 'expired', { uid: `reader-${Math.floor(i / 6)}` }),
        rejectsWith('ORCID_CONNECTION_EXPIRED'));
    }
    await assert.rejects(complete(admin, 'expired', { uid: BOB }), {
      code: 'ORCID_WRITE_LIMIT', status: 429, retryAfter: '50400',
    });
    assert.equal(admin.reads.length, 2400);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('without the ledger no ORCID write is attempted', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  try {
    await assert.rejects(handleOrcidRequest(request('/orcid/connect'), { ...ENV, REQUEST_QUOTA_LEDGER: undefined }, ORIGIN, { admin }), {
      code: 'ORCID_FAILED', status: 503,
    });
    assert.equal(admin.commits.length, 0);
  } finally {
    upstream.restore();
  }
});

test('a rejected first commit returns its reservation while an unknown outcome stays charged', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  const rejecting = { ...admin, async commit() {
    throw new FirestoreAdminError('FIRESTORE_WRITE_FAILED', 502, 'PERMISSION_DENIED');
  } };
  const noToken = { ...admin, async commit() { throw new FirebaseServiceAccountError('SERVICE_TOKEN_REFUSED'); } };
  const uncertain = { ...admin, async commit() { throw new Error('Response lost'); } };
  try {
    for (let i = 0; i < 6; i++) {
      await assert.rejects(connect(rejecting), /PERMISSION_DENIED/);
      await assert.rejects(connect(noToken), { code: 'SERVICE_TOKEN_REFUSED' });
      await assert.rejects(connect(uncertain), /Response lost/);
    }
    await assert.rejects(connect(admin), { code: 'ORCID_WRITE_LIMIT', status: 429 });
    assert.equal(admin.commits.length, 0);
  } finally {
    upstream.restore();
  }
});

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
  const admin = memoryAdmin({
    [`users/${ALICE}`]: { onboardingComplete: true },
    // Decisions left from another connection do not carry over to this one.
    [`users/${ALICE}/orcid/works`]: { mine: ['doi:10.1000/a'], notMine: [] },
  });
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
  assert.equal(admin.documents[`users/${ALICE}/orcid/works`], undefined);
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

/** An ORCID that holds its answer until `release`; `asked` settles once the exchange has been sent. */
function heldOrcid() {
  let asked!: () => void;
  let release!: () => void;
  const askedPromise = new Promise<void>((resolve) => { asked = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const handler: Handler = async () => {
    if (first) {
      first = false;
      asked();
      await released;
    }
    return orcidAnswer();
  };
  return { handler, asked: askedPromise, release };
}

test('a Disconnect while ORCID is answering stays disconnected', async () => {
  const admin = memoryAdmin({ [`users/${ALICE}`]: { onboardingComplete: true } });
  const orcid = heldOrcid();
  const upstream = stubFetch(orcid.handler);
  try {
    const state = (await connect(admin)).searchParams.get('state');
    const late = complete(admin, state);
    await orcid.asked;
    await handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin });
    orcid.release();
    await assert.rejects(late, rejectsWith('ORCID_CONNECTION_EXPIRED'));
  } finally {
    upstream.restore();
  }
  assert.deepEqual(admin.documents, { [`users/${ALICE}`]: { onboardingComplete: true } });
});

test('disconnect removes an iD completed between its pending-state and account reads', async () => {
  const admin = memoryAdmin({ [`users/${ALICE}`]: { onboardingComplete: true } });
  const orcid = heldOrcid();
  const upstream = stubFetch(orcid.handler);
  try {
    const state = (await connect(admin)).searchParams.get('state');
    const completing = complete(admin, state);
    await orcid.asked;
    const disconnecting = {
      ...admin,
      async getDocument<T>(segments: string[]) {
        const document = await admin.getDocument<T>(segments);
        if (segments.at(-1) === 'link') {
          orcid.release();
          await completing;
        }
        return document;
      },
    };
    assert.deepEqual(await handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin: disconnecting }), { orcid: null });
  } finally {
    upstream.restore();
  }
  assert.deepEqual(admin.documents, { [`users/${ALICE}`]: { onboardingComplete: true } });
});

test('empty disconnect preserves decisions for a connection created after its account read', async () => {
  const admin = memoryAdmin();
  const upstream = stubFetch(() => orcidAnswer());
  const decisions = { mine: ['doi:10.1000/a'] };
  try {
    const disconnecting = {
      ...admin,
      async getDocument<T>(segments: string[]) {
        const document = await admin.getDocument<T>(segments);
        if (segments.length === 2) {
          const state = (await connect(admin)).searchParams.get('state');
          await complete(admin, state);
          const name = admin.name(['users', ALICE, 'orcid', 'works']);
          await admin.commit([mergeWrite(name, decisions, { mustExist: false })]);
        }
        return document;
      },
    };
    assert.deepEqual(await handleOrcidRequest(request('/orcid/disconnect'), ENV, ORIGIN, { admin: disconnecting }), { orcid: null });
    assert.deepEqual(admin.documents[`users/${ALICE}/orcid/works`], decisions);
  } finally {
    upstream.restore();
  }
});

test('a new Connect while ORCID is answering keeps its pending state and refuses the old completion', async () => {
  const admin = memoryAdmin({
    [`users/${ALICE}`]: { onboardingComplete: true },
    [`users/${ALICE}/orcid/works`]: { mine: ['doi:10.1000/a'], notMine: [] },
  });
  const orcid = heldOrcid();
  const upstream = stubFetch(orcid.handler);
  try {
    const oldState = (await connect(admin)).searchParams.get('state');
    const late = complete(admin, oldState);
    await orcid.asked;
    const newState = (await connect(admin, { now: NOW + 1000 })).searchParams.get('state');
    const pending = admin.documents[`users/${ALICE}/orcid/link`];
    orcid.release();
    await assert.rejects(late, rejectsWith('ORCID_CONNECTION_EXPIRED'));
    assert.deepEqual(admin.documents[`users/${ALICE}/orcid/link`], pending, 'the new pending state is kept');
    assert.deepEqual(admin.documents[`users/${ALICE}`], { onboardingComplete: true });
    assert.deepEqual(admin.documents[`users/${ALICE}/orcid/works`], { mine: ['doi:10.1000/a'], notMine: [] });

    const { orcid: connected } = await complete(admin, newState, { now: NOW + 2000 }) as { orcid: { id: string } };
    assert.equal(connected.id, IDENTIFIER, 'the new connection still completes');
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
      for (const path of ['/orcid/connect', '/orcid/complete', '/orcid/disconnect']) {
        await assert.rejects(handleOrcidRequest(request(path), env, ORIGIN, { admin: memoryAdmin() }), rejectsWith('ORCID_NOT_CONFIGURED'));
      }
    }
    assert.equal(upstream.calls.length, 0);
    assert.equal(upstream.lookups.length, 0, 'the session is not read');
  } finally {
    upstream.restore();
  }
});

test('disconnecting forgets the iD, any pending state and the decisions about its works, also for an account with no user document', async () => {
  const connectedAccount = memoryAdmin({
    [`users/${ALICE}`]: { onboardingComplete: true, orcid: { id: IDENTIFIER, name: 'Josiah Carberry', host: 'orcid.org', connectedAt: '2026-11-18T10:01:00.000Z' } },
    [`users/${ALICE}/orcid/link`]: { stateHash: 'abc', createdAt: NOW },
    [`users/${ALICE}/orcid/works`]: { mine: ['doi:10.1000/a'], notMine: ['openalex:W2'] },
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
  assert.deepEqual(connectedAccount.commits, [[`users/${ALICE}`, `users/${ALICE}/orcid/link`, `users/${ALICE}/orcid/works`]]);
});

test('only POST is answered', async () => {
  const get = new Request('https://worker.test/orcid/connect', { headers: { origin: ORIGIN } });
  await assert.rejects(handleOrcidRequest(get, ENV, ORIGIN, { admin: memoryAdmin() }), rejectsWith('METHOD_NOT_ALLOWED'));
});
