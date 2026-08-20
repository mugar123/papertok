/**
 * Publishing a list (P19).
 *
 * These three routes exist because `firestore.rules` cannot validate a public
 * list: the rules engine stops at 1000 evaluated expressions per request and a
 * single realistic paper already exceeds that, which is why publishing was
 * broken outright. `publicLists` and `publicListOwners` are closed to clients
 * (P20); this is the only way in, and it validates in real code first.
 *
 * What the Worker checks that the rules used to:
 *  - the caller is signed in, verified against Identity Toolkit with no cache;
 *  - the caller owns the private list the publication is attached to;
 *  - the payload obeys every limit in publicListPayload.js, which the browser
 *    imports too, so there is one definition of a valid public list;
 *  - `createdAt` never moves, enforced with an update mask rather than a read.
 *
 * Firestore stays on the free tier deliberately: a publish costs one read and
 * one atomic commit of three writes, and the daily quotas below cap the whole
 * route far under the Spark allowance of 20k writes and 50k reads a day.
 * Update and unpublish add the pinned-card refresh (refreshPinnedCard below):
 * +1 read always, +1 more only when pins are hidden, +1 write only when the
 * list was actually pinned and the card changed — bounded by the same daily
 * quotas, so the worst day stays far inside the allowance.
 */
import {
  assertPublicListWithinLimits,
  sanitizePublicList,
} from '../src/services/publicListPayload.js';
import { verifyFirebaseIdentity } from './firebase-auth.js';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  createWrite,
  deleteWrite,
  FirestoreAdminError,
  isServiceAccountConfigured,
  mergeWrite,
} from './firestore-admin.js';
import { reserveRequestQuota } from './request-quota-ledger.js';

export const PUBLIC_LIST_PATHS = new Set(['/lists/publish', '/lists/update', '/lists/unpublish']);

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_USER_DAILY_LIMIT = 60;
const DEFAULT_GLOBAL_DAILY_LIMIT = 2_000;
const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/;

export class PublicListApiError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'PublicListApiError';
    this.code = code;
    this.status = status;
  }
}

function boundedLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

export function createShareId(cryptoApi = crypto) {
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function requireShareId(value) {
  const shareId = String(value || '').trim();
  if (!SHARE_ID_PATTERN.test(shareId)) throw new PublicListApiError('INVALID_SHARE_ID', 400);
  return shareId;
}

function requireListId(value) {
  const listId = String(value || '').trim();
  if (!listId || listId.length > 160 || listId.includes('/')) {
    throw new PublicListApiError('INVALID_LIST_ID', 400);
  }
  return listId;
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new PublicListApiError('PAYLOAD_TOO_LARGE', 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new PublicListApiError('PAYLOAD_TOO_LARGE', 413);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new PublicListApiError('INVALID_BODY', 400);
    }
    return body;
  } catch (error) {
    if (error instanceof PublicListApiError) throw error;
    throw new PublicListApiError('INVALID_BODY', 400);
  }
}

/**
 * The payload the public document will hold, refused rather than coerced.
 * `sanitizePublicList` drops what it cannot clean, which is right for a form
 * and wrong for a request off the network: a caller that sent 80 papers should
 * be told, not quietly published with 50.
 */
export function buildPublicListPayload(body) {
  let payload;
  try {
    payload = sanitizePublicList(body);
  } catch {
    throw new PublicListApiError('TITLE_REQUIRED', 400);
  }
  const submitted = Array.isArray(body?.papers) ? body.papers.length : 0;
  if (submitted !== payload.papers.length) {
    throw new PublicListApiError('PAPERS_REJECTED', 400);
  }
  const failures = assertPublicListWithinLimits(payload);
  if (failures.length) {
    throw new PublicListApiError(`INVALID_PAYLOAD_${failures[0]}`, 400);
  }
  return payload;
}

async function reservePublishQuota(env, uid) {
  const day = new Date().toISOString().slice(0, 10);
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, {
    periodKey: `publiclist:${day}`,
    subject: `publiclist:${uid}`,
    subjectLimit: boundedLimit(env.PUBLIC_LIST_USER_DAILY_LIMIT, DEFAULT_USER_DAILY_LIMIT, 500),
    globalLimit: boundedLimit(env.PUBLIC_LIST_GLOBAL_DAILY_LIMIT, DEFAULT_GLOBAL_DAILY_LIMIT, 10_000),
  });
  if (reservation.accepted) return;
  // A ledger that is not wired up must not silently disable the cap: on the
  // free tier the cap is what keeps the daily write allowance intact.
  throw new PublicListApiError(
    reservation.code === 'QUOTA_LEDGER_NOT_CONFIGURED' || reservation.code === 'QUOTA_LEDGER_UNAVAILABLE'
      ? 'PUBLISH_QUOTA_NOT_CONFIGURED'
      : 'PUBLISH_QUOTA_EXCEEDED',
    reservation.code ? 503 : 429,
  );
}

/** Reads the private list and proves the caller owns it. */
async function requireOwnedList(admin, uid, listId) {
  const list = await admin.getDocument(['users', uid, 'lists', listId]);
  if (!list) throw new PublicListApiError('LIST_NOT_FOUND', 404);
  return list;
}

async function requireOwnedShare(admin, uid, shareId) {
  const owner = await admin.getDocument(['publicListOwners', shareId]);
  if (!owner) throw new PublicListApiError('SHARE_NOT_FOUND', 404);
  if (owner.ownerId !== uid) throw new PublicListApiError('NOT_THE_OWNER', 403);
  return owner;
}

/**
 * Keeps the profile's pinned card in step with the list it denormalizes.
 *
 * The card (`{shareId, title, emoji?, paperCount}` in `userProfiles/{uid}`)
 * used to be a snapshot taken when the owner clicked Pin: grow the list from
 * 12 papers to 19 and the profile kept saying 12 until a manual re-pin. Now
 * `/lists/update` refreshes the card's title and count, and `/lists/unpublish`
 * removes the card outright — an unpublished share id fails the ownership
 * check in the rules, so a card left behind would veto every later profile
 * write from the client (the "something went wrong" family).
 *
 * Pins hidden by the owner are parked verbatim in
 * `users/{uid}/profileStash/pinnedLists` (F8), so when the profile does not
 * hold the card and says `showPinnedLists: false`, the stash is checked too —
 * otherwise flipping the switch back would resurrect the stale card.
 *
 * Strictly best-effort, and the failure direction is chosen: the list
 * operation has already committed, so nothing here may throw past it. The
 * write carries an `updateTime` precondition — a pin toggled in the same
 * instant wins and the refresh retries once from a fresh read, then gives up
 * as 'skipped', which leaves exactly the staleness we have today, never a
 * clobbered pin. Cost when the list is not pinned: 1 read (+1 with pins
 * hidden), no writes.
 */
export async function refreshPinnedCard(admin, uid, shareId, card, { now }) {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const profile = await admin.getDocument(['userProfiles', uid], { withMeta: true });
      if (!profile) return 'not-pinned';

      let segments = ['userProfiles', uid];
      let holder = profile;
      let entries = Array.isArray(profile.data.pinnedLists) ? profile.data.pinnedLists : [];
      if (!entries.some(entry => entry?.shareId === shareId)) {
        if (profile.data.showPinnedLists !== false) return 'not-pinned';
        const stash = await admin.getDocument(['users', uid, 'profileStash', 'pinnedLists'], { withMeta: true });
        const stashed = Array.isArray(stash?.data?.pinnedLists) ? stash.data.pinnedLists : [];
        if (!stashed.some(entry => entry?.shareId === shareId)) return 'not-pinned';
        segments = ['users', uid, 'profileStash', 'pinnedLists'];
        holder = stash;
        entries = stashed;
      }

      const current = entries.find(entry => entry?.shareId === shareId);
      if (card && current.title === card.title && current.paperCount === card.paperCount) {
        return 'unchanged';
      }
      const next = card
        ? entries.map(entry => (entry?.shareId === shareId
          ? { ...entry, title: card.title, paperCount: card.paperCount }
          : entry))
        : entries.filter(entry => entry?.shareId !== shareId);

      try {
        await admin.commit([
          mergeWrite(admin.name(segments), { pinnedLists: next, updatedAt: new Date(now()) }, {
            updateTime: holder.updateTime,
          }),
        ]);
        return card ? 'refreshed' : 'removed';
      } catch (error) {
        // Lost the race against a concurrent pin toggle: read again and retry
        // once. Anything else falls through to 'skipped' below.
        if (!(error instanceof FirestoreAdminError && error.status === 409)) throw error;
      }
    }
    return 'skipped';
  } catch {
    return 'skipped';
  }
}

// ---------------------------------------------------------------------------
// The three operations.
// ---------------------------------------------------------------------------

async function publish(admin, uid, body, { cryptoApi, now }) {
  const listId = requireListId(body.listId);
  const payload = buildPublicListPayload(body);
  const list = await requireOwnedList(admin, uid, listId);
  if (list.publicShareId) throw new PublicListApiError('ALREADY_PUBLISHED', 409);

  const shareId = createShareId(cryptoApi);
  const timestamp = new Date(now());
  await admin.commit([
    createWrite(admin.name(['publicListOwners', shareId]), {
      ownerId: uid, listId, createdAt: timestamp,
    }),
    createWrite(admin.name(['publicLists', shareId]), {
      ...payload, createdAt: timestamp, updatedAt: timestamp,
    }),
    mergeWrite(admin.name(['users', uid, 'lists', listId]), { publicShareId: shareId }),
  ]);
  return { shareId, ...payload };
}

async function update(admin, uid, body, { now }) {
  const shareId = requireShareId(body.shareId);
  const payload = buildPublicListPayload(body);
  await requireOwnedShare(admin, uid, shareId);

  // `description` is always in the mask and only sometimes in the fields: a
  // list that drops its description must lose it from the public document
  // rather than keep the old one. `createdAt` is in neither, so it cannot move.
  const fields = { ...payload, updatedAt: new Date(now()) };
  const write = mergeWrite(admin.name(['publicLists', shareId]), fields);
  write.updateMask = {
    fieldPaths: [...new Set([...Object.keys(fields), 'description'])],
  };
  await admin.commit([write]);
  // After, not inside, the commit above: the card is a courtesy and the list
  // update must never fail over it. (Publish needs no counterpart — a freshly
  // minted share id cannot be pinned yet.)
  const pinCard = await refreshPinnedCard(admin, uid, shareId, {
    title: payload.title, paperCount: payload.paperCount,
  }, { now });
  return { shareId, ...payload, pinCard };
}

async function unpublish(admin, uid, body, { now }) {
  const shareId = requireShareId(body.shareId);
  const listId = requireListId(body.listId);
  await requireOwnedShare(admin, uid, shareId);

  // The private list loses its pointer in the same commit. Without that the
  // owner would be left with a list that claims to be published and a delete
  // rule that refuses to let it go.
  await admin.commit([
    deleteWrite(admin.name(['publicLists', shareId])),
    deleteWrite(admin.name(['publicListOwners', shareId])),
    clearFieldsWrite(admin.name(['users', uid, 'lists', listId]), ['publicShareId']),
  ]);
  // The owners document this share id had is gone, so a card pointing at it
  // would fail ownsPinnedShare() and veto every profile write the client
  // tries next. Unpinning here closes the orphan at its source.
  const pinCard = await refreshPinnedCard(admin, uid, shareId, null, { now });
  return { shareId, unpublished: true, pinCard };
}

const OPERATIONS = {
  '/lists/publish': publish,
  '/lists/update': update,
  '/lists/unpublish': unpublish,
};

export async function handlePublicListRequest(request, env, pathname, options = {}) {
  if (!PUBLIC_LIST_PATHS.has(pathname)) throw new PublicListApiError('NOT_FOUND', 404);
  if (request.method !== 'POST') throw new PublicListApiError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new PublicListApiError('PUBLISHING_NOT_CONFIGURED', 503);
  }

  // No cached identity here: this route publishes to the open web.
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const body = await readBody(request);
  await reservePublishQuota(env, identity.uid);

  const admin = options.admin || createFirestoreAdmin(env);
  const settings = {
    cryptoApi: options.cryptoApi || crypto,
    now: options.now || (() => Date.now()),
  };
  try {
    return await OPERATIONS[pathname](admin, identity.uid, body, settings);
  } catch (error) {
    if (error instanceof FirestoreAdminError) {
      // A lost race on create is the only precondition this route can hit.
      throw new PublicListApiError(
        error.status === 409 ? 'PUBLISH_CONFLICT' : 'PUBLISH_FAILED',
        error.status === 409 ? 409 : 502,
      );
    }
    throw error;
  }
}
