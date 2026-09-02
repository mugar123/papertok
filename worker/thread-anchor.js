/**
 * Edge-cached paper thread lookup (comments sheet).
 *
 * Opening a thread used to be a sequential chain of Firestore SDK reads from
 * the browser: resolve the stub (one get, two for a dual-identity paper), then
 * query comments. Against a cold WebChannel that chain is what made an *empty*
 * sheet sit on a skeleton for seconds — there is nothing to render, but the
 * SDK still has to handshake. Closing and reopening was instant because the
 * channel was warm and the session cache was full.
 *
 * This route does the stub lookup (and the first comment page) over Firestore
 * REST from the Worker, then stores the correspondence in KV next to the user.
 * The browser asks once, gets an answer in tens of milliseconds on a hit, and
 * never opens Firestore for an empty thread.
 *
 * Writes still go direct to Firestore (the rules own them). After a create,
 * edit, delete or report the client deletes the KV entry so the next open
 * rebuilds. A short TTL is the safety net for a missed invalidation.
 */

import {
  canonicalPaperIdentity,
  keyFromIdentity,
} from '../src/utils/paperCanonicalKey.js';
import {
  FirestoreAdminError,
  createFirestoreAdmin,
  isServiceAccountConfigured,
} from './firestore-admin.js';
import { verifyFirebaseIdentity, WorkerAuthError } from './firebase-auth.js';

export class ThreadAnchorError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'ThreadAnchorError';
    this.code = code;
    this.status = status;
  }
}

/** Same page the client reads; duplicated so the Worker does not import Firebase. */
export const THREAD_PAGE_SIZE = 20;
/** Same cap as `COMMENT_COUNT_CAP` in commentService.js. */
export const THREAD_COUNT_CAP = 1000;
export const THREAD_KV_PREFIX = 'thread:v1:';
/** Empty papers are the common case and change only when someone comments. */
export const THREAD_KV_EMPTY_TTL_SECONDS = 120;
/**
 * A live thread is invalidated on write; this is only the missed-invalidation
 * net. 60 is KV's floor, not a choice: an `expirationTtl` under a minute is
 * rejected by production KV — the put throws, `writeCachedEntry` swallows it,
 * and no live thread is ever cached, so every open paid Firestore REST.
 */
export const THREAD_KV_THREAD_TTL_SECONDS = 60;
const MAX_IDENTITIES = 4;
const MAX_INVALIDATE_KEYS = 8;

export function threadKvKey(paperKey) {
  return `${THREAD_KV_PREFIX}${paperKey}`;
}

export function parseThreadIdentities(raw) {
  const parts = String(raw || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new ThreadAnchorError('THREAD_IDS_REQUIRED', 400);
  if (parts.length > MAX_IDENTITIES) throw new ThreadAnchorError('THREAD_IDS_TOO_MANY', 400);

  const seen = new Set();
  const identities = [];
  for (const part of parts) {
    const identity = canonicalPaperIdentity(part);
    if (!identity) throw new ThreadAnchorError('THREAD_IDS_INVALID', 400);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = keyFromIdentity(identity);
    if (!key) throw new ThreadAnchorError('THREAD_IDS_INVALID', 400);
    identities.push({ identity, key });
  }
  return identities;
}

export function parseInvalidateKeys(body) {
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (keys.length === 0) throw new ThreadAnchorError('THREAD_KEYS_REQUIRED', 400);
  if (keys.length > MAX_INVALIDATE_KEYS) throw new ThreadAnchorError('THREAD_KEYS_TOO_MANY', 400);
  const unique = [];
  const seen = new Set();
  for (const value of keys) {
    const key = String(value || '').trim();
    if (!key || key.length > 800 || key.includes('/') || key.includes('..')) {
      throw new ThreadAnchorError('THREAD_KEYS_INVALID', 400);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return unique;
}

function asIso(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  }
  return null;
}

export function serializeComment(row) {
  if (!row?.id) return null;
  const data = row.data && typeof row.data === 'object' ? row.data : row;
  const text = typeof data.text === 'string' ? data.text : '';
  if (!text) return null;
  return {
    id: row.id,
    authorUid: typeof data.authorUid === 'string' ? data.authorUid : '',
    authorHandle: typeof data.authorHandle === 'string' ? data.authorHandle : '',
    text,
    status: data.status === 'hidden' ? 'hidden' : 'visible',
    createdAt: asIso(data.createdAt),
    ...(data.editedAt ? { editedAt: asIso(data.editedAt) } : {}),
    ...(typeof data.replyTo === 'string' && data.replyTo ? { replyTo: data.replyTo } : {}),
    ...(data.dissociated === true ? { dissociated: true } : {}),
  };
}

function kvBinding(env) {
  return env?.THREAD_ANCHOR_STORE || env?.NOTIFICATION_STORE || null;
}

async function readCachedEntry(store, paperKey) {
  if (!store?.get) return null;
  try {
    const stored = await store.get(threadKvKey(paperKey), 'json');
    if (!stored || typeof stored !== 'object') return null;
    if (typeof stored.key !== 'string' || stored.key !== paperKey) return null;
    return stored;
  } catch {
    return null;
  }
}

async function writeCachedEntry(store, entry) {
  if (!store?.put || !entry?.key) return;
  const ttl = entry.stubExists ? THREAD_KV_THREAD_TTL_SECONDS : THREAD_KV_EMPTY_TTL_SECONDS;
  try {
    await store.put(threadKvKey(entry.key), JSON.stringify(entry), { expirationTtl: ttl });
  } catch {
    // A cache that cannot be written is still a valid miss next time.
  }
}

export async function deleteCachedEntries(store, keys) {
  if (!store?.delete) return;
  await Promise.all((keys || []).map(key => store.delete(threadKvKey(key)).catch(() => undefined)));
}

function emptyEntry(identity, key) {
  return {
    identity,
    key,
    stubExists: false,
    comments: [],
    hasMore: false,
    count: 0,
    capped: false,
  };
}

async function loadThreadPage(admin, identity, key) {
  const [comments, rawCount] = await Promise.all([
    admin.runQuery({
      parentSegments: ['papers', key],
      collectionId: 'comments',
      orderByField: 'createdAt',
      orderDirection: 'ASCENDING',
      limit: THREAD_PAGE_SIZE,
    }).catch(() => []),
    admin.countQuery({
      parentSegments: ['papers', key],
      collectionId: 'comments',
      limit: THREAD_COUNT_CAP,
    }).catch(() => 0),
  ]);
  const rows = Array.isArray(comments) ? comments : [];
  const serialized = rows.map(serializeComment).filter(Boolean);
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : serialized.length;
  return {
    identity,
    key,
    stubExists: true,
    comments: serialized,
    hasMore: serialized.length >= THREAD_PAGE_SIZE,
    count: Math.min(count, THREAD_COUNT_CAP),
    capped: count >= THREAD_COUNT_CAP,
  };
}

/**
 * Resolve every identity, preferring KV, fetching the rest in one go.
 *
 * The first identity is the canonical write target. Alternates that already
 * hold a stub are surfaced so a split-brain thread is still readable.
 */
export async function resolveThreadAnchorFromStore(identities, { admin, store }) {
  const cached = await Promise.all(identities.map(entry => readCachedEntry(store, entry.key)));
  const entries = [];
  const missing = [];

  identities.forEach((identity, index) => {
    if (cached[index]) entries[index] = cached[index];
    else missing.push(index);
  });

  if (missing.length && admin) {
    const stubs = await admin.batchGet(missing.map(index => ['papers', identities[index].key]));
    const fetched = await Promise.all(missing.map(async (slot, offset) => {
      const identity = identities[slot];
      const stubExists = Boolean(stubs[offset] && typeof stubs[offset] === 'object');
      const entry = stubExists
        ? await loadThreadPage(admin, identity.identity, identity.key)
        : emptyEntry(identity.identity, identity.key);
      await writeCachedEntry(store, entry);
      return { index: slot, entry };
    }));
    for (const { index, entry } of fetched) entries[index] = entry;
  } else if (missing.length) {
    throw new ThreadAnchorError('THREAD_ANCHOR_UNAVAILABLE', 503);
  }

  const primary = entries[0];
  const alternates = entries.slice(1).filter(entry => entry?.stubExists);
  const pages = [primary, ...alternates]
    .filter(entry => entry?.stubExists)
    .map(entry => ({
      key: entry.key,
      comments: Array.isArray(entry.comments) ? entry.comments : [],
      hasMore: entry.hasMore === true,
    }));
  const total = [primary, ...alternates].reduce((sum, entry) => sum + (entry?.count ?? 0), 0);
  const capped = [primary, ...alternates].some(entry => entry?.capped);

  return {
    identity: primary.identity,
    key: primary.key,
    stubExists: primary.stubExists === true,
    alternates: alternates.map(entry => ({ identity: entry.identity, key: entry.key })),
    pages,
    count: { count: Math.min(total, THREAD_COUNT_CAP), capped },
    cache: missing.length === 0 ? 'kv' : 'miss',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

export async function handleThreadAnchorRequest(request, env, url, { cors = {} } = {}) {
  const store = kvBinding(env);

  if (url.pathname === '/thread-anchor/invalidate') {
    if (request.method !== 'POST') throw new ThreadAnchorError('METHOD_NOT_ALLOWED', 405);
    await verifyFirebaseIdentity(request, env, { allowCache: true });
    let body;
    try {
      body = await request.json();
    } catch {
      throw new ThreadAnchorError('THREAD_KEYS_REQUIRED', 400);
    }
    const keys = parseInvalidateKeys(body);
    await deleteCachedEntries(store, keys);
    return json({ ok: true, keys }, 200, { ...cors, 'cache-control': 'private, no-store' });
  }

  if (url.pathname !== '/thread-anchor') {
    throw new ThreadAnchorError('NOT_FOUND', 404);
  }
  if (request.method !== 'GET') throw new ThreadAnchorError('METHOD_NOT_ALLOWED', 405);

  const identities = parseThreadIdentities(url.searchParams.get('ids'));
  if (!isServiceAccountConfigured(env) && !store) {
    throw new ThreadAnchorError('THREAD_ANCHOR_UNAVAILABLE', 503);
  }

  let admin = null;
  if (isServiceAccountConfigured(env)) {
    admin = createFirestoreAdmin(env);
  }

  const payload = await resolveThreadAnchorFromStore(identities, { admin, store });
  // KV is the cache. An HTTP max-age here would outlive a KV delete, so a
  // comment posted in this region could still serve the empty page from a
  // CDN edge for those seconds. no-store keeps invalidation honest.
  return json(payload, 200, {
    ...cors,
    'cache-control': 'private, no-store',
  });
}

export function threadAnchorErrorResponse(error, cors = {}) {
  const known = error instanceof ThreadAnchorError
    || error instanceof WorkerAuthError
    || error instanceof FirestoreAdminError;
  const status = known ? error.status : 502;
  const code = known
    ? (error.code || 'THREAD_ANCHOR_UNAVAILABLE')
    : 'THREAD_ANCHOR_UNAVAILABLE';
  return json({ code }, status, { ...cors, 'cache-control': 'no-store' });
}
