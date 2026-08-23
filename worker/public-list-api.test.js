import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublicListPayload,
  createShareId,
  handlePublicListRequest,
  mergePreparedPayload,
  prepareMergeInput,
  PublicListApiError,
} from './public-list-api.js';
import { decodeFields, FirestoreAdminError } from './firestore-admin.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';

const UID = 'alice-uid';
const OTHER = 'mallory-uid';
const SHARE = 'a'.repeat(32);
const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const PROJECT_ID = 'papertok-168df';
// The Worker refuses a token that is not shaped like one before it spends a
// call on Identity Toolkit, so the fixture has to look like the real thing.
const TOKEN = fakeIdToken({ aud: PROJECT_ID });

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
    FIREBASE_PROJECT_ID: PROJECT_ID,
    REQUEST_QUOTA_LEDGER: ledger(),
    ...overrides,
  };
}

/**
 * An in-memory stand-in for the Firestore admin client.
 *
 * `failOn` lists 1-based commit attempts that reject with the 409 the real
 * client raises on a lost precondition; a failed attempt records nothing,
 * like the real thing. `commits` keeps only the successes.
 */
function fakeAdmin(documents = {}, { updateTimes = {}, failOn = [] } = {}) {
  const commits = [];
  let attempts = 0;
  return {
    commits,
    documents,
    projectId: 'papertok-168df',
    name: segments => `projects/papertok-168df/databases/(default)/documents/${segments.join('/')}`,
    async getDocument(segments, { withMeta = false } = {}) {
      const data = documents[segments.join('/')] ?? null;
      if (!withMeta) return data;
      if (data === null) return null;
      return {
        data,
        updateTime: updateTimes[segments.join('/')] ?? '2026-08-20T00:00:00.000000Z',
      };
    },
    async commit(writes) {
      attempts += 1;
      if (failOn.includes(attempts)) {
        throw new FirestoreAdminError('FIRESTORE_PRECONDITION_FAILED', 409);
      }
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

function post(pathname, body, { token = TOKEN } = {}) {
  return new Request(`https://worker.test${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * A POST whose body arrives chunked, so no `content-length` rides along and the
 * only thing standing between the caller and the isolate is the size check.
 */
function streamedPost(pathname, text) {
  const bytes = new TextEncoder().encode(text);
  return new Request(`https://worker.test${pathname}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: 'half',
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
async function run(pathname, body, { admin = fakeAdmin(), env = envWith(), cryptoApi, request } = {}) {
  return handlePublicListRequest(request || post(pathname, body), env, pathname, {
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

test('the body ceiling counts bytes, not UTF-16 code units', async () => {
  stubIdentity();
  // 400k three-byte characters: 400k code units and 1.2 MB. Measured as a
  // string length it slipped under a limit that is written in bytes.
  const oversized = `{"listId":"l1","title":"${'字'.repeat(400_000)}","papers":[]}`;
  await assert.rejects(
    () => run('/lists/publish', null, {
      request: streamedPost('/lists/publish', oversized),
    }),
    error => error.code === 'PAYLOAD_TOO_LARGE' && error.status === 413,
  );
});

test('a body that is merely large still gets through', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  const padded = JSON.stringify({
    listId: 'l1', title: 'T', papers: [], junk: 'a'.repeat(900_000),
  });
  await run('/lists/publish', null, { admin, request: streamedPost('/lists/publish', padded) });
  assert.equal(admin.commits.length, 1, '900 kB of ASCII is under the ceiling and must pass');
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

test('a body that never reaches Firestore does not spend a unit of the daily cap', async () => {
  stubIdentity();
  const env = envWith({ REQUEST_QUOTA_LEDGER: ledger(1) });
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1' } });
  const refused = [
    ['/lists/publish', { listId: '', title: 'T', papers: [] }],
    ['/lists/publish', { listId: 'l1', title: '', papers: [] }],
    ['/lists/publish', { listId: 'l1', title: 'T', papers: listOf(51) }],
    ['/lists/update', { shareId: 'ZZZ', title: 'T', papers: [] }],
    ['/lists/unpublish', { shareId: 'nope' }],
    ['/lists/attribute', { shareId: SHARE, attributed: 'yes' }],
  ];
  for (const [pathname, body] of refused) {
    await assert.rejects(
      () => run(pathname, body, { admin, env }),
      error => error instanceof PublicListApiError && error.status === 400,
      `must refuse ${pathname} ${JSON.stringify(body)}`,
    );
  }
  // Charging for these let a handful of accounts spend the global allowance on
  // rejects and take publishing away from everybody, for nothing.
  await run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin, env });
  assert.equal(admin.commits.length, 1, 'the one unit the ledger held was still there');
});

test('a failure that did reach Firestore still spends its unit', async () => {
  stubIdentity();
  const env = envWith({ REQUEST_QUOTA_LEDGER: ledger(1) });
  const admin = fakeAdmin({
    [`users/${UID}/lists/l1`]: { id: 'l1', publicShareId: SHARE },
    [`users/${UID}/lists/l2`]: { id: 'l2' },
  });
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: [] }, { admin, env }),
    error => error.code === 'ALREADY_PUBLISHED' && error.status === 409,
  );
  // Deliberate, and the reason the discriminator is "did it read Firestore"
  // rather than "is it a 409": that refusal spent a read of the free-tier
  // allowance, and this cap is the only thing bounding that allowance.
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l2', title: 'T', papers: [] }, { admin, env }),
    error => error.code === 'PUBLISH_QUOTA_EXCEEDED' && error.status === 429,
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

test('publishing writes owner, list, pointer and showcase card in ONE commit', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista', emoji: 'Folder' } });
  const result = await run('/lists/publish', {
    listId: 'l1', title: 'Mi lista', language: 'es', papers: listOf(12),
  }, { admin });

  assert.equal(admin.commits.length, 1, 'a publish must be atomic, as the client batch was');
  const [ownerWrite, listWrite, pointerWrite, cardWrite] = admin.commits[0];

  assert.match(result.shareId, /^[a-f0-9]{32}$/);
  assert.equal(result.attributed, true, 'attributed by default (F12)');
  assert.deepEqual(fieldsOf(ownerWrite), {
    ownerId: UID, listId: 'l1', createdAt: new Date(NOW),
  });
  assert.deepEqual(ownerWrite.currentDocument, { exists: false }, 'must not clobber a live share');

  const published = fieldsOf(listWrite);
  assert.equal(published.paperCount, 12);
  assert.equal(published.papers.length, 12);
  assert.equal(published.createdAt.getTime(), NOW);
  assert.equal(published.updatedAt.getTime(), NOW);

  // The pointer now carries the F12 stamps: the attribution mirror and the
  // in-step marker, born in the same commit as the copy they describe.
  assert.deepEqual(fieldsOf(pointerWrite), {
    publicShareId: result.shareId, onProfile: true, publicSyncedAt: new Date(NOW),
  });
  assert.deepEqual(pointerWrite.updateMask, {
    fieldPaths: ['publicShareId', 'onProfile', 'publicSyncedAt'],
  });

  // And the showcase card is part of the SAME commit, not a courtesy after it.
  assert.match(cardWrite.update.name, new RegExp(`profileLists/${UID}$`));
  const showcase = fieldsOf(cardWrite);
  assert.deepEqual(showcase.lists, [{
    shareId: result.shareId, title: 'Mi lista', emoji: 'Folder',
    paperCount: 12, publishedAt: new Date(NOW),
  }]);
  assert.equal(cardWrite.currentDocument, undefined, 'a first card may create the document');
});

test('publishing with attributed:false skips the showcase and mirrors it', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista' } });
  const result = await run('/lists/publish', {
    listId: 'l1', title: 'Anónima', papers: listOf(2), attributed: false,
  }, { admin });

  assert.equal(result.attributed, false);
  assert.equal(admin.commits.length, 1);
  assert.equal(admin.commits[0].length, 3, 'no showcase write for an anonymous publish');
  const pointer = fieldsOf(admin.commits[0][2]);
  assert.equal(pointer.onProfile, false);
});

test('a full showcase refuses the 31st attributed publish, not the anonymous one', async () => {
  stubIdentity();
  const fullShowcase = {
    lists: Array.from({ length: 30 }, (_, i) => ({
      shareId: String(i).padStart(32, '0'), title: `L${i}`, paperCount: 1,
      publishedAt: new Date(NOW),
    })),
  };
  const documents = {
    [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista' },
    [`profileLists/${UID}`]: fullShowcase,
  };
  await assert.rejects(
    () => run('/lists/publish', { listId: 'l1', title: 'T', papers: listOf(1) }, { admin: fakeAdmin(documents) }),
    error => error.code === 'PROFILE_LISTS_FULL' && error.status === 409,
  );
  const admin = fakeAdmin(documents);
  const result = await run('/lists/publish', {
    listId: 'l1', title: 'T', papers: listOf(1), attributed: false,
  }, { admin });
  assert.equal(result.attributed, false);
  assert.equal(admin.commits.length, 1);
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
  // `.` and `..` survive encodeURIComponent and are then resolved away by the
  // URL parser, so they address a document one level up from the one asked
  // about — the slash check alone never saw them.
  for (const listId of ['../../publicLists', 'a/b', '', 'x'.repeat(161), '.', '..']) {
    await assert.rejects(
      () => run('/lists/publish', { listId, title: 'T', papers: [] }),
      error => error.code === 'INVALID_LIST_ID',
      `must refuse ${JSON.stringify(listId)}`,
    );
  }
});

test('a dotted list id still publishes: only the bare dot segments are refused', async () => {
  stubIdentity();
  const listId = 'arxiv.2608.18000';
  const admin = fakeAdmin({ [`users/${UID}/lists/${listId}`]: { id: listId } });
  await run('/lists/publish', { listId, title: 'T', papers: [] }, { admin });
  assert.equal(fieldsOf(admin.commits[0][0]).listId, listId);
  assert.match(admin.commits[0][2].update.name, /arxiv\.2608\.18000$/);
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
  // delete rule that will not let it go. The F12 stamps leave with the
  // pointer: an unpublished list is on no profile and in step with nothing.
  assert.match(clearPointer.update.name, new RegExp(`users/${UID}/lists/l1$`));
  assert.deepEqual(clearPointer.updateMask, {
    fieldPaths: ['publicShareId', 'onProfile', 'publicSyncedAt'],
  });
  assert.deepEqual(clearPointer.update.fields, {});
});

test('the pointer cleared is the share own list, not the one the body names', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  // A client with a stale view sends the wrong list. Clearing l2's pointer
  // would strand l1 — unpublishable and undeletable — and orphan l2's public
  // copy at the same time.
  await run('/lists/unpublish', { shareId: SHARE, listId: 'l2' }, { admin });
  const [, , clearPointer] = admin.commits[0];
  assert.match(clearPointer.update.name, new RegExp(`users/${UID}/lists/l1$`));
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
// The pinned card follows the list.
// ---------------------------------------------------------------------------

const OTHER_SHARE = 'f'.repeat(32);

/** Documents for an owner whose profile pins SHARE (plus one other list). */
function pinnedFixture(profileOverrides = {}) {
  return {
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`userProfiles/${UID}`]: {
      handle: 'alice',
      displayName: 'Alice',
      pinnedLists: [
        { shareId: OTHER_SHARE, title: 'Otra', paperCount: 2 },
        { shareId: SHARE, title: 'Vieja', emoji: 'Folder', paperCount: 12 },
      ],
      ...profileOverrides,
    },
  };
}

test('updating a pinned list refreshes its card: count, title, and nothing else', async () => {
  stubIdentity();
  const admin = fakeAdmin(pinnedFixture(), {
    updateTimes: { [`userProfiles/${UID}`]: '2026-08-20T19:00:00.123456Z' },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Relatividad numérica', papers: listOf(19),
  }, { admin });

  assert.equal(result.pinCard, 'refreshed');
  assert.equal(admin.commits.length, 2, 'the list commit and the card commit are separate');
  const [write] = admin.commits[1];
  assert.match(write.update.name, new RegExp(`userProfiles/${UID}$`));
  assert.deepEqual(write.updateMask, { fieldPaths: ['pinnedLists', 'updatedAt'] });
  // The refresh must lose a race against a concurrent pin toggle, not win it.
  assert.deepEqual(write.currentDocument, { updateTime: '2026-08-20T19:00:00.123456Z' });
  const pins = fieldsOf(write).pinnedLists;
  assert.deepEqual(pins[0], { shareId: OTHER_SHARE, title: 'Otra', paperCount: 2 }, 'other pins ride along untouched');
  assert.deepEqual(pins[1], {
    shareId: SHARE, title: 'Relatividad numérica', emoji: 'Folder', paperCount: 19,
  }, 'count and title follow the list; the emoji is the pin\'s own and stays');
});

test('updating a list nobody pinned costs one profile read and no extra write', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`userProfiles/${UID}`]: { handle: 'alice', pinnedLists: [] },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'T', papers: [],
  }, { admin });
  assert.equal(result.pinCard, 'not-pinned');
  assert.equal(admin.commits.length, 1);
});

test('an update that changes nothing the card shows writes nothing', async () => {
  stubIdentity();
  const admin = fakeAdmin(pinnedFixture({
    pinnedLists: [{ shareId: SHARE, title: 'Igual', paperCount: 3 }],
  }));
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Igual', papers: listOf(3),
  }, { admin });
  assert.equal(result.pinCard, 'unchanged');
  assert.equal(admin.commits.length, 1);
});

test('hidden pins are refreshed in the stash, where F8 parked them', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`userProfiles/${UID}`]: { handle: 'alice', pinnedLists: [], showPinnedLists: false },
    [`users/${UID}/profileStash/pinnedLists`]: {
      pinnedLists: [{ shareId: SHARE, title: 'Vieja', paperCount: 12 }],
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Nueva', papers: listOf(19),
  }, { admin });
  assert.equal(result.pinCard, 'refreshed');
  const [write] = admin.commits[1];
  assert.match(write.update.name, new RegExp(`users/${UID}/profileStash/pinnedLists$`));
  assert.equal(fieldsOf(write).pinnedLists[0].paperCount, 19);
});

test('unpublishing a pinned list removes its card and keeps the others', async () => {
  stubIdentity();
  const admin = fakeAdmin(pinnedFixture());
  const result = await run('/lists/unpublish', { shareId: SHARE, listId: 'l1' }, { admin });
  assert.equal(result.pinCard, 'removed');
  const pins = fieldsOf(admin.commits[1][0]).pinnedLists;
  assert.deepEqual(pins, [{ shareId: OTHER_SHARE, title: 'Otra', paperCount: 2 }],
    'the orphan is gone at its source; no stale card is left to veto profile writes');
});

test('losing the race against a pin toggle retries once from a fresh read', async () => {
  stubIdentity();
  const admin = fakeAdmin(pinnedFixture(), { failOn: [2] });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'T', papers: listOf(5),
  }, { admin });
  assert.equal(result.pinCard, 'refreshed');
  assert.equal(admin.commits.length, 2, 'main write plus the retried card write');
});

test('the card is a courtesy: when every refresh attempt fails, the update still lands', async () => {
  stubIdentity();
  const admin = fakeAdmin(pinnedFixture(), { failOn: [2, 3] });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'T', papers: listOf(5),
  }, { admin });
  assert.equal(result.pinCard, 'skipped');
  assert.equal(admin.commits.length, 1, 'the list update committed; the card kept its staleness');
});

test('a broken profile read cannot break the unpublish that already committed', async () => {
  stubIdentity();
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  admin.getDocument = async (segments, options) => {
    if (segments[0] === 'userProfiles') throw new FirestoreAdminError('FIRESTORE_READ_FAILED', 502);
    if (options?.withMeta) return null;
    return admin.documents[segments.join('/')] ?? null;
  };
  const result = await run('/lists/unpublish', { shareId: SHARE, listId: 'l1' }, { admin });
  assert.equal(result.unpublished, true);
  assert.equal(result.pinCard, 'skipped');
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

// ---------------------------------------------------------------------------
// F12: the showcase travels in the list's own commit, and /lists/attribute.
// ---------------------------------------------------------------------------

/** Documents for an owner whose showcase already holds SHARE and one more. */
function showcaseFixture(extra = {}) {
  return {
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista', emoji: 'Folder' },
    [`profileLists/${UID}`]: {
      lists: [
        { shareId: OTHER_SHARE, title: 'Otra', paperCount: 2, publishedAt: new Date(NOW - 1000) },
        { shareId: SHARE, title: 'Vieja', emoji: 'Folder', paperCount: 12, publishedAt: new Date(NOW - 500) },
      ],
      updatedAt: new Date(NOW - 500),
    },
    ...extra,
  };
}

test('F12: updating an attributed list refreshes its showcase card in the SAME commit', async () => {
  stubIdentity();
  const admin = fakeAdmin(showcaseFixture(), {
    updateTimes: { [`profileLists/${UID}`]: '2026-08-20T19:00:00.123456Z' },
  });
  await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Relatividad', papers: listOf(19),
  }, { admin });

  const writes = admin.commits[0];
  assert.equal(writes.length, 3, 'public doc + sync stamp + showcase, one commit');

  const stamp = writes[1];
  assert.match(stamp.update.name, new RegExp(`users/${UID}/lists/l1$`));
  assert.deepEqual(fieldsOf(stamp), { publicSyncedAt: new Date(NOW) });

  const showcase = writes[2];
  assert.match(showcase.update.name, new RegExp(`profileLists/${UID}$`));
  const cards = fieldsOf(showcase).lists;
  assert.deepEqual(cards.map(card => [card.shareId, card.title, card.paperCount]), [
    [OTHER_SHARE, 'Otra', 2],
    [SHARE, 'Relatividad', 19],
  ]);
  assert.deepEqual(showcase.currentDocument, {
    updateTime: '2026-08-20T19:00:00.123456Z',
  }, 'a racing showcase write must fail the commit, not lose a card');
});

test('F12: updating an unattributed list stamps the sync and leaves the showcase alone', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista' },
  });
  await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Anónima', papers: listOf(2),
  }, { admin });
  assert.equal(admin.commits[0].length, 2, 'no showcase write when no card is held');
});

test('F12 merge: unhydrated papers survive from the published copy, removals still land', async () => {
  stubIdentity();
  const published = {
    title: 'Vieja', paperCount: 3, papers: [
      { id: 'arxiv:2608.18000', title: 'Paper 0', authors: ['A'] },
      { id: 'arxiv:2608.18001', title: 'Paper 1', authors: ['A'] },
      { id: 'arxiv:2608.18002', title: 'Paper 2', authors: ['A'] },
    ],
  };
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: {
      id: 'l1',
      paperIds: ['arxiv:2608.18000', 'arxiv:2608.18001', 'arxiv:2608.18099'],
    },
    [`publicLists/${SHARE}`]: published,
  });
  // The list now holds 0, 1 and a new paper; 2 was removed. The client could
  // hydrate only the new one. (No doi on it, so its sanitized id keeps the
  // arxiv spelling — the join key is the RAW id either way.)
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja',
    papers: [paper(99, { doi: undefined, listPaperId: 'arxiv:2608.18099' })],
  }, { admin });

  assert.deepEqual(result.papers.map(p => p.id), [
    'arxiv:2608.18000', 'arxiv:2608.18001', 'arxiv:2608.18099',
  ]);
  assert.equal(result.paperCount, 3);
});

test('F12 merge: an id that matches nothing is dropped, never invented', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['arxiv:2608.19999'] },
    [`publicLists/${SHARE}`]: { title: 'Vieja', paperCount: 0, papers: [] },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja', papers: [],
  }, { admin });
  assert.deepEqual(result.papers, []);
  assert.equal(result.paperCount, 0);
  // Counted, not hidden: the owner is told rather than left comparing numbers
  // between two accounts.
  assert.deepEqual({ listCount: result.listCount, skipped: result.skipped },
    { listCount: 1, skipped: 1 });
});

/* --- The membership is the private list's, not the caller's ---------------
   THE BUG this whole group exists for: the save-and-organize modal paints
   from a 30-second session cache, so the `paperIds` it sent were a client-side
   reconstruction. Trusting them deleted two papers from a real shared list —
   including one that was already published — because they were missing from
   that reconstruction. */

test('THE BUG: a stale membership from the client cannot shrink a published list', async () => {
  stubIdentity();
  // Twelve papers in the list, ten already published, two hydrated by the
  // caller. The caller ALSO sends a three-id membership it read minutes ago.
  const ids = Array.from({ length: 12 }, (_, i) => `arxiv:2608.${18000 + i}`);
  const published = {
    title: 'Papers de sugar',
    paperCount: 10,
    papers: ids.slice(0, 10).map((id, i) => ({
      id, title: `Paper ${i}`, authors: ['A'], sourceId: id,
    })),
  };
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ids },
    [`publicLists/${SHARE}`]: published,
  });

  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Papers de sugar',
    paperIds: ids.slice(0, 3),
    papers: [
      paper(10, { doi: undefined, listPaperId: ids[10] }),
      paper(11, { doi: undefined, listPaperId: ids[11] }),
    ],
  }, { admin });

  assert.equal(result.paperCount, 12, 'the list has twelve; the public copy must too');
  assert.deepEqual(result.papers.map(entry => entry.sourceId ?? entry.id), ids);
  assert.equal(result.skipped, 0);
});

test('a client-sanitized paper keeps its join key through the Worker', async () => {
  stubIdentity();
  // What the browser really sends: already sanitized, so the key arrives as
  // `sourceId`, not as the `listPaperId` the browser was given. The Worker
  // sanitizes again; if that pass drops the field the join silently falls back
  // to guessing from doi/arxivId, which is what lost a paper in production.
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['legacy-provider-id'] },
    [`publicLists/${SHARE}`]: { title: 'Vieja', paperCount: 0, papers: [] },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja',
    papers: [{
      id: 'arxiv:2608.18000',
      title: 'Paper 0',
      authors: ['Ada Lovelace'],
      arxivId: '2608.18000',
      sourceId: 'legacy-provider-id',
    }],
  }, { admin });

  assert.equal(result.paperCount, 1, 'the membership id must find the paper the client sent');
  assert.equal(result.papers[0].sourceId, 'legacy-provider-id',
    'and the key must be written down, so the NEXT sync does not have to guess');
  assert.equal(result.papers[0].id, 'arxiv:2608.18000', 'the public id is unchanged');
});

test('a paper published under a derived id is found again by the id the list files it under', async () => {
  stubIdentity();
  // The exact shape that lost "Observation of perfect absorption…": the public
  // document keys it `doi:…`, the private list keys it by the bare DOI, and no
  // client hydrated it this time round.
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['10.1038/s41467-025-67163-z'] },
    [`publicLists/${SHARE}`]: {
      title: 'Vieja',
      paperCount: 1,
      papers: [{
        id: 'doi:10.1038/s41467-025-67163-z',
        title: 'Observation of perfect absorption',
        authors: ['A'],
        doi: '10.1038/s41467-025-67163-z',
        sourceId: '10.1038/s41467-025-67163-z',
      }],
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja', papers: [],
  }, { admin });
  assert.equal(result.paperCount, 1);
  assert.equal(result.skipped, 0);
});

test('a document published before sourceId existed still joins on its old spellings', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['10.1234/legacy', '2608.18000'] },
    [`publicLists/${SHARE}`]: {
      title: 'Vieja',
      paperCount: 2,
      papers: [
        { id: 'doi:10.1234/legacy', title: 'Legacy', authors: [], doi: '10.1234/legacy' },
        { id: 'arxiv:2608.18000', title: 'Old', authors: [], arxivId: '2608.18000' },
      ],
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja', papers: [],
  }, { admin });
  assert.equal(result.paperCount, 2, 'no backfill needed for the merge to keep them');
});

test('a list over the cap truncates instead of refusing to sync ever again', async () => {
  stubIdentity();
  const ids = Array.from({ length: 60 }, (_, i) => `arxiv:2608.${18000 + i}`);
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ids },
    [`publicLists/${SHARE}`]: {
      title: 'Larga',
      paperCount: 60,
      papers: ids.map((id, i) => ({ id, title: `P${i}`, authors: [], sourceId: id })),
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Larga', papers: [],
  }, { admin });
  assert.equal(result.paperCount, 50);
  assert.deepEqual({ listCount: result.listCount, skipped: result.skipped },
    { listCount: 60, skipped: 10 });
});

test('a private list with no paperIds still falls back to what the caller sent', async () => {
  stubIdentity();
  // An older client against the new Worker, or a list document that predates
  // the field: the merge still has something to work from.
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1' },
    [`publicLists/${SHARE}`]: {
      title: 'Vieja',
      paperCount: 1,
      papers: [{ id: 'arxiv:2608.18000', title: 'Old', authors: [] }],
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Vieja',
    paperIds: ['arxiv:2608.18000'], papers: [],
  }, { admin });
  assert.equal(result.paperCount, 1);
});

test('F12: unpublishing an attributed list removes its showcase card in the SAME commit', async () => {
  stubIdentity();
  const admin = fakeAdmin(showcaseFixture());
  await run('/lists/unpublish', { shareId: SHARE, listId: 'l1' }, { admin });

  const writes = admin.commits[0];
  assert.equal(writes.length, 4, 'two deletes + pointer clear + showcase');
  const cards = fieldsOf(writes[3]).lists;
  assert.deepEqual(cards.map(card => card.shareId), [OTHER_SHARE]);
});

test('F12: attributing a published list adds its card and mirrors onProfile', async () => {
  stubIdentity();
  const admin = fakeAdmin({
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', name: 'Mi lista', emoji: 'Star' },
    [`publicLists/${SHARE}`]: {
      title: 'Relatividad', paperCount: 19, papers: [], createdAt: new Date(NOW - 9000),
    },
  });
  const result = await run('/lists/attribute', { shareId: SHARE, attributed: true }, { admin });

  assert.deepEqual(result, { shareId: SHARE, attributed: true });
  const [mirror, showcase] = admin.commits[0];
  assert.deepEqual(fieldsOf(mirror), { onProfile: true });
  assert.deepEqual(fieldsOf(showcase).lists, [{
    shareId: SHARE, title: 'Relatividad', emoji: 'Star', paperCount: 19,
    publishedAt: new Date(NOW - 9000),
  }]);
});

test('F12: de-attributing removes the card and flips the mirror', async () => {
  stubIdentity();
  const admin = fakeAdmin(showcaseFixture());
  const result = await run('/lists/attribute', { shareId: SHARE, attributed: false }, { admin });

  assert.deepEqual(result, { shareId: SHARE, attributed: false });
  const [mirror, showcase] = admin.commits[0];
  assert.deepEqual(fieldsOf(mirror), { onProfile: false });
  assert.deepEqual(fieldsOf(showcase).lists.map(card => card.shareId), [OTHER_SHARE]);
});

test('F12: asking for what is already true is success and heals the mirror', async () => {
  stubIdentity();
  const admin = fakeAdmin(showcaseFixture());
  const result = await run('/lists/attribute', { shareId: SHARE, attributed: true }, { admin });

  assert.deepEqual(result, { shareId: SHARE, attributed: true, unchanged: true });
  assert.equal(admin.commits.length, 1);
  assert.equal(admin.commits[0].length, 1, 'only the mirror; the showcase is untouched');
  assert.deepEqual(fieldsOf(admin.commits[0][0]), { onProfile: true });
});

test('F12: attributing somebody else\'s share is a 403, a full showcase a 409, a non-bool a 400', async () => {
  stubIdentity();
  await assert.rejects(
    () => run('/lists/attribute', { shareId: SHARE, attributed: true }, {
      admin: fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: OTHER, listId: 'l1' } }),
    }),
    error => error.code === 'NOT_THE_OWNER' && error.status === 403,
  );
  await assert.rejects(
    () => run('/lists/attribute', { shareId: SHARE, attributed: true }, {
      admin: fakeAdmin({
        [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
        [`profileLists/${UID}`]: {
          lists: Array.from({ length: 30 }, (_, i) => ({
            shareId: String(i).padStart(32, '0'), title: `L${i}`, paperCount: 1,
          })),
        },
      }),
    }),
    error => error.code === 'PROFILE_LISTS_FULL' && error.status === 409,
  );
  await assert.rejects(
    () => run('/lists/attribute', { shareId: SHARE, attributed: 'yes' }, {
      admin: fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } }),
    }),
    error => error.code === 'INVALID_BODY' && error.status === 400,
  );
});

// ---------------------------------------------------------------------------
// The merge on its own. It sits four Firestore reads away from any route and
// it has already deleted papers from a real shared list twice, so it is worth
// reaching directly.
// ---------------------------------------------------------------------------

const HEADER_ONLY = { title: 'T', papers: [] };

test('a published paper the caller did not hydrate this time survives the merge', () => {
  const existing = { papers: [{ id: 'doi:10.1/x', sourceId: 'p1', title: 'Kept', authors: ['A'] }] };
  const merged = mergePreparedPayload(prepareMergeInput(HEADER_ONLY), existing, ['p1']);
  assert.deepEqual(merged.payload.papers.map(entry => entry.id), ['doi:10.1/x']);
  assert.equal(merged.payload.paperCount, 1);
  assert.deepEqual([merged.listCount, merged.skipped], [1, 0]);
});

test('an id that matches nothing anywhere is counted, never silently dropped', () => {
  const merged = mergePreparedPayload(prepareMergeInput(HEADER_ONLY), { papers: [] }, ['ghost']);
  assert.deepEqual(merged.payload.papers, []);
  // Counting it is how the owner gets told, instead of comparing numbers
  // between two accounts and finding no explanation.
  assert.deepEqual([merged.listCount, merged.skipped], [1, 1]);
});

test('documents published before sourceId existed still join by id, doi and arxivId', () => {
  const existing = {
    papers: [
      { id: 'doi:10.1/a', doi: '10.1/a', title: 'A', authors: ['A'] },
      { id: 'arxiv:2608.1', arxivId: '2608.1', title: 'B', authors: ['B'] },
    ],
  };
  const merged = mergePreparedPayload(
    prepareMergeInput(HEADER_ONLY), existing, ['10.1/a', '2608.1'],
  );
  assert.deepEqual(merged.payload.papers.map(entry => entry.id), ['doi:10.1/a', 'arxiv:2608.1']);
});

test('the membership decides, not the paperIds the request happens to carry', () => {
  const existing = {
    papers: [
      { id: 'a', sourceId: 'p1', title: 'A', authors: ['A'] },
      { id: 'b', sourceId: 'p2', title: 'B', authors: ['B'] },
    ],
  };
  const merged = mergePreparedPayload(
    prepareMergeInput({ ...HEADER_ONLY, paperIds: ['p1'] }), existing, ['p1', 'p2'],
  );
  assert.deepEqual(merged.payload.papers.map(entry => entry.id), ['a', 'b'],
    'trusting the request once cost a real shared list two papers');
});

test('past the cap the merge truncates and counts, rather than refusing to sync at all', () => {
  const existing = {
    papers: Array.from({ length: 60 }, (_, i) => ({
      id: `p${i}`, sourceId: `s${i}`, title: `Paper ${i}`, authors: ['A'],
    })),
  };
  const merged = mergePreparedPayload(
    prepareMergeInput(HEADER_ONLY), existing, existing.papers.map(entry => entry.sourceId),
  );
  // Refusing would leave a 60-paper list unable to sync anything, for ever.
  assert.equal(merged.payload.papers.length, 50);
  assert.deepEqual([merged.listCount, merged.skipped], [60, 10]);
});

test('preparing the input is pure: no membership needed, and a bad paper is refused there', () => {
  assert.throws(() => prepareMergeInput({ title: '', papers: [] }),
    error => error.code === 'TITLE_REQUIRED');
  assert.throws(() => prepareMergeInput({ title: 'T', papers: [{ title: '' }] }),
    error => error.code === 'PAPERS_REJECTED');
  // No id source at all is the caller's problem, and only mergePreparedPayload
  // can know it, because the membership arrives from Firestore.
  assert.throws(() => mergePreparedPayload(prepareMergeInput(HEADER_ONLY), { papers: [] }, null),
    error => error.code === 'INVALID_BODY');
});

// ---------------------------------------------------------------------------
// Two tabs at once. The merge is a read-modify-write and the showcase is
// another one; both writes are pinned, and losing either means reading it all
// again rather than committing what was already built.
// ---------------------------------------------------------------------------

/**
 * A fake whose documents change the instant a commit is refused — the winner of
 * the race landing between the loser's read and its retry.
 */
function racingAdmin(documents, { updateTimes = {}, afterRace = {} } = {}) {
  const admin = fakeAdmin(documents, { updateTimes, failOn: [1] });
  const commit = admin.commit;
  admin.commit = async (writes) => {
    try {
      return await commit(writes);
    } catch (error) {
      Object.assign(admin.documents, afterRace);
      throw error;
    }
  };
  return admin;
}

const published = i => ({ id: `a${i}`, sourceId: `p${i}`, title: `A${i}`, authors: ['Ada'] });
const showcaseEntry = (shareId, title, paperCount) => ({
  shareId, title, paperCount, publishedAt: new Date(NOW - 1000),
});

function mergeFixture(extra = {}) {
  return {
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' },
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['p1', 'p2'] },
    [`publicLists/${SHARE}`]: { title: 'V', paperCount: 2, papers: [published(1), published(2)] },
    ...extra,
  };
}

test('the merge write is pinned to the exact version it merged against', async () => {
  stubIdentity();
  const admin = fakeAdmin(mergeFixture(), {
    updateTimes: { [`publicLists/${SHARE}`]: '2026-08-21T00:00:00.000000Z' },
  });
  await run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'V', papers: [] }, { admin });
  assert.deepEqual(admin.commits[0][0].currentDocument, {
    updateTime: '2026-08-21T00:00:00.000000Z',
  }, 'unpinned, the other tab paper is skipped once and then skipped for ever');
});

test('the legacy whole-payload replace is not a read-modify-write, so it is not pinned', async () => {
  stubIdentity();
  // Nothing was read to build this payload, so there is no lost update to
  // guard — and pinning it would only invent conflicts.
  const admin = fakeAdmin({ [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'l1' } });
  await run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'T', papers: [] }, { admin });
  assert.deepEqual(admin.commits[0][0].currentDocument, { exists: true });
});

test('a lost race is re-merged from the fresh copy, not re-committed from the stale one', async () => {
  stubIdentity();
  const admin = racingAdmin({
    ...mergeFixture(),
    [`users/${UID}/lists/l1`]: { id: 'l1', paperIds: ['p1', 'p2', 'p3'] },
  }, {
    // The other tab published p3 while this one was merging.
    afterRace: {
      [`publicLists/${SHARE}`]: {
        title: 'V', paperCount: 3, papers: [published(1), published(2), published(3)],
      },
    },
  });
  const result = await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'V', papers: [],
  }, { admin });

  assert.deepEqual(result.papers.map(entry => entry.id), ['a1', 'a2', 'a3']);
  assert.equal(result.skipped, 0, 'p3 is in the list and in the fresh copy: nothing to skip');
  assert.equal(admin.commits.length, 1, 'the first attempt was refused, the second landed');
});

test('the retry rebuilds the showcase too, so a card added mid-flight survives', async () => {
  stubIdentity();
  const THIRD_SHARE = 'c'.repeat(32);
  const admin = racingAdmin(mergeFixture({
    [`profileLists/${UID}`]: {
      lists: [showcaseEntry(OTHER_SHARE, 'Otra', 2), showcaseEntry(SHARE, 'Vieja', 12)],
      updatedAt: new Date(NOW - 500),
    },
  }), {
    afterRace: {
      [`profileLists/${UID}`]: {
        lists: [
          showcaseEntry(OTHER_SHARE, 'Otra', 2),
          showcaseEntry(SHARE, 'Vieja', 12),
          showcaseEntry(THIRD_SHARE, 'Nueva', 1),
        ],
        updatedAt: new Date(NOW),
      },
    },
  });
  await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Renombrada', papers: [],
  }, { admin });

  const showcase = admin.commits[0].find(write => write.update?.name.endsWith(`profileLists/${UID}`));
  assert.deepEqual(fieldsOf(showcase).lists.map(entry => entry.shareId),
    [OTHER_SHARE, SHARE, THIRD_SHARE],
    'carrying the first attempt cards over would delete the one just published');
});

test('if the showcase drops the card mid-flight, the retry does not put it back', async () => {
  stubIdentity();
  const admin = racingAdmin(mergeFixture({
    [`profileLists/${UID}`]: {
      lists: [showcaseEntry(OTHER_SHARE, 'Otra', 2), showcaseEntry(SHARE, 'Vieja', 12)],
      updatedAt: new Date(NOW - 500),
    },
  }), {
    // The owner turned attribution off from another tab.
    afterRace: {
      [`profileLists/${UID}`]: {
        lists: [showcaseEntry(OTHER_SHARE, 'Otra', 2)],
        updatedAt: new Date(NOW),
      },
    },
  });
  await run('/lists/update', {
    shareId: SHARE, listId: 'l1', title: 'Renombrada', papers: [],
  }, { admin });
  assert.equal(admin.commits[0].length, 2, 'public doc + sync stamp, and no showcase write');
});

test('losing twice is the caller turn to retry, and it is told so', async () => {
  stubIdentity();
  const admin = fakeAdmin(mergeFixture(), { failOn: [1, 2] });
  await assert.rejects(
    () => run('/lists/update', { shareId: SHARE, listId: 'l1', title: 'V', papers: [] }, { admin }),
    error => error.code === 'PUBLISH_CONFLICT' && error.status === 409,
  );
  assert.equal(admin.commits.length, 0);
});
