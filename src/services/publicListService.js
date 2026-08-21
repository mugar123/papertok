/**
 * Publishing goes through the Worker; reading does not.
 *
 * Writes used to be a three-document batch committed straight from the browser
 * and validated by `firestore.rules`. The rules could not do it — one realistic
 * paper exceeded the 1000-expression ceiling and publishing failed outright — so
 * `publicLists` is closed to clients and the Worker writes it with the service
 * identity after validating in real code (F11).
 *
 * Reading is untouched and deliberately so: a share link is still one public
 * document fetched with one read, straight from Firestore, with no session and
 * no round trip through the Worker.
 */
import { doc, getDoc } from 'firebase/firestore';
import { db, IS_DEMO } from './firebase.js';
import { authenticatedWorkerFetch } from './workerApiClient.js';
import { documentIsAuthoritative } from '../utils/cacheAuthority.js';
import {
  PUBLIC_LIST_LIMITS,
  sanitizePublicList,
  sanitizePublicPaper,
  sanitizePublicPaperForSync,
  sanitizeSyncPaperIds,
} from './publicListPayload.js';

// The shape of a public list lives in publicListPayload.js, which the Worker
// imports too: it is the one gate that decides what a public document may
// contain, now that firestore.rules cannot (F11). Re-exported here so every
// existing caller keeps its import path.
export { PUBLIC_LIST_LIMITS, sanitizePublicList, sanitizePublicPaper };

export class PublicListUnsupportedError extends Error {
  constructor() {
    super('Public lists are unavailable in demo mode.');
    this.name = 'PublicListUnsupportedError';
    this.code = 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO';
  }
}

/**
 * The read reached the local cache and nothing else, so "this list does not
 * exist" is a guess, not an answer.
 *
 * Distinct from a plain failure because it is retryable and because the list
 * on the other end is almost certainly fine — telling a visitor that somebody's
 * shared list does not exist, when the truth is that this tab could not reach
 * the backend, is the worst of the three things this page can say.
 */
export class PublicListUnavailableError extends Error {
  constructor() {
    super('The public list could not be read from the server.');
    this.name = 'PublicListUnavailableError';
    this.code = 'PUBLIC_LIST_UNAVAILABLE';
    this.retryable = true;
  }
}

/**
 * Carries the Worker's own code so the UI can tell "over your daily limit"
 * apart from "the service is down" instead of showing one blank failure.
 */
export class PublicListRequestError extends Error {
  constructor(code = 'PUBLISH_FAILED', status = 502) {
    super(code);
    this.name = 'PublicListRequestError';
    this.code = code;
    this.status = status;
  }
}

// Identifier hygiene, not payload shaping: uids, share ids and private list
// ids are checked here before they ever reach a path segment.
function cleanString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    document: overrides.document || doc,
    getDocument: overrides.getDocument || getDoc,
    request: overrides.request || authenticatedWorkerFetch,
    apiBase: overrides.apiBase === undefined
      ? import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '')
      : overrides.apiBase,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new PublicListUnsupportedError();
}

function validateShareId(shareId) {
  const normalized = cleanString(shareId, 64);
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new TypeError('Invalid public list ID.');
  return normalized;
}

function validatePrivateListId(listId) {
  const normalized = cleanString(listId, 160);
  if (!normalized || normalized.includes('/')) throw new TypeError('Invalid private list ID.');
  return normalized;
}

/**
 * One call to the Worker. The payload is sanitized here as well as there —
 * here so the UI never sends something it could have cleaned, there because a
 * browser is not a place to enforce anything.
 */
async function callWorker(api, path, body) {
  if (!api.apiBase) throw new PublicListRequestError('PUBLISHING_NOT_CONFIGURED', 503);
  let response;
  try {
    response = await api.request(`${api.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PublicListRequestError(error?.code || 'PUBLISH_UNREACHABLE', 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PublicListRequestError(payload?.code || 'PUBLISH_FAILED', response.status);
  }
  return payload;
}

export async function publishPublicList(input, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const listId = validatePrivateListId(input?.listId);
  const payload = sanitizePublicList(input);
  const result = await callWorker(api, '/lists/publish', { listId, ...payload });
  return { ...payload, ...result };
}

/**
 * The background sync (P25): the public copy rebuilt from the private list,
 * with no button anywhere.
 *
 * It uses the merge half of `/lists/update` rather than the whole-payload
 * replace, and that distinction is the whole reason the sync is safe to fire
 * from screens that only ever hold part of a list in memory. The caller sends:
 *
 *  - `paperIds`: the membership, authoritative. Order and removals come from
 *    here, so a paper dropped from the private list leaves the public one even
 *    if nothing about it was hydrated.
 *  - `papers`: whatever it could hydrate, keyed by those same ids. The Worker
 *    keeps the already-published paper for every id the caller left out.
 *
 * The save-and-organize modal has exactly one paper in hand and can still sync
 * a fifty-paper list correctly. A whole-payload replace from there would have
 * published a list of one.
 */
export async function syncPublicList(shareId, input, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const listId = validatePrivateListId(input?.listId);
  const normalizedShareId = validateShareId(shareId);

  // The header only — sanitizing with `papers: []` keeps the paper sanitizer
  // from rewriting the ids the merge joins on. `paperCount` is the Worker's to
  // compute from the merge, so it is not ours to send.
  const clean = sanitizePublicList({ ...input, papers: [] });
  const header = {
    title: clean.title,
    ...(clean.description ? { description: clean.description } : {}),
    language: clean.language,
  };

  const paperIds = sanitizeSyncPaperIds(input?.paperIds);
  const wanted = new Set(paperIds);
  const papers = (Array.isArray(input?.papers) ? input.papers : [])
    .map(sanitizePublicPaperForSync)
    .filter(paper => paper && wanted.has(paper.id));

  const result = await callWorker(api, '/lists/update', {
    shareId: normalizedShareId, listId, ...header, paperIds, papers,
  });
  return { ...header, paperIds, ...result };
}

/**
 * Turns attribution on or off for an already-published list (F12): whether it
 * appears, as a card, in the owner's public showcase (`profileLists/{uid}`).
 * The Worker owns both artifacts — the card and the `onProfile` mirror on the
 * private list — and moves them in one commit; asking for what is already
 * true succeeds. The published content and its share link are untouched.
 */
export async function attributePublicList(shareId, attributed, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedShareId = validateShareId(shareId);
  if (typeof attributed !== 'boolean') throw new TypeError('Attribution must be true or false.');
  return callWorker(api, '/lists/attribute', {
    shareId: normalizedShareId, attributed,
  });
}

export async function unpublishPublicList(shareId, listId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedListId = validatePrivateListId(listId);
  const normalizedShareId = validateShareId(shareId);
  await callWorker(api, '/lists/unpublish', {
    shareId: normalizedShareId, listId: normalizedListId,
  });
}

export async function readPublicList(shareId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedShareId = validateShareId(shareId);
  const snapshot = await api.getDocument(api.document(api.database, 'publicLists', normalizedShareId));
  // `getDoc` resolves against the in-memory cache when the backend is
  // unreachable, so a missing document is only really missing if the server is
  // the one saying so. Without this, a shared list that exists rendered as
  // "this list is not available" for anyone whose connection had stalled.
  if (!documentIsAuthoritative(snapshot)) throw new PublicListUnavailableError();
  return snapshot.exists() ? { shareId: snapshot.id, ...snapshot.data() } : null;
}
