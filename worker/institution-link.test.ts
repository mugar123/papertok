import type { FirestoreData, FirestoreWrite } from './firestore-admin.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.ts';
import {
  INSTITUTION_LINK_PATH,
  INSTITUTION_UNLINK_PATH,
  InstitutionLinkError,
  LINK_LOOKUP_BUDGET_MS,
  handleInstitutionLinkRequest,
  resolveInstitution,
} from './institution-link.ts';
import { decodeFields, FirestoreAdminError } from './firestore-admin.ts';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/utils/requestDeadline.ts';
import { findResolver } from './institution-access.ts';

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
    // A legacy public profile is not written: nothing shows it any more.
    assert.deepEqual(admin.documents[`userProfiles/${UID}`], { handle: 'alice', displayName: 'Alice' });
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
    // A legacy public profile loses its old copy too: unlinking erases the
    // university wherever this account stored it.
    assert.deepEqual(admin.documents[`userProfiles/${UID}`], { handle: 'alice' });

    // Most accounts never had a profile: the missing one is not a failure.
    const noProfile = memoryAdmin({ [`users/${UID}`]: { institution: { domain: 'usal.es' } } });
    const cleared = await handleInstitutionLinkRequest(linkRequest({}, { path: INSTITUTION_UNLINK_PATH }), SERVICE, { admin: noProfile });
    assert.deepEqual(cleared, { institution: null });
    assert.deepEqual(noProfile.documents[`users/${UID}`], {});
    assert.equal(noProfile.documents[`userProfiles/${UID}`], undefined);

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

// ROR's record for the Autónoma de Madrid: students write from
// estudiante.uam.es, which ROR does not list (checked 2026-10-19).
const ROR_UAM = {
  number_of_results: 1,
  items: [{
    id: 'https://ror.org/01cby8j38',
    domains: ['uam.es'],
    names: [{ value: 'Universidad Autónoma de Madrid', types: ['ror_display', 'label'] }, { value: 'UAM', types: ['acronym'] }],
  }],
};

/** The ROR questions among the fetches: a domain query, or the id of a record asked for by id. */
function rorQuestions(calls: string[]) {
  return calls.filter(url => url.startsWith('https://api.ror.org/'))
    .map(url => new URL(url).searchParams.get('query.advanced') ?? new URL(url).pathname.split('/').pop());
}

// ROR's record for UC3M, shaped like the live answer to
// GET /v2/organizations/03ths8210 (2026-10-19): it lists uc3m.es, while
// students write from alumnos.uc3m.es.
const ROR_UC3M = {
  id: 'https://ror.org/03ths8210',
  domains: ['uc3m.es'],
  names: [
    { value: 'Carlos III University of Madrid', types: ['label'] },
    { value: 'UC3M', types: ['acronym'] },
    { value: 'Universidad Carlos III de Madrid', types: ['ror_display', 'label'] },
  ],
};

test('a hand-checked student domain links to its university with ROR\'s name and acronym, and selects its library', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: { localId: UID, email: '100123456@alumnos.uc3m.es', emailVerified: true } },
    ror: (url) => Response.json(url === 'https://api.ror.org/v2/organizations/03ths8210' ? ROR_UC3M
      : new URL(url).searchParams.get('query.advanced') === 'domains:uc3m.es' ? { items: [ROR_UC3M] } : { items: [] }),
    mdq: (url) => Response.json(new URL(url).searchParams.get('q') === 'uc3m.es' ? [{ entityID: 'https://idp.uc3m.es/entity', scope: 'uc3m.es' }] : []),
  });
  const admin = memoryAdmin();
  try {
    const { institution } = await handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin, cache: null });
    assert.equal(institution!.domain, 'alumnos.uc3m.es');
    assert.equal(institution!.rorId, 'https://ror.org/03ths8210');
    assert.equal(institution!.name, 'Universidad Carlos III de Madrid');
    assert.equal(institution!.acronym, 'UC3M');
    assert.equal(institution!.entityId, 'https://idp.uc3m.es/entity');
    assert.deepEqual(admin.documents[`users/${UID}`].institution, institution);
    assert.deepEqual(findResolver(institution!), { host: 'eu02.alma.exlibrisgroup.com', institution: '34UC3M_INST' });
    // A record stored under a UC3M sub-unit is not answered with UC3M's
    // library, although its domain is a UC3M mail domain.
    assert.equal(findResolver({ domain: 'alumnos.uc3m.es', rorId: 'https://ror.org/004aqbt71' }), null);
  } finally {
    upstream.restore();
  }
});

// ROR's record for Carnegie Mellon lists cmu.edu only; alumni.cmu.edu is
// CMU's mail for alumni (checked 2026-10-19).
const ROR_CMU = {
  items: [{
    id: 'https://ror.org/05x2bcf33',
    domains: ['cmu.edu'],
    names: [{ value: 'Carnegie Mellon University', types: ['ror_display', 'label'] }],
  }],
};

test('an address on a subdomain ROR does not list is not linked to the parent\'s institution', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: { localId: UID, email: 'alice@alumni.cmu.edu', emailVerified: true } },
    ror: (url) => Response.json(new URL(url).searchParams.get('query.advanced') === 'domains:cmu.edu' ? ROR_CMU : { items: [] }),
  });
  const admin = memoryAdmin();
  try {
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin, cache: null }), 'INSTITUTION_NOT_FOUND', 404);
    assert.equal(admin.commits.length, 0);
  } finally {
    upstream.restore();
  }
});

// ROR lists nhs.uk, a public suffix, under two organisations (live answer to
// domains:nhs.uk, 2026-10-19).
const ROR_NHS = {
  items: [
    { id: 'https://ror.org/01jgmvf05', domains: ['nhs.uk'], names: [{ value: 'North London NHS Foundation Trust', types: ['label', 'ror_display'] }] },
    { id: 'https://ror.org/02wnqcb97', domains: ['nhs.uk'], names: [{ value: 'National Health Service', types: ['ror_display', 'label'] }] },
  ],
};

test('a domain ROR does not list is not found after one question, even when its parent is listed', async () => {
  const upstream = stubUpstreams({
    ror: (url) => Response.json(new URL(url).searchParams.get('query.advanced') === 'domains:nhs.uk' ? ROR_NHS : { items: [] }),
  });
  try {
    await rejectsWith(resolveInstitution('somerset.nhs.uk', { cache: null }), 'INSTITUTION_NOT_FOUND', 404);
    assert.deepEqual(rorQuestions(upstream.calls), ['domains:somerset.nhs.uk']);
  } finally {
    upstream.restore();
  }
});

// ROR's record for Northeastern University in Shenyang lists neu.edu, which is
// an alias of Northeastern University in Boston (checked 2026-10-19). The
// federation lists neu.edu under Boston's provider.
const ROR_NEU_SHENYANG = {
  number_of_results: 1,
  items: [{
    id: 'https://ror.org/03awzbc87',
    domains: ['neu.edu'],
    links: [{ type: 'website', value: 'https://www.neu.edu.cn' }],
    names: [{ value: 'Northeastern University', types: ['ror_display', 'label'] }],
  }],
};
const MDQ_NEU_BOSTON = [{ title: 'Northeastern University', entityID: 'https://neuidmsso.neu.edu/idp/shibboleth', scope: 'neu.edu' }];

const ROR_NEU_BOSTON = {
  items: [{
    id: 'https://ror.org/04t5xt781',
    domains: ['northeastern.edu'],
    names: [{ value: 'Northeastern University', types: ['ror_display', 'label'] }],
  }],
};

test('a verified Northeastern legacy address links to Boston and selects its library', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: { localId: UID, email: 'alice@husky.neu.edu', emailVerified: true } },
    ror: (url) => {
      const domain = new URL(url).searchParams.get('query.advanced');
      return Response.json(domain === 'domains:northeastern.edu' ? ROR_NEU_BOSTON
        : domain === 'domains:neu.edu' ? ROR_NEU_SHENYANG : { items: [] });
    },
    mdq: (url) => Response.json(new URL(url).searchParams.get('q') === 'neu.edu' ? MDQ_NEU_BOSTON : []),
  });
  const admin = memoryAdmin();
  try {
    const { institution } = await handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin, cache: null });
    assert.equal(institution!.domain, 'husky.neu.edu');
    assert.equal(institution!.rorId, 'https://ror.org/04t5xt781');
    // The federation lists Boston's provider under neu.edu only (checked
    // 2026-10-19), and it is asked about the address's domain and the
    // domain ROR lists, never about a parent.
    assert.equal(institution!.entityId, null);
    assert.deepEqual(admin.documents[`users/${UID}`].institution, institution);
    assert.deepEqual(findResolver(institution!), { host: 'na03.alma.exlibrisgroup.com', institution: '01NEU_INST' });
    assert.deepEqual(rorQuestions(upstream.calls), ['domains:northeastern.edu']);
    const neu = await resolveInstitution('neu.edu', { cache: null });
    assert.equal(neu.rorId, institution!.rorId);
    assert.equal(neu.entityId, 'https://neuidmsso.neu.edu/idp/shibboleth');
    assert.equal((await resolveInstitution('northeastern.edu', { cache: null })).rorId, institution!.rorId);
  } finally {
    upstream.restore();
  }
});

test('similar domains do not use the Northeastern alias', async () => {
  const upstream = stubUpstreams({
    ror: (url) => Response.json(new URL(url).searchParams.get('query.advanced') === 'domains:northeastern.edu' ? ROR_NEU_BOSTON : { items: [] }),
  });
  try {
    for (const domain of ['husky.new.edu', 'neu.edu.cn', 'notneu.edu', 'neu.edu.evil.example']) {
      await rejectsWith(resolveInstitution(domain, { cache: null }), 'INSTITUTION_NOT_FOUND', 404);
    }
    assert.ok(upstream.calls.every(url => !url.includes('domains%3Anortheastern.edu')));
  } finally {
    upstream.restore();
  }
});

test('the Shenyang record cannot satisfy the canonical Boston domain lookup', async () => {
  const upstream = stubUpstreams({
    users: { [SESSION_TOKEN]: { localId: UID, email: 'alice@husky.neu.edu', emailVerified: true } },
    ror: () => Response.json(ROR_NEU_SHENYANG),
    mdq: () => new Response(JSON.stringify(MDQ_NEU_BOSTON), { status: 200 }),
  });
  const admin = memoryAdmin();
  try {
    await rejectsWith(resolveInstitution('husky.neu.edu', { cache: undefined }), 'INSTITUTION_NOT_FOUND', 404);
    await rejectsWith(resolveInstitution('neu.edu', { cache: undefined }), 'INSTITUTION_NOT_FOUND', 404);
    await rejectsWith(handleInstitutionLinkRequest(linkRequest({}), SERVICE, { admin }), 'INSTITUTION_NOT_FOUND', 404);
    assert.equal(admin.commits.length, 0, 'nothing is written for a contradicted identity');
  } finally {
    upstream.restore();
  }
});

// Universities whose website is not under their mail domain, as ROR lists
// them (checked 2026-10-19).
const ROR_BIRMINGHAM = {
  items: [{
    id: 'https://ror.org/03angcq70',
    domains: ['bham.ac.uk'],
    links: [{ type: 'website', value: 'http://www.birmingham.ac.uk/index.aspx' }],
    names: [{ value: 'University of Birmingham', types: ['ror_display', 'label'] }],
  }],
};
const ROR_SYRACUSE = {
  items: [{
    id: 'https://ror.org/025r5qe02',
    domains: ['syr.edu'],
    links: [{ type: 'website', value: 'https://www.syracuse.edu' }],
    names: [{ value: 'Syracuse University', types: ['ror_display', 'label'] }],
  }],
};

test('a university whose website lives on another domain still links by its mail domain', async () => {
  const upstream = stubUpstreams({
    ror: (url) => new Response(JSON.stringify(url.includes('domains%3Abham.ac.uk') ? ROR_BIRMINGHAM : url.includes('domains%3Asyr.edu') ? ROR_SYRACUSE : { items: [] }), { status: 200 }),
    mdq: () => new Response('[]', { status: 200 }),
  });
  try {
    assert.equal((await resolveInstitution('bham.ac.uk', { cache: undefined })).rorId, 'https://ror.org/03angcq70');
    assert.equal((await resolveInstitution('syr.edu', { cache: undefined })).rorId, 'https://ror.org/025r5qe02');
  } finally {
    upstream.restore();
  }
});

test('a record links through every domain it lists', async () => {
  // HKUST lists hkust.edu.hk and ust.hk.
  const record = {
    items: [{
      id: 'https://ror.org/00q4vv597',
      domains: ['hkust.edu.hk', 'ust.hk'],
      links: [{ type: 'website', value: 'https://hkust.edu.hk/' }],
      names: [{ value: 'Hong Kong University of Science and Technology', types: ['ror_display', 'label'] }],
    }],
  };
  const upstream = stubUpstreams({
    ror: (url) => new Response(JSON.stringify(url.includes('domains%3Aust.hk') ? record : { items: [] }), { status: 200 }),
    mdq: () => new Response('[]', { status: 200 }),
  });
  try {
    const institution = await resolveInstitution('ust.hk', { cache: undefined });
    assert.equal(institution.rorId, 'https://ror.org/00q4vv597');
  } finally {
    upstream.restore();
  }
});

test('an exact match ends the search before any parent is asked about', async () => {
  const upstream = stubUpstreams({ ror: () => new Response(JSON.stringify(ROR_UAM), { status: 200 }), mdq: () => new Response('[]', { status: 200 }) });
  try {
    const institution = await resolveInstitution('uam.es', { cache: undefined });
    assert.equal(institution.rorId, 'https://ror.org/01cby8j38');
    assert.equal(upstream.calls.filter(url => url.startsWith('https://api.ror.org/')).length, 1);
  } finally {
    upstream.restore();
  }
});

/** A fetch that never answers until its signal aborts, counting what was started. */
function stalledFetch(onCall: (url: string) => void = () => {}) {
  const started: string[] = [];
  const fetchImpl: typeof fetch = (url, init) => new Promise((resolve, reject) => {
    started.push(String(url));
    onCall(String(url));
    const signal = init?.signal;
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort);
  });
  return { fetchImpl, started };
}

test('a link asks ROR one question, and a budget that runs out during it is unavailable with nothing started after it', async () => {
  for (const [domain, question] of [
    ['usal.es', 'domains:usal.es'],
    ['alumnos.uc3m.es', '03ths8210'],
    ['husky.neu.edu', 'domains:northeastern.edu'],
  ]) {
    const controller = new AbortController();
    const { fetchImpl, started } = stalledFetch(() => controller.abort());
    await rejectsWith(resolveInstitution(domain, { fetchImpl, cache: null, signal: controller.signal }), 'INSTITUTION_LOOKUP_UNAVAILABLE', 502);
    assert.equal(started.length, 1, `${domain}: nothing is started once the budget is gone`);
    assert.deepEqual(rorQuestions(started), [question], domain);
  }
});

test('the identity provider lookup is skipped when the budget is gone, and the confirmed institution still links', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    started.push(String(url));
    // ROR answers at once; what is left of the budget is spent by the time the federation would be asked.
    controller.abort();
    return new Response(JSON.stringify(ROR_UAM), { status: 200 });
  };
  const institution = await resolveInstitution('uam.es', { fetchImpl, cache: undefined, signal: controller.signal });
  assert.equal(institution.rorId, 'https://ror.org/01cby8j38');
  assert.equal(institution.entityId, null);
  assert.deepEqual(started.filter(url => url.startsWith('https://md.seamlessaccess.org/')), []);
});

test('the lookup budget leaves the browser\'s wait room for the identity checks and the write', () => {
  assert.ok(LINK_LOOKUP_BUDGET_MS <= DEFAULT_REQUEST_TIMEOUT_MS - 4000, `${LINK_LOOKUP_BUDGET_MS} against a ${DEFAULT_REQUEST_TIMEOUT_MS} ms wait`);
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
