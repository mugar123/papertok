import type { PublicListInput, PublicListPayload } from './publicListPayload.ts';
export interface ListOperationResult { code?: string; shareId?: string; paperCount?: number; listCount?: number; skipped?: number; publishedAt?: string; updatedAt?: string }
interface ListOperations { isDemo?: boolean; rest?: Pick<typeof firestoreRest, 'getDocument'>; request?: typeof authenticatedWorkerFetch; apiBase?: string }

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
import { IS_DEMO } from './firebase.ts';
import { authenticatedWorkerFetch } from './workerApiClient.ts';
import { firestoreRest } from './firestoreRestClient.ts';
import {
  PUBLIC_LIST_LIMITS,
  sanitizePublicList,
  sanitizePublicPaper,
  sanitizeSyncPaperIds,
} from './publicListPayload.ts';

// The shape of a public list lives in publicListPayload.js, which the Worker
// imports too: it is the one gate that decides what a public document may
// contain, now that firestore.rules cannot (F11). Re-exported here so every
// existing caller keeps its import path.
export { PUBLIC_LIST_LIMITS, sanitizePublicList, sanitizePublicPaper };

export class PublicListUnsupportedError extends Error {
  declare code: string;
  constructor() {
    super('Public lists are unavailable in demo mode.');
    this.name = 'PublicListUnsupportedError';
    this.code = 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO';
  }
}

/**
 * Carries the Worker's own code so the UI can tell "over your daily limit"
 * apart from "the service is down" instead of showing one blank failure.
 */
export class PublicListRequestError extends Error {
  declare code: string;
  declare status: number;
  constructor(code = 'PUBLISH_FAILED', status = 502) {
    super(code);
    this.name = 'PublicListRequestError';
    this.code = code;
    this.status = status;
  }
}

// Identifier hygiene, not payload shaping: uids, share ids and private list
// ids are checked here before they ever reach a path segment.
function cleanString(value: unknown, maximum: number|undefined) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function operations(overrides: ListOperations = {}) {
  return {
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    rest: overrides.rest || firestoreRest,
    request: overrides.request || authenticatedWorkerFetch,
    apiBase: overrides.apiBase === undefined
      ? import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '')
      : overrides.apiBase,
  };
}

function requireSupported(api: ReturnType<typeof operations>) {
  if (api.isDemo) throw new PublicListUnsupportedError();
}

function validateShareId(shareId: unknown) {
  const normalized = cleanString(shareId, 64);
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new TypeError('Invalid public list ID.');
  return normalized;
}

function validatePrivateListId(listId: unknown) {
  const normalized = cleanString(listId, 160);
  if (!normalized || normalized.includes('/')) throw new TypeError('Invalid private list ID.');
  return normalized;
}

// An answer that is not JSON is still an answer — the Worker's own error codes
// arrive as JSON, but a proxy in between may not. A body that never finished is
// a different matter, and that one throws out of here rather than parsing.
function parseWorkerPayload(text: string) {
  try {
    return JSON.parse(text) as ListOperationResult;
  } catch {
    return {};
  }
}

/**
 * One call to the Worker. The payload is sanitized here as well as there —
 * here so the UI never sends something it could have cleaned, there because a
 * browser is not a place to enforce anything.
 */
async function callWorker(api: ReturnType<typeof operations>, path: string, body: Record<string, unknown>) {
  if (!api.apiBase) throw new PublicListRequestError('PUBLISHING_NOT_CONFIGURED', 503);
  let response;
  let payload;
  try {
    response = await api.request(`${api.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // Read inside the same block. The request now carries a deadline, and a
    // deadline that fires while the body is arriving must fail the call: left
    // outside, the abort landed in a `.catch(() => ({}))` and the caller got an
    // empty payload it would have treated as a successful publish.
    payload = parseWorkerPayload(await response.text());
  } catch (error) {
    throw new PublicListRequestError((error as { code?: string } | null)?.code || 'PUBLISH_UNREACHABLE', 0);
  }
  if (!response.ok) {
    throw new PublicListRequestError(payload?.code || 'PUBLISH_FAILED', response.status);
  }
  return payload;
}

/**
 * `attributed: false` because there is no public profile to show the list on.
 * The Worker attributes a publish by default, which would add a card nobody
 * can see to `profileLists/{uid}` and refuse the 31st publish with
 * `PROFILE_LISTS_FULL`.
 */
export async function publishPublicList(input: PublicListInput, overrides?: ListOperations) {
  const api = operations(overrides);
  requireSupported(api);
  const listId = validatePrivateListId(input?.listId);
  const payload = sanitizePublicList(input);
  const result = await callWorker(api, '/lists/publish', { listId, ...payload, attributed: false });
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
export async function syncPublicList(shareId: string, input: PublicListInput, overrides?: ListOperations) {
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

  // Advisory. The Worker reads the real membership from the private list; this
  // only travels so an older Worker keeps working.
  const paperIds = sanitizeSyncPaperIds(input?.paperIds);
  // Every paper the caller hydrated, NOT only those in `paperIds`. Filtering
  // against that list is what turned a stale client cache into deletions: a
  // paper genuinely in the list but missing from the cached ids would have
  // been dropped on the way out, before the Worker ever saw it.
  const papers = (Array.isArray(input?.papers) ? input.papers : [])
    .map(sanitizePublicPaper)
    .filter(Boolean);

  const result = await callWorker(api, '/lists/update', {
    shareId: normalizedShareId, listId, ...header, paperIds, papers,
  });
  return { ...header, paperIds, ...result };
}

export async function unpublishPublicList(shareId: string, listId: string, overrides?: ListOperations) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedListId = validatePrivateListId(listId);
  const normalizedShareId = validateShareId(shareId);
  await callWorker(api, '/lists/unpublish', {
    shareId: normalizedShareId, listId: normalizedListId,
  });
}

export async function readPublicList(shareId: string, { signal }: { signal?: AbortSignal } = {}, overrides?: ListOperations) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedShareId = validateShareId(shareId);
  // Over REST, anonymous (`allow get: if true`): one request with no listen
  // stream behind it and no cache to answer from. On the SDK the read rode the
  // client's one stream, and a stream that had died under a live tab kept a
  // shared link on its spinner until the stall kick; and `getDoc` answered a
  // stalled read from the in-memory cache, where a list that exists came back
  // as "not available". Here a 404 is the server's own answer, and a request
  // that never arrives rejects as `unavailable`, which `patientRead` retries.
  const document = await api.rest.getDocument<PublicListPayload & { ownerUid?: string; updatedAt?: unknown }>(`publicLists/${normalizedShareId}`, { signal });
  return document?.exists ? { shareId: document.id, ...document.data } : null;
}
