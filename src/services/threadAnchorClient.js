/**
 * First-page comment thread, resolved at the edge.
 *
 * The Worker looks up the paper stub (and the first page of comments) over
 * Firestore REST, caches the correspondence in KV, and answers in tens of
 * milliseconds on a hit. The browser never opens the Firestore SDK for an
 * empty thread — that handshake was what made a sheet with nothing in it sit
 * on a skeleton for seconds.
 *
 * Writes still go to Firestore. After one, `invalidateThreadAnchor` drops the
 * KV entry so the next open rebuilds. A short TTL on the Worker is the net
 * for a missed invalidation.
 */

import {
  candidateStubIdentities,
  keyFromIdentity,
} from '../utils/paperCanonicalKey.js';
import { commentDate } from '../utils/commentTime.js';
import {
  authenticatedWorkerFetch,
  fetchWorkerSourceJson,
  hasWorkerSession,
  workerSourceUrl,
} from './workerApiClient.js';

// The Worker should answer in tens of milliseconds. Anything longer means it
// is down or the route is not deployed yet, and the sheet must start the
// Firestore fallback before `patientRead`'s 6s budget is spent waiting.
const THREAD_ANCHOR_TIMEOUT_MS = 1500;

export function hydrateComment(row, paperKey) {
  if (!row?.id) return null;
  return {
    id: row.id,
    authorUid: typeof row.authorUid === 'string' ? row.authorUid : '',
    authorHandle: typeof row.authorHandle === 'string' ? row.authorHandle : '',
    text: typeof row.text === 'string' ? row.text : '',
    status: row.status === 'hidden' ? 'hidden' : 'visible',
    createdAt: commentDate(row.createdAt),
    ...(row.editedAt ? { editedAt: commentDate(row.editedAt) } : {}),
    ...(typeof row.replyTo === 'string' && row.replyTo ? { replyTo: row.replyTo } : {}),
    ...(row.dissociated === true ? { dissociated: true } : {}),
    ...(paperKey ? { paperKey } : {}),
  };
}

export function threadIdentitiesOf(paper) {
  return candidateStubIdentities(paper);
}

/**
 * Turns the Worker payload into the shape CommentsSheet already stores:
 * `{ resolved, keys, pages }`.
 */
export function normalizeThreadAnchorPayload(payload) {
  if (!payload?.key) return null;
  const pages = (Array.isArray(payload.pages) ? payload.pages : []).map(page => ({
    key: page.key,
    comments: (Array.isArray(page.comments) ? page.comments : [])
      .map(row => hydrateComment(row, page.key))
      .filter(Boolean),
    cursor: null,
    hasMore: page.hasMore === true,
  }));
  const alternates = Array.isArray(payload.alternates) ? payload.alternates : [];
  return {
    resolved: {
      key: payload.key,
      identity: payload.identity,
      stubExists: payload.stubExists === true,
      stub: null,
      alternates: alternates.map(entry => ({
        key: entry.key,
        identity: entry.identity,
        stub: null,
      })),
    },
    keys: pages.map(page => page.key),
    pages,
    count: payload.count && typeof payload.count.count === 'number'
      ? { count: payload.count.count, capped: payload.count.capped === true }
      : (pages.length === 0 ? { count: 0, capped: false } : null),
  };
}

export async function fetchThreadAnchor(paper, options = {}) {
  const identities = threadIdentitiesOf(paper);
  if (!identities.length) return null;
  const payload = await fetchWorkerSourceJson(
    '/thread-anchor',
    { ids: identities.join(',') },
    { timeoutMs: THREAD_ANCHOR_TIMEOUT_MS, ...options },
  );
  return normalizeThreadAnchorPayload(payload);
}

/**
 * Drops the cached first page for the keys a write just touched. Best-effort:
 * a missed delete heals on the Worker's TTL, and a signed-out caller cannot
 * have written anyway.
 */
export async function invalidateThreadAnchor(keys, {
  apiBase,
  fetchImpl,
} = {}) {
  const unique = [...new Set((Array.isArray(keys) ? keys : [keys])
    .map(key => String(key || '').trim())
    .filter(Boolean))];
  if (!unique.length || !hasWorkerSession()) return false;
  const url = workerSourceUrl('/thread-anchor/invalidate', {}, apiBase);
  if (!url) return false;
  try {
    const response = fetchImpl
      ? await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: unique }),
      })
      : await authenticatedWorkerFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: unique }),
      });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export function localThreadKeys(paper) {
  return candidateStubIdentities(paper)
    .map(identity => keyFromIdentity(identity))
    .filter(Boolean);
}
