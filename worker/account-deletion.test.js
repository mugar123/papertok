import test from 'node:test';
import assert from 'node:assert/strict';
import { DISSOCIATED_COMMENT_FIELDS } from '../src/utils/commentIdentity.js';
import { fakeIdToken } from '../src/test-support/firebaseIdToken.js';
import {
  ACCOUNT_DELETE_PATH,
  AccountDeletionError,
  handleAccountDeletionRequest,
  runAccountDeletionSlice,
} from './account-deletion.js';
import { decodeFields, FirestoreAdminError } from './firestore-admin.js';

const UID = 'alice-uid';
const PROJECT_ID = 'papertok-168df';
const TOKEN = fakeIdToken({ aud: PROJECT_ID });
const HANDLE = 'alice';
const SHARE = 'a'.repeat(32);
const PAPER_KEY = 'paperKey1';

const SERVICE = {
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
};

function pathFromName(name) {
  const marker = '/documents/';
  const index = String(name).indexOf(marker);
  return name.slice(index + marker.length);
}

function memoryAdmin(seed = {}) {
  const documents = { ...seed };
  const commits = [];
  return {
    documents,
    commits,
    projectId: PROJECT_ID,
    name: segments => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async getDocument(segments) {
      return documents[segments.join('/')] ?? null;
    },
    async runQuery({
      parentSegments = [],
      collectionId,
      where: whereFilter,
      allDescendants = false,
      limit: pageSize = 80,
    } = {}) {
      const rows = [];
      for (const [key, data] of Object.entries(documents)) {
        const path = key.split('/');
        if (allDescendants) {
          if (path.length < 2 || path[path.length - 2] !== collectionId) continue;
        } else if (parentSegments.length > 0) {
          const prefix = `${parentSegments.join('/')}/${collectionId}/`;
          if (!key.startsWith(prefix)) continue;
          if (key.slice(prefix.length).includes('/')) continue;
        } else if (path[0] !== collectionId || path.length !== 2) {
          continue;
        }
        if (whereFilter?.field && data?.[whereFilter.field] !== whereFilter.value) continue;
        rows.push({ id: path[path.length - 1], data, path });
      }
      return rows.slice(0, pageSize);
    },
    async commit(writes) {
      commits.push(writes);
      for (const write of writes) {
        if (write.delete) {
          delete documents[pathFromName(write.delete)];
          continue;
        }
        const name = write.update?.name;
        if (!name) continue;
        const key = pathFromName(name);
        if (write.currentDocument?.exists === true && documents[key] == null) {
          throw new FirestoreAdminError('FIRESTORE_PRECONDITION_FAILED', 409, 'NOT_FOUND');
        }
        const patch = decodeFields(write.update.fields);
        if (write.updateMask) {
          const next = { ...(documents[key] || {}) };
          for (const field of write.updateMask.fieldPaths) {
            if (field in patch) next[field] = patch[field];
            else delete next[field];
          }
          documents[key] = next;
        } else {
          documents[key] = patch;
        }
      }
    },
  };
}

function kvStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: async (key, type) => {
      const value = data.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key, value) => { data.set(key, value); },
    delete: async (key) => { data.delete(key); },
  };
}

function stubIdentityLookup() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('accounts:lookup')) {
      return new Response(JSON.stringify({
        users: [{ localId: UID, email: 'alice@example.com', emailVerified: true }],
      }), { status: 200 });
    }
    if (String(url).includes('accounts:delete')) {
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch ${url} ${init?.method}`);
  };
  return () => { globalThis.fetch = original; };
}

function deletionRequest() {
  return new Request(`https://worker.test${ACCOUNT_DELETE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ confirm: true }),
  });
}

test('refuses a body that does not confirm', async () => {
  const restore = stubIdentityLookup();
  try {
    await assert.rejects(
      () => handleAccountDeletionRequest(
        new Request(`https://worker.test${ACCOUNT_DELETE_PATH}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: false }),
        }),
        SERVICE,
        { admin: memoryAdmin() },
      ),
      error => error instanceof AccountDeletionError && error.code === 'CONFIRMATION_REQUIRED',
    );
  } finally {
    restore();
  }
});

test('dissociates comments instead of deleting them, then finishes the tree', async () => {
  const restore = stubIdentityLookup();
  const admin = memoryAdmin({
    [`papers/${PAPER_KEY}/comments/c1`]: {
      authorUid: UID,
      authorHandle: HANDLE,
      text: 'Keep the thread',
      status: 'visible',
    },
    [`papers/${PAPER_KEY}/comments/c2`]: {
      authorUid: 'other',
      authorHandle: 'bob',
      text: 'Someone else',
      status: 'visible',
    },
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'list-1' },
    [`publicLists/${SHARE}`]: { title: 'Reading' },
    [`users/${UID}/lists/list-1`]: { name: 'Reading', publicShareId: SHARE },
    [`follows/${UID}_other`]: { followerUid: UID, targetUid: 'other' },
    [`follows/other_${UID}`]: { followerUid: 'other', targetUid: UID },
    [`userProfiles/${UID}`]: { handle: HANDLE, displayName: 'Alice' },
    [`handles/${HANDLE}`]: { uid: UID },
    [`userSearch/${UID}`]: { handle: HANDLE, nameLower: 'alice' },
    [`profileLists/${UID}`]: { lists: [{ shareId: SHARE }] },
    [`users/${UID}/highlights/h1`]: { quote: 'a finding' },
    [`users/${UID}/interactions/p1`]: { liked: true },
    [`users/${UID}/following/a1`]: { type: 'author' },
    [`users/${UID}/savedPapers/p1`]: { title: 'A paper' },
    [`users/${UID}/settings/followingUpdates`]: { seenIds: [] },
    [`users/${UID}/profileStash/pins`]: { pinnedLists: [] },
    [`users/${UID}/aggregates/interactions`]: { schemaVersion: 1 },
    [`users/${UID}/rateLimits/comments`]: { count: 1 },
    [`users/${UID}`]: { onboardingComplete: true },
  });
  const store = kvStore({
    [`notification:subscription:${UID}`]: JSON.stringify({
      uid: UID,
      unsubscribeToken: 'tok-1',
      enabled: true,
    }),
    'notification:unsubscribe:tok-1': UID,
    [`notification:delivery-state:${UID}`]: JSON.stringify({ lastSentAt: 1 }),
    [`thread:v1:${PAPER_KEY}`]: JSON.stringify({ key: PAPER_KEY, comments: [] }),
  });
  const env = { ...SERVICE, NOTIFICATION_STORE: store };

  try {
    let result;
    for (let i = 0; i < 12; i += 1) {
      result = await handleAccountDeletionRequest(deletionRequest(), env, {
        admin,
        fetchImpl: async (url) => {
          assert.match(String(url), /accounts:delete/);
          return new Response('{}', { status: 200 });
        },
      });
      if (result.complete) break;
    }
    assert.equal(result.complete, true);
    assert.equal(result.stage, 'auth');
    assert.deepEqual(admin.documents[`papers/${PAPER_KEY}/comments/c1`], {
      authorUid: '',
      authorHandle: '',
      dissociated: true,
      text: 'Keep the thread',
      status: 'visible',
    });
    assert.equal(admin.documents[`papers/${PAPER_KEY}/comments/c2`].authorUid, 'other');
    assert.equal(admin.documents[`publicLists/${SHARE}`], undefined);
    assert.equal(admin.documents[`publicListOwners/${SHARE}`], undefined);
    assert.equal(admin.documents[`handles/${HANDLE}`], undefined);
    assert.equal(admin.documents[`userProfiles/${UID}`], undefined);
    assert.equal(admin.documents[`userSearch/${UID}`], undefined);
    assert.equal(admin.documents[`profileLists/${UID}`], undefined);
    assert.equal(admin.documents[`follows/${UID}_other`], undefined);
    assert.equal(admin.documents[`follows/other_${UID}`], undefined);
    assert.equal(admin.documents[`users/${UID}`], undefined);
    assert.equal(admin.documents[`users/${UID}/lists/list-1`], undefined);
    assert.equal(admin.documents[`users/${UID}/rateLimits/comments`], undefined);
    assert.equal(store.data.has(`notification:subscription:${UID}`), false);
    assert.equal(store.data.has('notification:unsubscribe:tok-1'), false);
    assert.equal(store.data.has(`thread:v1:${PAPER_KEY}`), false);
  } finally {
    restore();
  }
});

test('a full comment page stops the slice so the next POST can continue', async () => {
  const comments = {};
  for (let i = 0; i < 80; i += 1) {
    comments[`papers/${PAPER_KEY}/comments/c${i}`] = {
      authorUid: UID,
      authorHandle: HANDLE,
      text: `n${i}`,
    };
  }
  comments[`userProfiles/${UID}`] = { handle: HANDLE };
  const admin = memoryAdmin(comments);
  const first = await runAccountDeletionSlice(admin, UID, {}, { idToken: 'x' });
  assert.equal(first.complete, false);
  assert.equal(first.stage, 'comments');
  assert.equal(
    Object.values(admin.documents).filter(row => row?.dissociated === true).length,
    80,
  );
});

test('USER_NOT_FOUND on Auth delete still completes, so a retry after Auth is gone is safe', async () => {
  const admin = memoryAdmin();
  const result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
    idToken: TOKEN,
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { message: 'USER_NOT_FOUND' } }),
      { status: 400 },
    ),
  });
  assert.equal(result.complete, true);
});

test('a stale session asks the user to sign in again instead of deleting Auth later', async () => {
  const admin = memoryAdmin();
  await assert.rejects(
    () => runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
      idToken: TOKEN,
      fetchImpl: async () => new Response(
        JSON.stringify({ error: { message: 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN' } }),
        { status: 400 },
      ),
    }),
    error => error.code === 'AUTH_RECENT_LOGIN_REQUIRED' && error.status === 401,
  );
});

test('the dissociation contract is the empty author plus an explicit flag', () => {
  assert.equal(DISSOCIATED_COMMENT_FIELDS.authorUid, '');
  assert.equal(DISSOCIATED_COMMENT_FIELDS.authorHandle, '');
  assert.equal(DISSOCIATED_COMMENT_FIELDS.dissociated, true);
});
