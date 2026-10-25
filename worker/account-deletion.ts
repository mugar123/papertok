import { isServiceAccountConfigured, FirebaseServiceAccountError } from './firebase-service-account.ts';
import type { WorkerEnv } from './env.ts';
import type { FirestoreAdmin, FirestoreWrite } from './firestore-admin.ts';

type DeletionAdmin = Pick<FirestoreAdmin, 'name' | 'runQuery' | 'getDocument'> & { commit(writes: FirestoreWrite[]): Promise<unknown> };
interface DeletionOptions { admin?: DeletionAdmin; fetchImpl?: typeof fetch; idToken?: string }


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
 * Auth is last. Comments and content reports from before comments were
 * removed are deleted: nothing shows them any more.
 */

import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.ts';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  deleteWrite,
  FirestoreAdminError,
} from './firestore-admin.ts';
import { purgeEmailSubscription } from './email-notifications.ts';

export const ACCOUNT_DELETE_PATH = '/account/delete';

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
  'summaries',
  'summaryHistory',
]);

const PAGE_SIZE = 80;
const MAX_WRITES = 240;
const IDENTITY_TOOLKIT_TIMEOUT_MS = 8000;

/**
 * Identity Toolkit refuses `accounts:delete` with CREDENTIAL_TOO_OLD_LOGIN_AGAIN
 * when the session's sign-in is not recent, and Auth is the last stage, so that
 * refusal would only arrive after the Firestore tree and the newsletter were
 * gone. So every request checks the sign-in age first and refuses past this
 * limit. Firebase does not document its window; it is commonly reported as five
 * minutes, so this stays a minute under it to leave room for clock skew and for
 * the request itself.
 */
const RECENT_SIGN_IN_SECONDS = 240;

export class AccountDeletionError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = 'AccountDeletionError';
    this.code = code;
    this.status = status;
  }
}

function requireUid(value: unknown) {
  const uid = String(value || '').trim();
  if (!uid || uid.length > 128 || uid.includes('/') || uid === '.' || uid === '..') {
    throw new AccountDeletionError('INVALID_USER', 400);
  }
  return uid;
}

function bearerToken(request: Request) {
  return (request.headers.get('authorization') || '').match(/^Bearer\s+([^\s]+)$/i)?.[1] || '';
}

async function readConfirmBody(request: Request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 4096) throw new AccountDeletionError('PAYLOAD_TOO_LARGE', 413);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > 4096) throw new AccountDeletionError('PAYLOAD_TOO_LARGE', 413);
  const text = new TextDecoder().decode(buffer);
  let body: { confirm?: unknown } | null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AccountDeletionError('INVALID_BODY', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true) {
    throw new AccountDeletionError('CONFIRMATION_REQUIRED', 400);
  }
}

async function commitBestEffort(admin: DeletionAdmin, writes: FirestoreWrite[]) {
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

async function deleteComments(admin: DeletionAdmin, uid: string) {
  const rows = await admin.runQuery({
    collectionId: 'comments',
    allDescendants: true,
    where: { field: 'authorUid', op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = [];
  for (const row of rows) {
    if (!Array.isArray(row.path) || row.path.length < 4) continue;
    writes.push(deleteWrite(admin.name(row.path)));
    if (writes.length >= MAX_WRITES) break;
  }
  await commitBestEffort(admin, writes);
  return rows.length >= PAGE_SIZE;
}

// A report names its author and the author of what it reported; both are this
// account's to remove now that no moderation reads them.
async function deleteReports(admin: DeletionAdmin, uid: string, field: string) {
  const rows = await admin.runQuery({
    collectionId: 'reports',
    where: { field, op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = rows.map(row => deleteWrite(admin.name(['reports', row.id])));
  await commitBestEffort(admin, writes);
  return rows.length >= PAGE_SIZE;
}

async function deleteOwnedPublicLists(admin: DeletionAdmin, uid: string) {
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

async function deleteFollows(admin: DeletionAdmin, uid: string, field: string) {
  const rows = await admin.runQuery({
    collectionId: 'follows',
    where: { field, op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  const writes = rows.map(row => deleteWrite(admin.name(['follows', row.id])));
  await commitBestEffort(admin, writes);
  return rows.length >= PAGE_SIZE;
}

/**
 * The paper stub itself stays: it is a shared document every other reader's
 * saves, comments and lists point at. Only the attribution goes.
 */
async function dissociatePapers(admin: DeletionAdmin, uid: string) {
  const rows = await admin.runQuery({
    collectionId: 'papers',
    where: { field: 'createdBy', op: 'EQUAL', value: uid },
    limit: PAGE_SIZE,
  });
  if (rows.length === 0) return false;
  await commitBestEffort(
    admin,
    rows.map(row => clearFieldsWrite(admin.name(['papers', row.id]), ['createdBy'])),
  );
  return rows.length >= PAGE_SIZE;
}

async function deleteProfile(admin: DeletionAdmin, uid: string) {
  const [profile, search, showcase] = await Promise.all([
    admin.getDocument(['userProfiles', uid]),
    admin.getDocument(['userSearch', uid]),
    admin.getDocument(['profileLists', uid]),
  ]);
  const writes = [];
  if (search) writes.push(deleteWrite(admin.name(['userSearch', uid])));
  if (showcase) writes.push(deleteWrite(admin.name(['profileLists', uid])));
  const handle = typeof profile?.handle === 'string' ? profile.handle.trim() : '';
  const reservation = handle && !handle.includes('/') && handle !== '.' && handle !== '..'
    ? await admin.getDocument(['handles', handle])
    : null;
  // A profile can name a handle it does not hold — nothing reconciles the two —
  // so the reservation is only ours to free when it names this uid back.
  if (reservation?.uid === uid) {
    writes.push(deleteWrite(admin.name(['handles', handle])));
  }
  if (profile) writes.push(deleteWrite(admin.name(['userProfiles', uid])));
  await commitBestEffort(admin, writes);
  return false;
}

async function deleteUserTree(admin: DeletionAdmin, uid: string) {
  for (const collectionId of USER_SUBCOLLECTIONS) {
    const rows = await admin.runQuery({
      parentSegments: ['users', uid],
      collectionId,
      limit: PAGE_SIZE,
      // A delete needs only the name, and a page of saved summaries read whole
      // is megabytes of text to parse; a list also needs its share pointer.
      select: collectionId === 'lists' ? ['publicShareId'] : ['__name__'],
    });
    if (rows.length === 0) continue;
    const writes = [];
    for (const row of rows) {
      if (collectionId === 'lists') {
        // The pointer catches a share published after the last publicLists
        // stage, which only the final sweep after the Auth delete can see (an
        // earlier slice reruns that stage). But the rules of 2026-08-13..20 let
        // a client write any share id into its own list. Like requireOwnedShare,
        // delete the share only when its owner record names this uid.
        const shareId = typeof row.data?.publicShareId === 'string' ? row.data.publicShareId : '';
        const owner = /^[a-f0-9]{32}$/.test(shareId)
          ? await admin.getDocument<{ ownerId?: unknown }>(['publicListOwners', shareId])
          : null;
        if (owner?.ownerId === uid) {
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

async function deleteAuthAccount(env: WorkerEnv, idToken: string | undefined, { fetchImpl = fetch } = {}) {
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
  const payload = await response.json<{ error?: { message?: unknown } }>().catch((): { error?: { message?: unknown } } => ({}));
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
export async function runAccountDeletionSlice(admin: DeletionAdmin, uid: string, env: WorkerEnv, {
  idToken,
  fetchImpl = fetch,
}: DeletionOptions = {}) {
  if (await deleteComments(admin, uid)) {
    return { complete: false, stage: 'comments' };
  }
  if (await deleteReports(admin, uid, 'reporterUid')) {
    return { complete: false, stage: 'reportsFiled' };
  }
  if (await deleteReports(admin, uid, 'targetAuthorUid')) {
    return { complete: false, stage: 'reportsReceived' };
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
  if (await dissociatePapers(admin, uid)) {
    return { complete: false, stage: 'papers' };
  }
  if (await deleteProfile(admin, uid)) {
    return { complete: false, stage: 'profile' };
  }
  if (await deleteUserTree(admin, uid)) {
    return { complete: false, stage: 'userTree' };
  }
  await purgeEmailSubscription(env, uid);
  await deleteAuthAccount(env, idToken, { fetchImpl });
  // The session stays valid until the line above returns, so anything the client
  // wrote after the sweep walked past it is an orphan nobody — not even its own
  // author, now that Auth is gone — can ever remove. Sweep once more.
  await deleteUserTree(admin, uid);
  return { complete: true, stage: 'auth' };
}

export async function handleAccountDeletionRequest(request: Request, env: WorkerEnv, options: DeletionOptions = {}) {
  if (request.method !== 'POST') throw new AccountDeletionError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new AccountDeletionError('ACCOUNT_DELETION_NOT_CONFIGURED', 503);
  }
  await readConfirmBody(request);
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const uid = requireUid(identity.uid);
  const { authTime } = identity;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)
    || Date.now() / 1000 - authTime > RECENT_SIGN_IN_SECONDS) {
    throw new AccountDeletionError('AUTH_RECENT_LOGIN_REQUIRED', 401);
  }
  const admin = options.admin || createFirestoreAdmin(env);
  try {
    return await runAccountDeletionSlice(admin, uid, env, {
      idToken: bearerToken(request),
      fetchImpl: options.fetchImpl || fetch,
    });
  } catch (error) {
    if (error instanceof AccountDeletionError || error instanceof WorkerAuthError) throw error;
    if (error instanceof FirestoreAdminError || error instanceof FirebaseServiceAccountError) {
      throw new AccountDeletionError(
        error.status === 409 ? 'ACCOUNT_DELETION_CONFLICT' : 'ACCOUNT_DELETION_FAILED',
        error.status === 409 ? 409 : 502,
      );
    }
    throw error;
  }
}
