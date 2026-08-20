import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicListPayload,
  createShareId,
  handlePublicListRequest,
  PublicListApiError,
} from './public-list-api.js';
import { decodeFields } from './firestore-admin.js';

const UID = 'alice-uid';
const OTHER = 'mallory-uid';
const SHARE = 'a'.repeat(32);
const NOW = Date.parse('2026-08-20T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Doubles.
// ---------------------------------------------------------------------------

/** A quota ledger that accepts `capacity` reservations and then refuses. */
function ledger(capacity = 10) {
  let used = 0;
  return {
    idFromName: name => name,
    get: () => ({
      fetch: async () => {
        used += 1;
        return new Response(JSON.stringify(
          used <= capacity ? { accepted: true } : { accepted: false },
        ), { status: 200 });
      },
    }),
  };
}

function envWith(overrides = {}) {
  return {
    FIREBASE_WEB_API_KEY: 'web-key',
    FIREBASE_SERVICE_ACCOUNT_EMAIL: 'papertok-worker@papertok-168df.iam.gserviceaccount.com',
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
    FIREBASE_PROJECT_ID: 'papertok-168df',
    REQUEST_QUOTA_LEDGER: ledger(),
    ...overrides,
  };
}

/** An in-memory stand-in for the Firestore admin client. */
function fakeAdmin(documents = {}) {
  const commits = [];
  return {
    commits,
    documents,
    projectId: 'papertok-168df',
    name: segments => `projects/papertok-168df/databases/(default)/documents/${segments.join('/')}`,
    async getDocument(segments) {
      return documents[segments.join('/')] ?? null;
    },
    async commit(writes) {
      commits.push(writes);
      return {};
    },
  };
}

let identityLookups = 0;
function stubIdentity({ uid = UID, ok = true } = {}) {
  identityLookups = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('identitytoolkit')) {
      identityLookups += 1;
      return new Response(JSON.stringify(ok ? { users: [{ localId: uid }] } : {}), {
        status: ok ? 200 : 400,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function post(pathname, body, { token = 'id-token' } = {}) {
  return new Request(`https://worker.test${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const paper = (i, overrides = {}) => ({
  id: `arxiv:2608.${18000 + i}`,
  title: `Paper ${i}`,
  authors: ['Ada Lovelace', 'Grace Hopper'],
  summary: 'An abstract.',
  year: 2026,
  primaryCategory: 'cs.LG',
  doi: `10.1234/papertok.${i}`,
  landingPageUrl: `https://arxiv.org/abs/2608.${18000 + i}`,
  ...overrides,
});

const listOf = count => Array.from({ length: count }, (_, i) => paper(i));

/** Runs the real entry point with the doubles wired in. */
async function run(pathname, body, { admin = fakeAdmin(), env = envWith(), cryptoApi } = {}) {
  return handlePublicListRequest(post(pathname, body), env, pathname, {
    admin,
    now: () => NOW,
    cryptoApi: cryptoApi || { getRandomValues: bytes => bytes.fill(0xaa) },
  });
}

function fieldsOf(write) {
  return decodeFields(write.update.fields);
}

// ---------------------------------------------------------------------------
// Routing and configuration.
// ---------------------------------------------------------------------------

test('an unknown path and a non-POST are refused before anything else runs', async () => {
  stubIdentity();
  await assert.rejects(
    () => handlePublicListRequest(post('/lists/publish', {}), envWith(), '/lists/nope', {}),
    error => error.code === 'NOT_FOUND' && error.status === 404,
  );
  const get = new Request('https://worker.test/lists/publish', { method: 'GET' });
  await assert.rejects(
    () => handlePublicListRequest(get, envWith(), '/lists/publish', {}),
    error => error.code === 'METHOD_NOT_ALLOWED' && error.status === 405,
  );
});

test('without the service account the route says so instead of half-working', async () => {
  stubIdentity();
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] },
      { env: envWith({ FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '' }) }),
    error => error.code === 'PUBLISHING_NOT_CONFIGURED' && error.status === 503,
  );
});

test('a bad token is refused and never reaches Firestore', async () => {
  stubIdentity({ ok: false });
  const admin = fakeAdmin();
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin }),
    error => error.code === 'AUTH_REQUIRED' && error.status === 401,
  );
  assert.equal(admin.commits.length, 0);
});

test('identity is re-checked on every write, never served from the 60 s cache', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1', name: 'L' } });
  await run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin });
  const admin2 = fakeAdmin({ [`users/${UID}/lists/l2`]: { id: 'l2', name: 'L' } });
  await run('/lists/publish', { listId: 'l2', title: 'T', papers: [] }, { admin: admin2 });
  assert.equal(identityLookups, 2, 'a revoked token must not stay good for a minute');
});

// ---------------------------------------------------------------------------
// Quota — the Spark allowance depends on it.
// ---------------------------------------------------------------------------

test('an unwired quota ledger fails closed rather than uncapping the route', async () => {
  stubIdentity();
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] },
      { env: envWith({ REQUEST_QUOTA_LEDGER: null }) }),
    error => error.code === 'PUBLISH_QUOTA_NOT_CONFIGURED' && error.status === 503,
  );
});

test('over the daily cap the caller gets 429 and nothing is written', async () => {
  stubIdentity();
  const env = envWith({ REQUEST_QUOTA_LEDGER: ledger(1) });
  const admin = fakeAdmin({
    [`users/${UID}/lists/l1`]: { id: 'l1' },
    [`users/${UID}/lists/l2`]: { id: 'l2' },
  });
  await run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin, env });
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l2', title: 'T', papers: [] }, { admin, env }),
    error => error.code === 'PUBLISH_QUOTA_EXCEEDED' && error.status === 429,
  );
  assert.equal(admin.commits.length, 1);
});

// ---------------------------------------------------------------------------
// Publish.
// ---------------------------------------------------------------------------

test('publishing writes owner, list and the private pointer in ONE commit', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista' } });
  const result = await run('/lists/publish', {
    listId: 'l1', title: 'Mi lista', language: 'es', papers: listOf(12),
  }, { admin });

  assert.equal(admin.commits.length, 1, 'a publish must be atomic, as the client batch was');
  const [ownerWrite, listWrite, pointerWrite] = admin.commits[0];

  assert.match(result.shareId, /^[a-f0-9]{32}$/);
  assert.deepEqual(fieldsOf(ownerWrite), {
    ownerId: UID, listId: 'l1', createdAt: new Date(NOW),
  });
  assert.deepEqual(ownerWrite.currentDocument, { exists: false }, 'must not clobber a live share');

  const published = fieldsOf(listWrite);
  assert.equal(published.paperCount, 12);
  assert.equal(published.papers.length, 12);
  assert.equal(published.createdAt.getTime(), NOW);
  assert.equal(published.updatedAt.getTime(), NOW);

  assert.deepEqual(fieldsOf(pointerWrite), { publicShareId: result.shareId });
  assert.deepEqual(pointerWrite.updateMask, { fieldPaths: ['publicShareId'] });
});

test('the 12-paper ceiling is gone: 50 papers publish', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  const result = await run('/lists/publish', {
    listId: 'l1', title: 'Bibliografía', papers: listOf(50),
  }, { admin });
  assert.equal(result.paperCount, 50);
  assert.equal(fieldsOf(admin.commits[0][1]).papers.length, 50);
});

test('past the cap the caller is told, not quietly truncated', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: listOf(51) }, { admin }),
    error => error.code === 'PAPERS_REJECTED' && error.status === 400,
  );
  assert.equal(admin.commits.length, 0);
});

test('publishing a list that is not yours, or does not exist, is a 404', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${OTHER}/lists/l1`]: { id: 'l1' } });
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin }),
    error => error.code === 'LIST_NOT_FOUND' && error.status === 404,
  );
  assert.equal(admin.commits.length, 0);
});

test('publishing twice is refused instead of orphaning the first share', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`users/${UID}/lists/l1`]: { id: 'l1', publicShareId: SHARE },
  });
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin }),
    error => error.code === 'ALREADY_PUBLISHED' && error.status === 409,
  );
});

test('a hostile list id cannot walk out of the caller own subtree', async () => {
  stubIdentity();
  for (const listId of ['../../publicLists', 'a/b', '', 'x'.repeat(161)]) {
    await assert.rejects(
      () => run('/lists/publish', { listId, title: 'T', papers: [] }),
      error => error.code === 'INVALID_LIST_ID',
      `must refuse ${JSON.stringify(listId)}`,
    );
  }
});

test('a javascript: link never reaches the public document', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  await run('/lists/publish', {
    listId: 'l1',
    title: 'T',
    papers: [paper(0, { landingPageUrl: 'javascript:alert(1)', doi: '', id: 'plain-id' })],
  }, { admin });
  const [published] = fieldsOf(admin.commits[0][1]).papers;
  assert.ok(!('openUrl' in published), 'a non-https link is dropped, not stored');
});

test('unknown keys are dropped rather than published', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  await run('/lists/publish', {
    listId: 'l1',
    title: 'T',
    secretField: 'nope',
    papers: [paper(0, { note: 'private', email: 'owner@example.test' })],
  }, { admin });
  const stored = fieldsOf(admin.commits[0][1]);
  assert.ok(!('secretField' in stored));
  assert.ok(!('note' in stored.papers[0]));
  assert.ok(!('email' in stored.papers[0]));
});

test('a list with no title is refused', async () => {
  stubIdentity();
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: '   ', papers: [] }),
    error => error.code === 'TITLE_REQUIRED',
  );
});

// ---------------------------------------------------------------------------
// Update.
// ---------------------------------------------------------------------------

test('an update moves updatedAt and cannot move createdAt', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Nuevo', papers: listOf(3),
  }, { admin });

  const [write] = admin.commits[0];
  const fields = fieldsOf(write);
  assert.ok(!('createdAt' in fields), 'createdAt is never sent');
  assert.ok(!write.updateMask.fieldPaths.includes('createdAt'), 'nor named in the mask');
  assert.equal(fields.updatedAt.getTime(), NOW);
  assert.deepEqual(write.currentDocument, { exists: true }, 'update must not create');
});

test('dropping the description removes it from the public document', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  await run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'T', papers: [] }, { admin });
  const [write] = admin.commits[0];
  assert.ok(write.updateMask.fieldPaths.includes('description'), 'named in the mask...');
  assert.ok(!('description' in write.update.fields), '...and absent from the fields, so it is deleted');
});

test('updating someone else public list is a 403', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: OTHER, listId: 'l1' } });
  await assert.rejects(
    () => run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'T', papers: [] }, { admin }),
    error => error.code === 'NOT_THE_OWNER' && error.status === 403,
  );
  assert.equal(admin.commits.length, 0);
});

test('an unknown share is a 404, and a malformed one never gets that far', async () => {
  stubIdentity();
  await assert.rejects(
    () => run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'T', papers: [] }),
    error => error.code === 'SHARE_NOT_FOUND' && error.status === 404,
  );
  for (const shareId of ['', 'ZZZ', 'a'.repeat(31), `${'a'.repeat(32)}b`]) {
    await assert.rejects(
      () => run('/lists/update', { shareId, listId: 'l1', title: 'T', papers: [] }),
      error => error.code === 'INVALID_SHARE_ID',
      `must refuse ${JSON.stringify(shareId)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Unpublish.
// ---------------------------------------------------------------------------

test('unpublishing removes both public documents AND the private pointer', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  await run('/lists/unpublish', { shareId: SHARE, listId: 'l1' }, { admin });

  const [dropList, dropOwner, clearPointer] = admin.commits[0];
  assert.match(dropList.delete, /publicLists\/a{32}$/);
  assert.match(dropOwner.delete, /publicListOwners\/a{32}$/);
  // Without this the owner keeps a list that claims to be published and a
  // delete rule that will not let it go.
  assert.match(clearPointer.update.name, new RegExp(`users/${UID}/lists/l1$`));
  assert.deepEqual(clearPointer.updateMask, { fieldPaths: ['publicShareId'] });
  assert.deepEqual(clearPointer.update.fields, {});
});

test('unpublishing someone else share is a 403', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: OTHER, listId: 'l1' } });
  await assert.rejects(
    () => run('/lists/unpublish', { shareId: SHARE, listId: 'l1' }, { admin }),
    error => error.code === 'NOT_THE_OWNER',
  );
  assert.equal(admin.commits.length, 0);
});

// ---------------------------------------------------------------------------
// Payload gate and share ids, on their own.
// ---------------------------------------------------------------------------

test('buildPublicListPayload refuses what sanitizing would have silently fixed', () => {
  assert.throws(() => buildPublicListPayload({ title: 'T', papers: listOf(51) }),
    error => error.code === 'PAPERS_REJECTED');
  assert.throws(() => buildPublicListPayload({ title: '', papers: [] }),
    error => error.code === 'TITLE_REQUIRED');
  // A paper with no usable id or title is dropped by the sanitizer, so the
  // counts diverge and the caller hears about it.
  assert.throws(() => buildPublicListPayload({ title: 'T', papers: [{ title: '' }] }),
    error => error instanceof PublicListApiError);
});

test('a well-formed list passes the gate untouched', () => {
  const payload = buildPublicListPayload({ title: 'T', language: 'en', papers: listOf(4) });
  assert.equal(payload.language, 'en');
  assert.equal(payload.paperCount, 4);
});

test('share ids are 128 bits of lowercase hex, the shape the app already reads', () => {
  const id = createShareId({ getRandomValues: bytes => bytes.forEach((_, i) => { bytes[i] = i; }) });
  assert.equal(id, '000102030405060708090a0b0c0d0e0f');
});
