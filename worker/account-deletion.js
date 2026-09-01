/**
 * Account deletion, orchestrated by the Worker.
 *
 * A client walk of the user's tree cannot finish: `publicLists` and
 * `publicListOwners` are closed to the browser, `rateLimits` refuse delete,
 * and a crash halfway leaves documents the owner can no longer touch once
 * Auth is gone. This route uses the service identity, does one bounded
 * stage per request, and is safe to retry: every write is a delete or a
 * dissociation of rows that still name this uid.
 *
 * Auth is last. Comments are dissociated, not deleted, matching the
 * privacy policy default.
 */

import { DISSOCIATED_COMMENT_FIELDS } from '../src/utils/commentIdentity.js';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.js';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  deleteWrite,
  FirestoreAdminError,
  isServiceAccountConfigured,
  mergeWrite,
} from './firestore-admin.js';
import { purgeEmailSubscription } from './email-notifications.js';
import { deleteCachedEntries } from './thread-anchor.js';

export const ACCOUNT_DELETE_PATH = '/account/delete';

export const ACCOUNT_DELETION_STAGES = Object.freeze([
  'comments',
  'publicLists',
  'followsOut',
  'followsIn',
  'profile',
  'userTree',
  'notifications',
  'auth',
]);

const USER_SUBCOLLECTIONS = Object.freeze([
  'lists',
  'highlights',
  'interactions',
  'following',
  'savedPapers',
  'settings',
  'profileStash',
  'aggregates',
  'rateLimits',
]);

const PAGE_SIZE = 80;
const MAX_WRITES = 240;
const IDENTITY_TOOLKIT_TIMEOUT_MS = 8000;

export class AccountDeletionError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'AccountDeletionError';
    this.code = code;
    this.status = status;
  }
}

function requireUid(value) {
  const uid = String(value || '').trim();
  if (!uid || uid.length > 128 || uid.includes('/') || uid === '.' || uid === '..') {
    throw new AccountDeletionError('INVALID_USER', 400);
  }
  return uid;
}

function kvBinding(env) {
  return env?.THREAD_ANCHOR_STORE || env?.NOTIFICATION_STORE || null;
}

function bearerToken(request) {
  return (request.headers.get('authorization') || '').match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
}

async function readConfirmBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 4096) throw new AccountDeletionError('PAYLOAD_TOO_LARGE', 413);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > 4096) throw new AccountDeletionError('PAYLOAD_TOO_LARGE', 413);
  const text = new TextDecoder().decode(buffer);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AccountDeletionError('INVALID_BODY', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
    throw new AccountDeletionError('CONFIRMATION_REQUIRED', 400);
  }
}

async function commitBestEffort(admin, writes) {
  if (!Array.isArray(writes) || writes.length === 0) return;
  try {
    await admin.commit(writes);
  } catch (error) {
    if (!(error instanceof FirestoreAdminError) || error.status !== 409) throw error;
    for (const write of writes) {
      try {
        await admin.commit([write]);
      } catch {
        // The document moved or vanished between the query and the write.
      }
    }
  }
}

function paperKeyFromCommentPath(path) {
  if (!Array.isArray(path) || path.length < 4) return '';
  if (path[0] !== 'papers' || path[2] !== 'comments') return '';
  return path[1];
}

async function dissociateComments(admin, uid, env) {
  const rows = await admin.runQuery({
    collectionId: 'comments',
    allDescendants: true,
    where: { field: 'authorUid', op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = [];
  const paperKeys = [];
  for (const row of rows) {
    if (!Array.isArray(row.path) || row.path.length < 4) continue;
    writes.push(mergeWrite(admin.name(row.path), { ...DISSOCIATED_COMMENT_FIELDS }));
    const paperKey = paperKeyFromCommentPath(row.path);
    if (paperKey) paperKeys.push(paperKey);
    if (writes.length >= MAX_WRITES) break;
  }
  await commitBestEffort(admin, writes);
  if (paperKeys.length > 0) {
    await deleteCachedEntries(kvBinding(env), [...new Set(paperKeys)]);
  }
  return rows.length >= PAGE_SIZE;
}

async function deleteOwnedPublicLists(admin, uid) {
  const rows = await admin.runQuery({
    collectionId: 'publicListOwners',
    where: { field: 'ownerId', op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = [];
  for (const row of rows) {
    const shareId = row.id;
    writes.push(deleteWrite(admin.name(['publicLists', shareId])));
    writes.push(deleteWrite(admin.name(['publicListOwners', shareId])));
    const listId = typeof row.data?.listId === 'string' ? row.data.listId : '';
    if (listId && !listId.includes('/') && listId !== '.' && listId !== '..') {
      writes.push(clearFieldsWrite(
        admin.name(['users', uid, 'lists', listId]),
        ['publicShareId', 'onProfile', 'publicSyncedAt'],
      ));
    }
    if (writes.length >= MAX_WRITES - 3) break;
  }
  await commitBestEffort(admin, writes);
  return rows.length >= PAGE_SIZE;
}

async function deleteFollows(admin, uid, field) {
  const rows = await admin.runQuery({
    collectionId: 'follows',
    where: { field, op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = rows.map(row => deleteWrite(admin.name(['follows', row.id])));
  await commitBestEffort(admin, writes);
  return rows.length >= PAGE_SIZE;
}

async function deleteProfile(admin, uid) {
  const [profile, search, showcase] = await Promise.all([
    admin.getDocument(['userProfiles', uid]),
    admin.getDocument(['userSearch', uid]),
    admin.getDocument(['profileLists', uid]),
  ]);
  const writes = [];
  if (search) writes.push(deleteWrite(admin.name(['userSearch', uid])));
  if (showcase) writes.push(deleteWrite(admin.name(['profileLists', uid])));
  const handle = typeof profile?.handle === 'string' ? profile.handle.trim() : '';
  if (handle && !handle.includes('/') && handle !== '.' && handle !== '..') {
    writes.push(deleteWrite(admin.name(['handles', handle])));
  }
  if (profile) writes.push(deleteWrite(admin.name(['userProfiles', uid])));
  await commitBestEffort(admin, writes);
  return false;
}

async function deleteUserTree(admin, uid) {
  for (const collectionId of USER_SUBCOLLECTIONS) {
    const rows = await admin.runQuery({
      parentSegments: ['users', uid],
      collectionId,
      limit: PAGE_SIZE,
    });
    if (rows.length === 0) continue;
    const writes = [];
    for (const row of rows) {
      if (collectionId === 'lists') {
        const shareId = typeof row.data?.publicShareId === 'string' ? row.data.publicShareId : '';
        if (/^[a-f0-9]{32}$/.test(shareId)) {
          writes.push(deleteWrite(admin.name(['publicLists', shareId])));
          writes.push(deleteWrite(admin.name(['publicListOwners', shareId])));
        }
      }
      writes.push(deleteWrite(admin.name(['users', uid, collectionId, row.id])));
      if (writes.length >= MAX_WRITES) break;
    }
    await commitBestEffort(admin, writes);
    return true;
  }
  const userDoc = await admin.getDocument(['users', uid]);
  if (userDoc) {
    await commitBestEffort(admin, [deleteWrite(admin.name(['users', uid]))]);
  }
  return false;
}

async function deleteAuthAccount(env, idToken, { fetchImpl = fetch } = {}) {
  const apiKey = String(env.FIREBASE_WEB_API_KEY || '').trim();
  if (!apiKey) throw new AccountDeletionError('AUTH_NOT_CONFIGURED', 503);
  if (!idToken) throw new WorkerAuthError('AUTH_REQUIRED', 401);
  let response;
  try {
    response = await fetchImpl(
      `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
        signal: AbortSignal.timeout(IDENTITY_TOOLKIT_TIMEOUT_MS),
      },
    );
  } catch {
    throw new AccountDeletionError('AUTH_DELETE_UNAVAILABLE', 503);
  }
  const payload = await response.json().catch(() => ({}));
  if (response.ok) return;
  const message = String(payload?.error?.message || '');
  if (message.includes('USER_NOT_FOUND')) return;
  if (message.includes('CREDENTIAL_TOO_OLD_LOGIN_AGAIN') || message.includes('TOKEN_EXPIRED')) {
    throw new AccountDeletionError('AUTH_RECENT_LOGIN_REQUIRED', 401);
  }
  throw new AccountDeletionError('AUTH_DELETE_FAILED', 502);
}

/**
 * One bounded slice. Returns `{ complete, stage }` so the browser can POST
 * again until `complete` is true without the Worker holding the request
 * across a large tree.
 */
export async function runAccountDeletionSlice(admin, uid, env, {
  idToken,
  fetchImpl = fetch,
} = {}) {
  if (await dissociateComments(admin, uid, env)) {
    return { complete: false, stage: 'comments' };
  }
  if (await deleteOwnedPublicLists(admin, uid)) {
    return { complete: false, stage: 'publicLists' };
  }
  if (await deleteFollows(admin, uid, 'followerUid')) {
    return { complete: false, stage: 'followsOut' };
  }
  if (await deleteFollows(admin, uid, 'targetUid')) {
    return { complete: false, stage: 'followsIn' };
  }
  if (await deleteProfile(admin, uid)) {
    return { complete: false, stage: 'profile' };
  }
  if (await deleteUserTree(admin, uid)) {
    return { complete: false, stage: 'userTree' };
  }
  await purgeEmailSubscription(env, uid);
  await deleteAuthAccount(env, idToken, { fetchImpl });
  return { complete: true, stage: 'auth' };
}

export async function handleAccountDeletionRequest(request, env, options = {}) {
  if (request.method !== 'POST') throw new AccountDeletionError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED', 503);
  }
  await readConfirmBody(request);
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const uid = requireUid(identity.uid);
  const admin = options.admin || createFirestoreAdmin(env);
  try {
    return await runAccountDeletionSlice(admin, uid, env, {
      idToken: bearerToken(request),
      fetchImpl: options.fetchImpl || fetch,
    });
  } catch (error) {
    if (error instanceof AccountDeletionError || error instanceof WorkerAuthError) throw error;
    if (error instanceof FirestoreAdminError) {
      throw new AccountDeletionError(
        error.status === 409 ? 'ACCOUNT_DELETION_CONFLICT' : 'ACCOUNT_DELETION_FAILED',
        error.status === 409 ? 409 : 502,
      );
    }
    throw error;
  }
}
