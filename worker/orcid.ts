/**
 * Connects a reader's ORCID iD to their PaperTok account.
 *
 * ORCID's sign-in (OAuth 2 with the `/authenticate` scope) proves that the
 * person holds the iD. As with Zotero (worker/zotero.ts), the exchange is
 * split across two signed-in requests so the account that started it is the
 * one that finishes it: `/orcid/connect` makes a random `state`, keeps only
 * its SHA-256 hash and the time in `users/{uid}/orcid/link`, and returns
 * ORCID's authorize address; ORCID returns the browser to the frontend's
 * `/orcid/callback`; and `/orcid/complete` exchanges the code only when its
 * state is the one this account asked for in the last 15 minutes. A callback
 * served by the Worker itself could not tell whose browser arrived.
 *
 * ORCID answers the exchange with the iD and the record's public name beside
 * an access token. Only the iD, the name and the registry are kept, on
 * `users/{uid}.orcid`, a field the Firestore rules freeze for the client; the
 * token is never stored. The Firestore rules close `users/{uid}/orcid` to
 * every client except `works`, where the account keeps its own decisions
 * about the works OpenAlex attributes to the iD
 * (src/services/orcid-work-decisions-service.ts). Those belong to the iD they
 * were made for, so connecting and disconnecting both delete them.
 */

import type { WorkerEnv } from './env.ts';
import type { FirestoreWrite } from './firestore-admin.ts';
import type { QuotaRequest } from './request-quota-ledger.ts';
import type { OrcidHost } from '../src/utils/orcid-id.ts';
import { sha256 } from './ai-explanation.ts';
import { readBoundedJson } from './bounded-body.ts';
import { verifyFirebaseIdentity } from './firebase-auth.ts';
import { FirebaseServiceAccountError, isServiceAccountConfigured } from './firebase-service-account.ts';
import { clearFieldsWrite, createFirestoreAdmin, deleteWrite, encodeFields, FirestoreAdminError, mergeWrite } from './firestore-admin.ts';
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.ts';
import { isValidOrcidId } from '../src/utils/orcid-id.ts';

export const ORCID_PATHS = new Set(['/orcid/connect', '/orcid/complete', '/orcid/disconnect']);

/** `ORCID_ENVIRONMENT` in wrangler.toml picks the registry; unset is production. */
const ORCID_REGISTRIES: Record<string, OrcidHost> = { production: 'orcid.org', sandbox: 'sandbox.orcid.org' };
const PENDING_LIFETIME_MS = 15 * 60 * 1000;
const BODY_LIMIT_BYTES = 4096;
const FIELD_LIMIT = 512;
const REQUEST_TIMEOUT_MS = 8000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ACCOUNT_ROUTE_HOURLY_LIMIT = 6;
// Firestore's Spark write allowance is shared with the rest of the app.
const GLOBAL_DAILY_WRITE_LIMIT = 1500;
const GENERAL_DAILY_WRITE_LIMIT = 1200;
const GLOBAL_DAILY_COMPLETION_LIMIT = 2400;

export class OrcidError extends Error {
  declare code: string;
  declare status: number;
  declare retryAfter?: string;
  constructor(code: string, status = 502, retryAfter?: string) {
    super(code);
    this.name = 'OrcidError';
    this.code = code;
    this.status = status;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

interface Admin {
  name(segments: string[]): string;
  getDocument<T extends object>(segments: string[], options: { withMeta: true }): Promise<{ data: T; updateTime?: string } | null>;
  commit(writes: FirestoreWrite[]): Promise<unknown>;
}
interface OrcidOptions { admin?: Admin; now?: () => number }
interface LinkDocument { stateHash?: string; createdAt?: number }
interface OrcidConnection { id: string; name: string | null; host: OrcidHost; connectedAt: string }

async function reserveOrcidQuota(env: WorkerEnv, uid: string, route: string, now: number, {
  budget, globalLimit, globalAmount,
}: { budget: 'writes' | 'attempts'; globalLimit: number; globalAmount: number }) {
  const hour = Math.floor(now / HOUR_MS);
  const day = Math.floor(now / DAY_MS);
  const quota: QuotaRequest = {
    periodKey: `orcid-${budget}:${day}`,
    subject: `${hour}:${route}:${uid}`,
    subjectLimit: ACCOUNT_ROUTE_HOURLY_LIMIT,
    globalLimit,
    globalAmount,
    expiresAt: (day + 1) * DAY_MS + HOUR_MS,
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, quota).catch(() => {
    throw new OrcidError('ORCID_FAILED', 503);
  });
  if (reservation.accepted) return quota;
  if (reservation.scope === 'user' || reservation.scope === 'global') {
    const dailyLimitReached = reservation.scope === 'global'
      || (globalAmount > 0 && (reservation.globalUsage ?? 0) + globalAmount > globalLimit);
    const resetAt = dailyLimitReached ? (day + 1) * DAY_MS : (hour + 1) * HOUR_MS;
    throw new OrcidError('ORCID_WRITE_LIMIT', 429, String(Math.ceil((resetAt - now) / 1000)));
  }
  throw new OrcidError('ORCID_FAILED', 503);
}

async function releaseOrcidWrites(env: WorkerEnv, quota: QuotaRequest) {
  try {
    const result = await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, quota);
    if (result.released) return;
  } catch {
    // Preserve the original ORCID error if the ledger cannot return the units.
  }
  console.warn('Could not return the ORCID write reservation');
}

async function commitFirstOrcidWrites(admin: Admin, writes: FirestoreWrite[], env: WorkerEnv, quota: QuotaRequest) {
  try {
    await admin.commit(writes);
  } catch (error) {
    // A lost response may hide a successful commit.
    const refused = error instanceof FirestoreAdminError && (error.status === 409
      || (error.code === 'FIRESTORE_WRITE_FAILED'
        && ['PERMISSION_DENIED', 'UNAUTHENTICATED', 'INVALID_ARGUMENT', 'RESOURCE_EXHAUSTED'].includes(error.detail)));
    if (refused || error instanceof FirebaseServiceAccountError) {
      await releaseOrcidWrites(env, quota);
    }
    throw error;
  }
}

export function configuredOrcidHost(env: WorkerEnv) {
  const environment = env.ORCID_ENVIRONMENT || 'production';
  const host = Object.hasOwn(ORCID_REGISTRIES, environment) ? ORCID_REGISTRIES[environment] : null;
  if (!host || !env.ORCID_CLIENT_ID || !env.ORCID_CLIENT_SECRET || !isServiceAccountConfigured(env)) return null;
  return host;
}

function linkSegments(uid: string) {
  return ['users', uid, 'orcid', 'link'];
}

function decisionsSegments(uid: string) {
  return ['users', uid, 'orcid', 'works'];
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readBody(request: Request) {
  const body = await readBoundedJson<Record<string, unknown>>(request, BODY_LIMIT_BYTES, {
    tooLarge: () => new OrcidError('BODY_TOO_LARGE', 413),
    invalid: () => new OrcidError('INVALID_BODY', 400),
  });
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OrcidError('INVALID_BODY', 400);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const state = typeof body.state === 'string' ? body.state : '';
  if (!code || code.length > FIELD_LIMIT || !state || state.length > FIELD_LIMIT) throw new OrcidError('INVALID_BODY', 400);
  return { code, state };
}

/**
 * Trades the code for ORCID's answer and keeps only the iD and the name. A
 * refusal of PaperTok's own credentials means the client is not set up; any
 * other refusal (a code already used, expired or issued for another address)
 * means this connection has to start again.
 */
async function exchangeCode(env: WorkerEnv, host: OrcidHost, code: string, redirectUri: string) {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`https://${host}/oauth/token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: String(env.ORCID_CLIENT_ID),
        client_secret: String(env.ORCID_CLIENT_SECRET),
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // Read inside the deadline too: a body that stalls is an unavailable ORCID.
    text = await response.text();
  } catch {
    throw new OrcidError('ORCID_UNAVAILABLE', 502);
  }
  if (response.status === 429) throw new OrcidError('ORCID_RATE_LIMITED', 429, response.headers.get('retry-after') || '60');
  let payload: { orcid?: unknown; name?: unknown; error?: unknown } | null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  if (response.status === 400 || response.status === 401) {
    const error = typeof payload?.error === 'string' ? payload.error : '';
    console.warn('ORCID refused the code exchange', { status: response.status, error });
    throw error === 'invalid_client' || error === 'unauthorized_client'
      ? new OrcidError('ORCID_NOT_CONFIGURED', 503)
      : new OrcidError('ORCID_CONNECTION_EXPIRED', 400);
  }
  if (!response.ok || !payload || !isValidOrcidId(payload.orcid)) throw new OrcidError('ORCID_UNAVAILABLE', 502);
  const name = typeof payload.name === 'string' ? payload.name.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return { id: payload.orcid, name: name || null };
}

export async function handleOrcidRequest(request: Request, env: WorkerEnv, origin: string, options: OrcidOptions = {}) {
  const pathname = new URL(request.url).pathname;
  if (request.method !== 'POST') throw new OrcidError('METHOD_NOT_ALLOWED', 405);
  const host = configuredOrcidHost(env);
  if (!host) {
    throw new OrcidError('ORCID_NOT_CONFIGURED', 503);
  }
  // Every route writes, so no identity cache: a token revoked a moment ago must not connect.
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const admin: Admin = options.admin || createFirestoreAdmin(env);
  const now = options.now?.() ?? Date.now();
  const link = admin.name(linkSegments(identity.uid));
  const decisions = admin.name(decisionsSegments(identity.uid));
  const userDocument = admin.name(['users', identity.uid]);
  // ORCID sends the code only to an address registered for PaperTok's client, and the exchange must name the same one.
  const redirectUri = `${origin}/orcid/callback`;

  if (pathname === '/orcid/connect') {
    const state = randomState();
    const stateHash = await sha256(state);
    const quota = await reserveOrcidQuota(env, identity.uid, pathname, now, {
      budget: 'writes', globalLimit: GENERAL_DAILY_WRITE_LIMIT, globalAmount: 1,
    });
    // A whole-document write: a new connection replaces any one still pending.
    await commitFirstOrcidWrites(admin, [{ update: { name: link, fields: encodeFields({ stateHash, createdAt: now }) } }], env, quota);
    const query = new URLSearchParams({
      client_id: String(env.ORCID_CLIENT_ID),
      response_type: 'code',
      scope: '/authenticate',
      redirect_uri: redirectUri,
      state,
    });
    return { authorizeUrl: `https://${host}/oauth/authorize?${query}` };
  }

  if (pathname === '/orcid/complete') {
    const { code, state } = await readBody(request);
    await reserveOrcidQuota(env, identity.uid, pathname, now, {
      budget: 'attempts', globalLimit: GLOBAL_DAILY_COMPLETION_LIMIT, globalAmount: 1,
    });
    const pending = await admin.getDocument<LinkDocument>(linkSegments(identity.uid), { withMeta: true });
    const age = now - Number(pending?.data.createdAt);
    if (!pending?.updateTime || !pending.data.stateHash || pending.data.stateHash !== await sha256(state)
      || !(age >= 0 && age <= PENDING_LIFETIME_MS)) {
      throw new OrcidError('ORCID_CONNECTION_EXPIRED', 400);
    }
    const quota = await reserveOrcidQuota(env, identity.uid, pathname, now, {
      budget: 'writes', globalLimit: GENERAL_DAILY_WRITE_LIMIT, globalAmount: 3,
    });
    const holder = await exchangeCode(env, host, code, redirectUri).catch(async (error: unknown) => {
      await releaseOrcidWrites(env, quota);
      throw error;
    });
    const orcid: OrcidConnection = { ...holder, host, connectedAt: new Date(now).toISOString() };
    // One commit, so the state cannot be used again once the iD is written,
    // and the iD starts with no decisions about its works. It deletes only the
    // version of the pending state read above: a Disconnect or a new Connect
    // while ORCID was answering changed or deleted it, and then nothing is
    // written. No existence precondition on the user document: an account
    // that has not finished onboarding may have none yet.
    try {
      await commitFirstOrcidWrites(admin, [
        mergeWrite(userDocument, { orcid }, { mustExist: false }),
        deleteWrite(link, { updateTime: pending.updateTime }),
        deleteWrite(decisions),
      ], env, quota);
    } catch (error) {
      if (error instanceof FirestoreAdminError && error.status === 409) {
        throw new OrcidError('ORCID_CONNECTION_EXPIRED', 400);
      }
      throw error;
    }
    return { orcid };
  }

  if (pathname === '/orcid/disconnect') {
    await reserveOrcidQuota(env, identity.uid, pathname, now, {
      budget: 'attempts', globalLimit: GLOBAL_DAILY_COMPLETION_LIMIT, globalAmount: 0,
    });
    // Snapshot cleanup documents before the account so unlinked cleanup
    // cannot delete documents belonging to a connection created afterward.
    const [pending, previousDecisions] = await Promise.all([
      admin.getDocument<LinkDocument>(linkSegments(identity.uid), { withMeta: true }),
      admin.getDocument(decisionsSegments(identity.uid), { withMeta: true }),
    ]);
    const user = await admin.getDocument<{ orcid?: OrcidConnection }>(['users', identity.uid], { withMeta: true });
    const connected = Boolean(user?.data.orcid);
    const writes: FirestoreWrite[] = [];
    if (connected) {
      if (!user?.updateTime) throw new OrcidError('ORCID_FAILED', 502);
      const clear = clearFieldsWrite(userDocument, ['orcid']);
      // Clear the iD and remove pending state and decisions in one commit.
      // The user version protects a completion that has already committed.
      writes.push(
        { ...clear, currentDocument: { updateTime: user.updateTime } },
        deleteWrite(link),
        deleteWrite(decisions),
      );
    } else {
      if (pending?.updateTime) writes.push(deleteWrite(link, { updateTime: pending.updateTime }));
      if (previousDecisions?.updateTime) writes.push(deleteWrite(decisions, { updateTime: previousDecisions.updateTime }));
    }
    if (!writes.length) return { orcid: null };
    const quota = await reserveOrcidQuota(env, identity.uid, pathname, now, {
      budget: 'writes',
      globalLimit: connected ? GLOBAL_DAILY_WRITE_LIMIT : GENERAL_DAILY_WRITE_LIMIT,
      globalAmount: writes.length,
    });
    await commitFirstOrcidWrites(admin, writes, env, quota);
    return { orcid: null };
  }

  throw new OrcidError('NOT_FOUND', 404);
}
