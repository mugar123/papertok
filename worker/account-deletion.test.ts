import type { FirestoreData, FirestoreWrite, QueryOptions } from './firestore-admin.ts';
import type { TestGlobals } from './test-types.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fakeIdToken } from '../src/test-support/firebase-id-token.ts';
import {
  ACCOUNT_DELETE_PATH,
  AccountDeletionError,
  handleAccountDeletionRequest,
  runAccountDeletionSlice,
} from './account-deletion.ts';
import { handleEmailNotificationRequest } from './email-notifications.ts';
import { decodeFields, FirestoreAdminError } from './firestore-admin.ts';

const UID = 'alice-uid';
const PROJECT_ID = 'papertok-168df';
const nowSeconds = () => Math.floor(Date.now() / 1000);
const TOKEN = fakeIdToken({ aud: PROJECT_ID, auth_time: nowSeconds() });
const HANDLE = 'alice';
const SHARE = 'a'.repeat(32);
const PAPER_KEY = 'paperKey1';

const SERVICE = {
  FIREBASE_WEB_API_KEY: 'web-key',
  FIREBASE_PROJECT_ID: PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_EMAIL: 'worker@test.iam.gserviceaccount.com',
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
};

function pathFromName(name: string) {
  const marker = '/documents/';
  const index = String(name).indexOf(marker);
  return name.slice(index + marker.length);
}

function memoryAdmin<Documents extends Record<string, FirestoreData>>(seed: Documents = {} as Documents) {
  const documents: Record<string, FirestoreData> = { ...seed };
  const commits: FirestoreWrite[][] = [];
  return {
    documents: documents as Documents & Record<string, FirestoreData>,
    commits,
    projectId: PROJECT_ID,
    name: (segments: string[]) => `projects/${PROJECT_ID}/databases/(default)/documents/${segments.join('/')}`,
    async getDocument<T extends object = FirestoreData>(segments: string[]) {
      return (documents[segments.join('/')] ?? null) as T | null;
    },
    async runQuery<T extends object = FirestoreData>({
      parentSegments = [],
      collectionId,
      where: whereFilter,
      allDescendants = false,
      limit: pageSize = 80,
    }: QueryOptions = {}) {
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
      return rows.slice(0, pageSize) as Array<{ id: string; path: string[]; data: T }>;
    },
    async commit(writes: FirestoreWrite[]) {
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
        const patch = decodeFields(write.update!.fields);
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

function kvStore(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get: async (key: string, type?: string) => {
      const value = data.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
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

function deletionRequest(token = TOKEN) {
  return new Request(`https://worker.test${ACCOUNT_DELETE_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
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

test('deletes its comments and the reports naming it, then finishes the tree', async () => {
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
    'reports/r1': { reporterUid: UID, targetAuthorUid: 'other', reason: 'spam', note: 'mine' },
    'reports/r2': { reporterUid: 'other', targetAuthorUid: UID, reason: 'abuse' },
    'reports/r3': { reporterUid: 'other', targetAuthorUid: 'carol', reason: 'other' },
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
    [`users/${UID}/following/a1`]: { type: 'author' as const },
    [`users/${UID}/savedPapers/p1`]: { title: 'A paper' },
    [`users/${UID}/settings/followingUpdates`]: { seenIds: [] },
    [`users/${UID}/profileStash/pins`]: { pinnedLists: [] },
    [`users/${UID}/aggregates/interactions`]: { schemaVersion: 1 },
    [`users/${UID}/rateLimits/comments`]: { count: 1 },
    [`users/${UID}/summaries/key.university`]: { sections: [{ kind: 'intro', paragraphs: ['Plain words.'] }] },
    [`users/${UID}/summaryHistory/key.university`]: { title: 'A paper', level: 'university' },
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
  });
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };

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
    assert.ok(result);
    assert.equal(result.complete, true);
    assert.equal(result.stage, 'auth');
    assert.equal(admin.documents[`papers/${PAPER_KEY}/comments/c1`], undefined);
    assert.equal(admin.documents[`papers/${PAPER_KEY}/comments/c2`].authorUid, 'other');
    assert.equal(admin.documents['reports/r1'], undefined);
    assert.equal(admin.documents['reports/r2'], undefined);
    assert.equal(admin.documents['reports/r3'].reporterUid, 'other');
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
    assert.equal(admin.documents[`users/${UID}/summaries/key.university`], undefined);
    assert.equal(admin.documents[`users/${UID}/summaryHistory/key.university`], undefined);
    assert.equal(store.data.has(`notification:subscription:${UID}`), false);
    assert.equal(store.data.has('notification:unsubscribe:tok-1'), false);
  } finally {
    restore();
  }
});

test('a full comment page stops the slice so the next POST can continue', async () => {
  const comments: Record<string, FirestoreData> = {};
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
    Object.keys(admin.documents).filter(key => key.startsWith(`papers/${PAPER_KEY}/comments/`)).length,
    0,
  );
});

test('saved summaries are swept a page at a time, by name, without reading their text', async () => {
  const seed: Record<string, FirestoreData> = {};
  for (let i = 0; i < 81; i += 1) {
    seed[`users/${UID}/summaries/k${i}.university`] = { sections: [{ kind: 'intro', paragraphs: ['Plain words.'] }] };
  }
  const admin = memoryAdmin(seed);
  const asked: QueryOptions[] = [];
  const runQuery = admin.runQuery;
  admin.runQuery = (async (options: QueryOptions) => {
    asked.push(options);
    return runQuery(options);
  });

  const first = await runAccountDeletionSlice(admin, UID, {}, { idToken: 'x' });
  assert.deepEqual(first, { complete: false, stage: 'userTree' });
  assert.equal(Object.keys(admin.documents).filter(key => key.includes('/summaries/')).length, 1);
  assert.deepEqual(asked.find(options => options.collectionId === 'summaries')?.select, ['__name__']);
});

test('a profile pointing at somebody else\'s handle does not free that handle', async () => {
  // Nothing stops a profile from naming a handle it never held, so the
  // reservation is only ours to release when the reservation names us back.
  const admin = memoryAdmin({
    [`userProfiles/${UID}`]: { handle: HANDLE },
    [`handles/${HANDLE}`]: { uid: 'victim' },
  });

  const result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
    idToken: TOKEN,
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });

  assert.equal(result.complete, true);
  assert.deepEqual(admin.documents[`handles/${HANDLE}`], { uid: 'victim' });
  assert.equal(admin.documents[`userProfiles/${UID}`], undefined);
});

test('a list pointing at somebody else\'s share does not delete that share', async () => {
  // Rules from 2026-08-13 to 2026-08-20 let a client write any share id into its
  // own list, so the pointer alone does not prove whose share it is.
  const victimShare = 'b'.repeat(32);
  const admin = memoryAdmin({
    [`publicListOwners/${victimShare}`]: { ownerId: 'victim', listId: 'v-list' },
    [`publicLists/${victimShare}`]: { title: 'Victim reading list' },
    'users/victim/lists/v-list': { name: 'Victim reading list', publicShareId: victimShare },
    [`users/${UID}/lists/legacy`]: { name: 'Planted', publicShareId: victimShare },
  });

  let result;
  for (let i = 0; i < 12; i += 1) {
    result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
      idToken: TOKEN,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    if (result.complete) break;
  }

  assert.equal(result?.complete, true);
  assert.equal(admin.documents[`users/${UID}/lists/legacy`], undefined);
  assert.deepEqual(admin.documents[`publicLists/${victimShare}`], { title: 'Victim reading list' });
  assert.deepEqual(admin.documents[`publicListOwners/${victimShare}`], { ownerId: 'victim', listId: 'v-list' });
  assert.equal(admin.documents['users/victim/lists/v-list']?.publicShareId, victimShare);
});

test('a share published after the last publicLists stage is still deleted through its pointer', async () => {
  const lateShare = 'c'.repeat(32);
  const admin = memoryAdmin({
    [`users/${UID}/lists/early`]: { name: 'Early' },
  });

  let published = false;
  let result;
  for (let i = 0; i < 12; i += 1) {
    result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
      idToken: TOKEN,
      // The session stays valid until Auth is deleted, so a publish from another
      // tab lands after every slice has run its publicLists stage. Only the
      // private list's pointer, read by the final sweep, can find this share.
      fetchImpl: async () => {
        published = true;
        admin.documents[`publicListOwners/${lateShare}`] = { ownerId: UID, listId: 'late' };
        admin.documents[`publicLists/${lateShare}`] = { title: 'Late' };
        admin.documents[`users/${UID}/lists/late`] = { name: 'Late', publicShareId: lateShare };
        return new Response('{}', { status: 200 });
      },
    });
    if (result.complete) break;
  }

  assert.equal(published, true);
  assert.equal(result?.complete, true);
  assert.deepEqual(admin.documents, {});
});

test('a write that lands between the sweep and the Auth delete is swept too', async () => {
  const admin = memoryAdmin({
    [`userProfiles/${UID}`]: { handle: HANDLE },
    [`handles/${HANDLE}`]: { uid: UID },
    [`users/${UID}/highlights/h1`]: { quote: 'a finding' },
  });

  let result;
  for (let i = 0; i < 12; i += 1) {
    result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
      idToken: TOKEN,
      // The session is still valid until this call returns, so a client that is
      // mid-write lands a document the sweep has already walked past.
      fetchImpl: async () => {
        admin.documents[`users/${UID}/highlights/late`] = { quote: 'orphan' };
        return new Response('{}', { status: 200 });
      },
    });
    if (result.complete) break;
  }

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(admin.documents[`users/${UID}/highlights/late`], undefined);
});

test('a digest turned on while the Auth delete is in flight is purged too', async () => {
  // Identity Toolkit still knows the account until accounts:delete returns, so
  // the notification route accepts a settings save that lands after the purge.
  const restore = stubIdentityLookup();
  // An empty identity cache, so this test fails only when the purge is missing,
  // not when the notification write's cache rule changes (email-notifications.test.ts owns that).
  const originalCaches = (globalThis as TestGlobals).caches;
  (globalThis as TestGlobals).caches = { default: { match: async () => null, put: async () => undefined } };
  const store = kvStore();
  const env = {
    ...SERVICE,
    NOTIFICATION_STORE: store as typeof store & KVNamespace,
    RESEND_API_KEY: 're_test',
    RESEND_FROM_EMAIL: 'PaperTok <hello@papertok.app>',
    EMAIL_DELIVERY_LEDGER_FALLBACK: 'kv',
  };

  try {
    let saved = false;
    const result = await runAccountDeletionSlice(memoryAdmin(), UID, env, {
      idToken: TOKEN,
      fetchImpl: async () => {
        await handleEmailNotificationRequest(new Request('https://worker.test/notifications/preferences', {
          method: 'PUT',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            enabled: true,
            maxPapers: 5,
            follows: [{ type: 'author', canonicalId: 'A1', displayName: 'Ada', externalIds: {}, metadata: { categoryIds: [] } }],
            previewItems: [],
          }),
        }), env, '/notifications/preferences');
        saved = store.data.has(`notification:subscription:${UID}`);
        return new Response('{}', { status: 200 });
      },
    });

    assert.equal(saved, true);
    assert.equal(result.complete, true);
    assert.equal(store.data.has(`notification:subscription:${UID}`), false);
  } finally {
    if (originalCaches === undefined) delete (globalThis as TestGlobals).caches;
    else (globalThis as TestGlobals).caches = originalCaches;
    restore();
  }
});

// Only the deletion's own log lines are kept. Node 22 prints the experimental
// MockTimers warning through console.error too, and that line still reaches
// the real console.
function captureErrors() {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.startsWith('Account deletion:')) lines.push(line);
    else original(...args);
  };
  return { lines, restore: () => { console.error = original; } };
}

// The purge after the Auth delete waits a second before its retry. Timers are
// mocked, so this ticks that second instead of sleeping through it.
async function settleTickingTimers<T>(t: TestContext, run: Promise<T>) {
  let settled = false;
  const tracked = run.finally(() => { settled = true; });
  while (!settled) {
    await new Promise(resolve => { setImmediate(resolve); });
    t.mock.timers.tick(1000);
  }
  return tracked;
}

test('a purge that fails after the Auth delete still lets the final sweep run, and the deletion completes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const admin = memoryAdmin({ [`users/${UID}/lists/early`]: { name: 'Early' } });
  const store = kvStore();
  let authDeleted = false;
  let readsAfterAuth = 0;
  const get = store.get;
  store.get = async (key: string, type?: string) => {
    if (authDeleted) {
      readsAfterAuth += 1;
      throw new Error('KV GET failed: 503');
    }
    return get(key, type);
  };
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };
  const errors = captureErrors();

  try {
    const result = await settleTickingTimers(t, (async () => {
      let slice;
      for (let i = 0; i < 12; i += 1) {
        slice = await runAccountDeletionSlice(admin, UID, env, {
          idToken: TOKEN,
          fetchImpl: async () => {
            admin.documents[`users/${UID}/lists/late`] = { name: 'Late' };
            authDeleted = true;
            return new Response('{}', { status: 200 });
          },
        });
        if (slice.complete) break;
      }
      return slice;
    })());

    assert.deepEqual(result, { complete: true, stage: 'auth' });
    assert.equal(admin.documents[`users/${UID}/lists/late`], undefined);
    assert.equal(readsAfterAuth, 2, 'one retry, then the failure is logged');
    assert.equal(errors.lines.length, 1);
    assert.match(errors.lines[0], /subscription purge/);
    assert.doesNotMatch(errors.lines[0], new RegExp(UID));
  } finally {
    errors.restore();
  }
});

test('a purge that KV refuses just after the Auth delete is retried once the second has passed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = kvStore();
  let authDeleted = false;
  let refusals = 0;
  const remove = store.delete;
  store.delete = async (key: string) => {
    // Workers KV refuses a second write to one key within a second.
    if (authDeleted && refusals === 0 && key === `notification:subscription:${UID}`) {
      refusals += 1;
      throw new Error('KV DELETE failed: 429 Too Many Requests');
    }
    return remove(key);
  };
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };
  const errors = captureErrors();
  const restore = stubIdentityLookup();

  try {
    let settled = false;
    const deletion = handleAccountDeletionRequest(deletionRequest(), env, {
      admin: memoryAdmin(),
      fetchImpl: async () => {
        // A digest saved from another tab while the Auth delete is in flight.
        store.data.set(`notification:subscription:${UID}`, JSON.stringify({ uid: UID, unsubscribeToken: 'tok-2' }));
        store.data.set('notification:unsubscribe:tok-2', UID);
        authDeleted = true;
        return new Response('{}', { status: 200 });
      },
    }).finally(() => { settled = true; });
    while (refusals === 0 && !settled) await new Promise(resolve => { setImmediate(resolve); });
    await new Promise(resolve => { setImmediate(resolve); });

    assert.equal(refusals, 1);
    assert.equal(settled, false, 'the retry waits for the second to pass');
    assert.equal(store.data.has(`notification:subscription:${UID}`), true);
    t.mock.timers.tick(1000);
    assert.deepEqual(await deletion, { complete: true, stage: 'auth' });
    assert.equal(store.data.size, 0);
    assert.deepEqual(errors.lines, []);
  } finally {
    restore();
    errors.restore();
  }
});

test('an unsubscribe index KV refuses after the Auth delete is still removed by the retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = kvStore();
  let authDeleted = false;
  let refusals = 0;
  const remove = store.delete;
  store.delete = async (key: string) => {
    if (authDeleted && refusals === 0 && key === 'notification:unsubscribe:tok-2') {
      refusals += 1;
      throw new Error('KV DELETE failed: 429 Too Many Requests');
    }
    return remove(key);
  };
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };
  const errors = captureErrors();
  const restore = stubIdentityLookup();

  try {
    let settled = false;
    const deletion = handleAccountDeletionRequest(deletionRequest(), env, {
      admin: memoryAdmin(),
      fetchImpl: async () => {
        store.data.set(`notification:subscription:${UID}`, JSON.stringify({ uid: UID, unsubscribeToken: 'tok-2' }));
        store.data.set('notification:unsubscribe:tok-2', UID);
        authDeleted = true;
        return new Response('{}', { status: 200 });
      },
    }).finally(() => { settled = true; });
    while (refusals === 0 && !settled) await new Promise(resolve => { setImmediate(resolve); });
    await new Promise(resolve => { setImmediate(resolve); });
    t.mock.timers.tick(1000);

    assert.deepEqual(await deletion, { complete: true, stage: 'auth' });
    assert.equal(refusals, 1);
    assert.equal(store.data.size, 0);
    assert.deepEqual(errors.lines, []);
  } finally {
    restore();
    errors.restore();
  }
});

test('a final sweep that fails after the Auth delete still purges the subscription, and the deletion completes', async () => {
  const admin = memoryAdmin();
  let authDeleted = false;
  const runQuery = admin.runQuery;
  admin.runQuery = (async (options: QueryOptions) => {
    if (authDeleted) throw new FirestoreAdminError('FIRESTORE_UNAVAILABLE', 503, `users/${UID}`);
    return runQuery(options);
  });
  const store = kvStore();
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };
  const errors = captureErrors();

  try {
    const restore = stubIdentityLookup();
    let result;
    try {
      result = await handleAccountDeletionRequest(deletionRequest(), env, {
        admin,
        fetchImpl: async () => {
          // A digest saved from another tab while the Auth delete is in flight.
          store.data.set(`notification:subscription:${UID}`, JSON.stringify({ uid: UID, unsubscribeToken: 'tok-2' }));
          store.data.set('notification:unsubscribe:tok-2', UID);
          authDeleted = true;
          return new Response('{}', { status: 200 });
        },
      });
    } finally {
      restore();
    }

    assert.deepEqual(result, { complete: true, stage: 'auth' });
    assert.equal(store.data.size, 0);
    assert.equal(errors.lines.length, 1);
    assert.match(errors.lines[0], /user tree sweep.*FIRESTORE_UNAVAILABLE/);
    assert.doesNotMatch(errors.lines[0], new RegExp(UID));
  } finally {
    errors.restore();
  }
});

test('paper stubs lose their createdBy attribution', async () => {
  const admin = memoryAdmin({
    [`userProfiles/${UID}`]: { handle: HANDLE },
    'papers/p1': { createdBy: UID, title: 'T' },
    'papers/p2': { createdBy: 'other', title: 'U' },
  });

  let result;
  for (let i = 0; i < 12; i += 1) {
    result = await runAccountDeletionSlice(admin, UID, { ...SERVICE }, {
      idToken: TOKEN,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    if (result.complete) break;
  }

  assert.ok(result);
  assert.equal(result.complete, true);
  // The stub is shared: everybody else's saves point at it. Only the name goes.
  assert.equal(admin.documents['papers/p1'].createdBy, undefined);
  assert.equal(admin.documents['papers/p1'].title, 'T');
  assert.equal(admin.documents['papers/p2'].createdBy, 'other');
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

test('a sign-in that is not recent is refused before anything is deleted', async () => {
  const restore = stubIdentityLookup();
  const seed: Record<string, FirestoreData> = {
    [`papers/${PAPER_KEY}/comments/c1`]: { authorUid: UID, text: 'mine' },
    [`publicListOwners/${SHARE}`]: { ownerId: UID, listId: 'list-1' },
    [`publicLists/${SHARE}`]: { title: 'Reading' },
    [`userProfiles/${UID}`]: { handle: HANDLE },
    [`handles/${HANDLE}`]: { uid: UID },
    [`users/${UID}/lists/list-1`]: { name: 'Reading', publicShareId: SHARE },
    [`users/${UID}`]: { onboardingComplete: true },
  };
  const admin = memoryAdmin(structuredClone(seed));
  const subscription = JSON.stringify({ uid: UID, unsubscribeToken: 'tok-1', enabled: true });
  const store = kvStore({
    [`notification:subscription:${UID}`]: subscription,
    'notification:unsubscribe:tok-1': UID,
  });
  const authCalls: string[] = [];
  const env = { ...SERVICE, NOTIFICATION_STORE: store as typeof store & KVNamespace };

  try {
    for (const [why, token] of Object.entries({
      'signed in ten minutes ago': fakeIdToken({ aud: PROJECT_ID, auth_time: nowSeconds() - 600 }),
      'signed in five minutes ago': fakeIdToken({ aud: PROJECT_ID, auth_time: nowSeconds() - 300 }),
      'no sign-in time at all': fakeIdToken({ aud: PROJECT_ID }),
    })) {
      await assert.rejects(
        () => handleAccountDeletionRequest(deletionRequest(token), env, {
          admin,
          fetchImpl: async (url) => {
            authCalls.push(String(url));
            return new Response('{}', { status: 200 });
          },
        }),
        error => error instanceof AccountDeletionError
          && error.code === 'AUTH_RECENT_LOGIN_REQUIRED'
          && error.status === 401,
        `must refuse a token ${why}`,
      );
    }
    assert.deepEqual(admin.documents, seed, 'every document is still there');
    assert.deepEqual(admin.commits, [], 'nothing was written');
    assert.equal(store.data.get(`notification:subscription:${UID}`), subscription);
    assert.equal(store.data.get('notification:unsubscribe:tok-1'), UID);
    assert.equal(authCalls.length, 0, 'Auth was not asked to delete anything');

    // The same tree, after the user has just signed in again.
    const freshToken = fakeIdToken({ aud: PROJECT_ID, auth_time: nowSeconds() - 5 });
    let result: Awaited<ReturnType<typeof handleAccountDeletionRequest>> | undefined;
    for (let i = 0; i < 12; i += 1) {
      result = await handleAccountDeletionRequest(deletionRequest(freshToken), env, {
        admin,
        fetchImpl: async (url) => {
          authCalls.push(String(url));
          return new Response('{}', { status: 200 });
        },
      });
      if (result.complete) break;
    }
    assert.equal(result?.complete, true);
    assert.deepEqual(admin.documents, {}, 'the whole tree is gone');
    assert.equal(store.data.size, 0, 'the newsletter subscription is gone');
    assert.equal(authCalls.length, 1);
    assert.match(authCalls[0], /accounts:delete/);
  } finally {
    restore();
  }
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
    error => (error as Error & { code?: string; status?: number }).code === 'AUTH_RECENT_LOGIN_REQUIRED' && (error as Error & { code?: string; status?: number }).status === 401,
  );
});
