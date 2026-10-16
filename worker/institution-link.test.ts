import type { FirestoreData, FirestoreWrite } from './firestore-admin.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.ts';
import {
  INSTITUTION_LINK_PATH,
  INSTITUTION_UNLINK_PATH,
  InstitutionLinkError,
  handleInstitutionLinkRequest,
  resolveInstitution,
} from './institution-link.ts';
import { decodeFields, FirestoreAdminError } from './firestore-admin.ts';

const UID = 'alice-uid';
const PROJECT_ID = 'papertok-168df';
const SESSION_TOKEN = fakeIdToken({ aud: PROJECT_ID, sub: 'session' });
const UNIVERSITY_TOKEN = fakeIdToken({ aud: PROJECT_ID, sub: 'university' });

const SERVICE = {
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
};

/** A ROR search answer shaped like the live one for `domains:usal.es`. */
const ROR_USAL = {
  number_of_results: 1,
  items: [{
    id: 'https://ror.org/02f40zc51',
    domains: ['usal.es'],
    names: [
      { value: 'Universidad de Salamanca', types: ['ror_display', 'label'] },
      { value: 'USAL', types: ['acronym'] },
      { value: 'University of Salamanca', types: ['label'] },
    ],
  }],
};

/** Two identity providers share the scope, as the live metadata lists them. */
const MDQ_USAL = [
  { title: 'Universidad De Salamanca', entityID: 'https://idp.usal.es/entity', scope: 'usal.es' },
  { title: 'Universidad de Salamanca', entityID: 'https://www.rediris.es/sir/usalidp', scope: 'usal.es' },
];

function memoryAdmin<Documents extends Record<string, FirestoreData>>(seed: Documents = {} as Documents) {
  const documents: Record<string, FirestoreData> = { ...seed };
  const commits: FirestoreWrite[][] = [];
  return {
    documents: documents as Documents & Record<string, FirestoreData>,
    commits,
    name: (segments: string[]) => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async commit(writes: FirestoreWrite[]) {
      commits.push(writes);
      for (const write of writes) {
        const key = write.update!.name.split('/documents/')[1];
        if (write.currentDocument?.exists === true && documents[key] == null) {
          throw new FirestoreAdminError('FIRESTORE_PRECONDITION_FAILED', 409, 'NOT_FOUND');
        }
        const patch = decodeFields(write.update!.fields);
        const next = { ...(documents[key] || {}) };
        for (const field of write.updateMask!.fieldPaths) {
          if (field in patch) next[field] = patch[field];
          else delete next[field];
        }
        documents[key] = next;
      }
    },
  };
}

/**
 * Identity Toolkit, ROR and the federation metadata, each answering per call
 * so a test can take one of them down. `users` maps a token to the account it
 * belongs to.
 */
function stubUpstreams({
  users = {},
  ror = () => new Response(JSON.stringify(ROR_USAL), { status: 200 }),
  mdq = () => new Response(JSON.stringify(MDQ_USAL), { status: 200 }),
}: { users?: Record<string, Record<string, unknown>>; ror?: (url: string) => Response; mdq?: (url: string) => Response } = {}) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    calls.push(target);
    if (target.includes('accounts:lookup')) {
      const { idToken } = JSON.parse(init!.body as string);
      const user = users[idToken];
      return user
        ? new Response(JSON.stringify({ users: [user] }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'INVALID_ID_TOKEN' } }), { status: 400 });
    }
    if (target.startsWith('https://api.ror.org/')) return ror(target);
    if (target.startsWith('https://md.seamlessaccess.org/')) return mdq(target);
    throw new Error(`unexpected fetch ${target}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function linkRequest(body: { institutionToken?: string|number; }, { path = INSTITUTION_LINK_PATH, method = 'POST', token = SESSION_TOKEN } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: 'https://papertok.app',
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

const SESSION_USAL = { localId: UID, email: 'alice@usal.es', emailVerified: true };
const SESSION_GMAIL = { localId: UID, email: 'alice@gmail.com', emailVerified: true };
const UNIVERSITY_USAL = { localId: 'other-uid', email: 'alice@usal.es', emailVerified: true };

async function rejectsWith(promise: Promise<unknown>|(() => Promise<unknown>), code: string, status: number) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof InstitutionLinkError, `expected InstitutionLinkError, got ${(error as Error)?.name}: ${(error as Error)?.message}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test('links the institution of the session\'s own verified address and stores it on the user document', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: SESSION_USAL } });
  const admin = memoryAdmin();
  try {
    const payload = await handleInstitutionLinkRequest(linkRequest({}), SERVICE, {
      admin,
      now: () => Date.UTC(2026, 9, 13, 10, 0, 0),
    });
    assert.deepEqual(payload.institution, {
      domain: 'usal.es',
      rorId: 'https://ror.org/02f40zc51',
      name: 'Universidad de Salamanca',
      acronym: 'USAL',
      entityId: 'https://idp.usal.es/entity',
      verifiedAt: '2026-10-13T10:00:00.000Z',
    });
    assert.deepEqual(admin.documents[`users/${UID}`], { institution: payload.institution });
    // No public profile yet: nothing to copy to, and no failure either.
    assert.equal(admin.documents[`userProfiles/${UID}`], undefined);
    // One field, no existence precondition: onboarding links before the
    // document exists.
    const [write] = admin.commits[0];
    assert.deepEqual(write.updateMask, { fieldPaths: ['institution'] });
    assert.equal(write.currentDocument, undefined);
    assert.ok(upstream.calls.some(url => url.includes('query.advanced=domains%3Ausal.es')));
  } finally {
    upstream.restore();
  }
});

test('a second account\'s token proves the institution for a session on another address', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: SESSION_GMAIL, [UNIVERSITY_TOKEN]: UNIVERSITY_USAL } });
  const admin = memoryAdmin({
    [`users/${UID}`]: { onboardingComplete: true },
    [`userProfiles/${UID}`]: { handle: 'alice', displayName: 'Alice' },
  });
  try {
    const payload = await handleInstitutionLinkRequest(
      linkRequest({ institutionToken: UNIVERSITY_TOKEN }),
      SERVICE,
      { admin },
    );
    assert.equal(payload.institution!.domain, 'usal.es');
    // Written to the SESSION's document, never to the proving account's.
    assert.equal((admin.documents[`users/${UID}`] as { onboardingComplete: boolean; institution: { domain: string } }).institution.domain, 'usal.es');
    assert.equal(admin.documents[`users/${UID}`].onboardingComplete, true);
    assert.equal(admin.documents['users/other-uid'], undefined);
    // And copied to the public profile, which the page shows to everyone.
    assert.deepEqual(admin.documents[`userProfiles/${UID}`], { handle: 'alice', displayName: 'Alice', institution: payload.institution });
  } finally {
    upstream.restore();
  }
});

test('the session address alone is not enough when it is not the university\'s', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: SESSION_GMAIL },
    ror: () => new Response(JSON.stringify({ number_of_results: 0, items: [] }), { status: 200 }),
  });
  const admin = memoryAdmin();
  try {
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin }), 'INSTITUTION_NOT_FOUND', 404);
    assert.equal(admin.commits.length, 0);
  } finally {
    upstream.restore();
  }
});

test('an unverified address proves nothing', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: { ...SESSION_USAL, emailVerified: false } } });
  const admin = memoryAdmin();
  try {
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin }), 'INSTITUTION_EMAIL_NOT_VERIFIED', 403);
    assert.equal(admin.commits.length, 0);
    assert.ok(!upstream.calls.some(url => url.startsWith('https://api.ror.org/')), 'no registry call for an unproven address');
  } finally {
    upstream.restore();
  }
});

test('a bad second token is a bad proof, not a lost session', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: SESSION_GMAIL } });
  const admin = memoryAdmin();
  try {
    await rejectsWith(
      handleInstitutionLinkRequest(linkRequest({ institutionToken: UNIVERSITY_TOKEN }), SERVICE, { admin }),
      'INSTITUTION_TOKEN_INVALID',
      400,
    );
    await rejectsWith(
      handleInstitutionLinkRequest(linkRequest({ institutionToken: 42 }), SERVICE, { admin }),
      'INVALID_BODY',
      400,
    );
  } finally {
    upstream.restore();
  }
});

test('a ROR outage is reported as unavailable and nothing is written', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: SESSION_USAL },
    ror: () => new Response('down', { status: 503 }),
  });
  const admin = memoryAdmin();
  try {
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin }), 'INSTITUTION_LOOKUP_UNAVAILABLE', 502);
    assert.equal(admin.commits.length, 0);
  } finally {
    upstream.restore();
  }
});

test('the federation metadata being down leaves the entityID unknown but still links', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: SESSION_USAL },
    mdq: () => new Response('down', { status: 503 }),
  });
  const admin = memoryAdmin();
  try {
    const payload = await handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin });
    assert.equal(payload.institution!.rorId, 'https://ror.org/02f40zc51');
    assert.equal(payload.institution!.entityId, null);
  } finally {
    upstream.restore();
  }
});

test('unlinking clears the field and tolerates a document that never existed', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: SESSION_GMAIL } });
  const admin = memoryAdmin({
    [`users/${UID}`]: { onboardingComplete: true, institution: { domain: 'usal.es' } },
    [`userProfiles/${UID}`]: { handle: 'alice', institution: { domain: 'usal.es' } },
  });
  try {
    const payload = await handleInstitutionLinkRequest(linkRequest({}, { path: INSTITUTION_UNLINK_PATH }), SERVICE, { admin });
    assert.deepEqual(payload, { institution: null });
    assert.deepEqual(admin.documents[`users/${UID}`], { onboardingComplete: true });
    assert.deepEqual(admin.documents[`userProfiles/${UID}`], { handle: 'alice' });

    const empty = memoryAdmin();
    const again = await handleInstitutionLinkRequest(linkRequest({}, { path: INSTITUTION_UNLINK_PATH }), SERVICE, { admin: empty });
    assert.deepEqual(again, { institution: null });
  } finally {
    upstream.restore();
  }
});

test('refuses other methods and a Worker without the service account', async () => {
  const upstream = stubUpstreams({ users: { [SESSION_TOKEN]: SESSION_USAL } });
  try {
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}, { method: 'GET' }), SERVICE, { admin: memoryAdmin() }), 'METHOD_NOT_ALLOWED', 405);
    await rejectsWith(
      handleInstitutionLinkRequest(linkRequest({}), { FIREBASE_WEB_API_KEY: 'web-key', FIREBASE_PROJECT_ID: PROJECT_ID }, { admin: memoryAdmin() }),
      'INSTITUTION_LINK_NOT_CONFIGURED',
      503,
    );
  } finally {
    upstream.restore();
  }
});

test('a resolved institution is served from the cache; a miss is not remembered', async () => {
  const store = new Map<string, Response>();
  const cache = {
    async match(request: RequestInfo | URL) { return store.get((request as Request).url)?.clone() || null; },
    async put(request: RequestInfo | URL, response: Response) { store.set((request as Request).url, response); },
  };
  let rorCalls = 0;
  const upstream = stubUpstreams({
    ror: () => {
      rorCalls += 1;
      return new Response(JSON.stringify(rorCalls === 1 ? { items: [] } : ROR_USAL), { status: 200 });
    },
  });
  try {
    await rejectsWith(resolveInstitution('usal.es', { cache }), 'INSTITUTION_NOT_FOUND', 404);
    assert.equal(store.size, 0, 'not found is not cached');
    const first = await resolveInstitution('usal.es', { cache });
    const second = await resolveInstitution('usal.es', { cache });
    assert.deepEqual(second, first);
    assert.equal(rorCalls, 2, 'the second resolution never reached ROR');
  } finally {
    upstream.restore();
  }
});
