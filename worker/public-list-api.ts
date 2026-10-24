import { isServiceAccountConfigured, FirebaseServiceAccountError } from './firebase-service-account.ts';
import type { WorkerEnv } from './env.ts';
import type { FirestoreAdmin } from './firestore-admin.ts';

type ListEntry = NonNullable<ReturnType<typeof sanitizePublicPaper>>;
type ListPayload = Omit<ReturnType<typeof sanitizePublicList>, 'papers'> & { papers: ListEntry[] };
type ListBody = Record<string, unknown>;
type ListAdmin = Pick<FirestoreAdmin, 'name' | 'commit' | 'getDocument'>;
interface PrivateList { publicShareId?: unknown; paperIds?: unknown[]; emoji?: unknown }
interface OperationSettings { cryptoApi: ShareIdCrypto; now: () => number }
interface ListOptions { admin?: ListAdmin; cryptoApi?: ShareIdCrypto; now?: () => number }
interface PreparedOperations {
  '/lists/publish': ReturnType<typeof validatePublish>;
  '/lists/update': ReturnType<typeof validateUpdate>;
  '/lists/unpublish': ReturnType<typeof validateUnpublish>;
}
type OperationPath = keyof PreparedOperations;
type ShareIdCrypto = { getRandomValues(bytes: Uint8Array<ArrayBuffer>): unknown };
export interface OperationResults {
  '/lists/publish': Awaited<ReturnType<typeof publish>>;
  '/lists/update': Awaited<ReturnType<typeof update>>;
  '/lists/unpublish': Awaited<ReturnType<typeof unpublish>>;
}
interface ListOperation<Key extends OperationPath> {
  validate(body: ListBody): PreparedOperations[Key];
  run(admin: ListAdmin, uid: string, prepared: PreparedOperations[Key], settings: OperationSettings): Promise<OperationResults[Key]>;
}


/**
 * Publishing a list (P19).
 *
 * These routes exist because `firestore.rules` cannot validate a public
 * list: the rules engine stops at 1000 evaluated expressions per request and a
 * single realistic paper already exceeds that, which is why publishing was
 * broken outright. `publicLists` and `publicListOwners` are closed to clients
 * (P20); this is the only way in, and it validates in real code first.
 *
 * What the Worker checks that the rules used to:
 *  - the caller is signed in, verified against Identity Toolkit with no cache;
 *  - the caller owns the private list the publication is attached to;
 *  - the payload obeys every limit in publicListPayload.ts, which the browser
 *    imports too, so there is one definition of a valid public list;
 *  - `createdAt` never moves, enforced with an update mask rather than a read.
 *
 * Firestore stays on the free tier deliberately: a publish costs one read and
 * one atomic commit of three writes, and the daily quotas below cap the whole
 * route far under the Spark allowance of 20k writes and 50k reads a day.
 *
 * Publish and update both retry once when they lose a version precondition,
 * reading the list and its content again so a racing edit is not lost.
 */
import {
  assertPublicListWithinLimits,
  PUBLIC_LIST_LIMITS,
  publicPaperJoinKey,
  sanitizePublicList,
  sanitizePublicPaper,
} from '../src/services/publicListPayload.ts';
import { verifyFirebaseIdentity } from './firebase-auth.ts';
import {
  clearFieldsWrite,
  createFirestoreAdmin,
  createWrite,
  deleteWrite,
  FirestoreAdminError,
  mergeWrite,
} from './firestore-admin.ts';
import { reserveRequestQuota } from './request-quota-ledger.ts';

export const PUBLIC_LIST_PATHS = new Set([
  '/lists/publish', '/lists/update', '/lists/unpublish',
]);

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_USER_DAILY_LIMIT = 60;
const DEFAULT_GLOBAL_DAILY_LIMIT = 2_000;
const SHARE_ID_PATTERN = /^[a-f0-9]{32}$/;

export class PublicListApiError extends Error {
  declare code: string;
  declare status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.name = 'PublicListApiError';
    this.code = code;
    this.status = status;
  }
}

function boundedLimit(value: unknown, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value as string, 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

export function createShareId(cryptoApi: ShareIdCrypto = crypto) {
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function requireShareId(value: unknown) {
  const shareId = String(value || '').trim();
  if (!SHARE_ID_PATTERN.test(shareId)) throw new PublicListApiError('INVALID_SHARE_ID', 400);
  return shareId;
}

/**
 * A list id becomes a path segment, so it has to be a segment and nothing else.
 * `.` and `..` are not names: `encodeURIComponent` leaves them untouched and the
 * URL parser then resolves them away, so `listId: '..'` turns the ownership read
 * of `users/{uid}/lists/..` into a read of the caller's own user document — a
 * check answered by the wrong document, and a quota unit spent on it. Exact
 * equality rather than a dot search: `arxiv:2608.18000` is a perfectly good id.
 */
function requireListId(value: unknown) {
  const listId = String(value || '').trim();
  if (!listId || listId.length > 160 || listId.includes('/')
    || listId === '.' || listId === '..') {
    throw new PublicListApiError('INVALID_LIST_ID', 400);
  }
  return listId;
}

/**
 * The ceiling is a number of BYTES, so it has to be measured in bytes.
 * `text.length` counts UTF-16 code units, and a body of three-byte characters
 * weighs three times what it reports: a 1 MB budget that quietly accepted 3 MB.
 * `content-length` catches any ordinary client, but a chunked body carries no
 * such header, which is precisely the shape a caller who cared would send.
 */
async function readBody(request: Request): Promise<ListBody> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new PublicListApiError('PAYLOAD_TOO_LARGE', 413);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) throw new PublicListApiError('PAYLOAD_TOO_LARGE', 413);
  // Non-fatal on purpose: invalid UTF-8 becomes U+FFFD and is refused below as
  // INVALID_BODY, instead of throwing a TypeError straight past this function.
  const text = new TextDecoder().decode(buffer);
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
export function buildPublicListPayload(body: ListBody): ListPayload {
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

/**
 * Merge semantics for /lists/update: the MEMBERSHIP is read from the private
 * list, the papers are whatever the caller could hydrate, and papers already
 * in the public document survive for every id the caller left out.
 *
 * `membership` is the caller-independent half and that is the whole point. It
 * used to be `body.paperIds`, and trusting it cost a real shared list two
 * papers: the save-and-organize modal paints from a 30-second session cache,
 * so the ids it sends are a client-side reconstruction, and anything missing
 * from that reconstruction was deleted from the public copy. A list is what
 * `users/{uid}/lists/{listId}` says it is.
 *
 * The join key is the id the private list files a paper under — `sourceId` on
 * the published paper, recorded when it was published. Before that field
 * existed the join had to guess from `id`/`doi`/`arxivId`, and a miss did not
 * degrade, it DELETED: `continue` dropped an already-published paper because
 * the client happened not to hydrate it this time. Legacy documents have no
 * `sourceId`, so the old spellings stay in the index behind it and the first
 * full sync writes the field.
 *
 * An id that matches nothing is a paper with no metadata anywhere; it is
 * skipped and counted, so the owner can be told rather than left comparing
 * numbers between two accounts.
 */
/**
 * The half of the merge that depends only on the request. Split out so it can
 * run BEFORE the daily quota is reserved (nothing that never reached Firestore
 * may charge for it) and so the retry below can reuse it: sanitizing fifty
 * papers again on the second attempt would be pure waste, and the result cannot
 * have changed.
 */
export function prepareMergeInput(body: ListBody) {
  let header;
  try {
    header = sanitizePublicList({ ...body, papers: [] });
  } catch {
    throw new PublicListApiError('TITLE_REQUIRED', 400);
  }

  // Refused rather than coerced, like buildPublicListPayload: a paper the
  // sanitizer would drop is a caller that must be told.
  const byRawId = new Map<string, ListEntry>();
  for (const raw of Array.isArray(body.papers) ? body.papers : []) {
    const clean = sanitizePublicPaper(raw);
    if (!clean) throw new PublicListApiError('PAPERS_REJECTED', 400);
    byRawId.set(publicPaperJoinKey(clean), clean);
  }

  return {
    header,
    byRawId,
    requestIds: Array.isArray(body.paperIds) ? body.paperIds : null,
  };
}

/** The other half: everything that needs the two documents to be read first. */
export function mergePreparedPayload({ header, byRawId, requestIds }: ReturnType<typeof prepareMergeInput>, existing: Partial<ListPayload> | null, membership?: unknown) {
  const source = Array.isArray(membership) ? membership : requestIds;
  if (!Array.isArray(source)) throw new PublicListApiError('INVALID_BODY', 400);
  const ids = source
    .map(id => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean);
  if (ids.length > 500) throw new PublicListApiError('INVALID_BODY', 400);

  const byPublishedKey = new Map<string, ListEntry>();
  for (const paper of Array.isArray(existing?.papers) ? existing.papers : []) {
    if (!paper || typeof paper.id !== 'string') continue;
    // `sourceId` first: it is the recorded truth. The rest are the guesses
    // that carry documents published before the field existed.
    for (const key of [
      paper.sourceId,
      paper.id,
      paper.doi, paper.doi && `doi:${paper.doi}`,
      paper.arxivId, paper.arxivId && `arxiv:${paper.arxivId}`,
    ]) {
      if (key && !byPublishedKey.has(key)) byPublishedKey.set(key, paper);
    }
  }

  const seen = new Set();
  const papers: ListEntry[] = [];
  let skipped = 0;
  for (const id of ids) {
    // The cap TRUNCATES rather than rejecting. The membership is the Worker's
    // now, so refusing it would leave a 60-paper list unable to sync anything,
    // for ever, instead of publishing the 50 it is allowed.
    if (papers.length >= PUBLIC_LIST_LIMITS.papers) {
      skipped += 1;
      continue;
    }
    const paper = byRawId.get(id)
      || byPublishedKey.get(id)
      || byPublishedKey.get(id.toLowerCase());
    if (!paper) {
      skipped += 1;
      continue;
    }
    if (seen.has(paper.id)) continue;
    seen.add(paper.id);
    papers.push(paper);
  }

  const payload = { ...header, paperCount: papers.length, papers };
  const failures = assertPublicListWithinLimits(payload);
  if (failures.length) {
    throw new PublicListApiError(`INVALID_PAYLOAD_${failures[0]}`, 400);
  }
  // `skipped` never reaches the document; it rides the response so the owner
  // can be told why the public copy is shorter than the list.
  return { payload, listCount: ids.length, skipped };
}

async function reservePublishQuota(env: WorkerEnv, uid: string) {
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

/**
 * Reads the private list and proves the caller owns it. `withMeta` because the
 * publish that follows pins its pointer write to this exact version: the
 * "is it already published?" check and the write that answers it have to be
 * talking about the same version of the document.
 */
async function requireOwnedList(admin: ListAdmin, uid: string, listId: string) {
  const list = await admin.getDocument<PrivateList, true>(['users', uid, 'lists', listId], { withMeta: true });
  if (!list) throw new PublicListApiError('LIST_NOT_FOUND', 404);
  return list;
}

async function requireOwnedShare(admin: ListAdmin, uid: string, shareId: string) {
  const owner = await admin.getDocument<{ ownerId: string; listId: string }>(['publicListOwners', shareId]);
  if (!owner) throw new PublicListApiError('SHARE_NOT_FOUND', 404);
  if (owner.ownerId !== uid) throw new PublicListApiError('NOT_THE_OWNER', 403);
  return owner;
}

// ---------------------------------------------------------------------------
// The three operations. Each one is a pure `validate` and an impure `run`, and
// the split is load-bearing rather than tidy: the dispatcher settles the syntax
// of a request before it reserves a unit of the daily quota, so a body that
// never reaches Firestore cannot spend one.
// ---------------------------------------------------------------------------

function validatePublish(body: ListBody) {
  const listId = requireListId(body.listId);
  return { listId, payload: buildPublicListPayload(body) };
}

/**
 * The `ALREADY_PUBLISHED` check is check-then-act, and the pointer write used to
 * carry no precondition, so two publishes racing both committed: two share ids
 * minted, the pointer left holding the later one, and the other public document
 * alive, readable, owned by nobody the product can reach. Pinning the pointer to
 * the version that answered the check makes the loser's whole commit fail.
 *
 * The retry is not optional. The browser stamps `updatedAt` on the private list
 * at every edit, and the gap between the read and the commit is a full round
 * trip; without it, pinning would trade a rare orphan for a Publish button that
 * fails after an ordinary edit — and unlike the sync engine, `publishPublicList`
 * never retries. On the second read the two cases separate themselves: a
 * `publicShareId` that is now set means a real double publish and is reported as
 * such; anything else was benign churn and simply commits.
 */
async function publish(admin: ListAdmin, uid: string, { listId, payload }: PreparedOperations['/lists/publish'], { cryptoApi, now }: OperationSettings) {
  // Minted once: a refused commit is atomic, so it wrote nothing and the id it
  // would have used is still free.
  const shareId = createShareId(cryptoApi);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const list = await requireOwnedList(admin, uid, listId);
    if (list.data.publicShareId) throw new PublicListApiError('ALREADY_PUBLISHED', 409);

    const timestamp = new Date(now());
    const writes = [
      createWrite(admin.name(['publicListOwners', shareId]), {
        ownerId: uid, listId, createdAt: timestamp,
      }),
      createWrite(admin.name(['publicLists', shareId]), {
        ...payload, createdAt: timestamp, updatedAt: timestamp,
      }),
      // The sync mark is committed with the public copy.
      mergeWrite(admin.name(['users', uid, 'lists', listId]), {
        publicShareId: shareId, publicSyncedAt: timestamp,
      }, { updateTime: list.updateTime }),
    ];
    try {
      await admin.commit(writes);
    } catch (error) {
      if (attempt === 0 && error instanceof FirestoreAdminError && error.status === 409) continue;
      throw error;
    }
    return { shareId, ...payload };
  }
  // Unreachable: the loop returns or throws on every path.
  throw new PublicListApiError('PUBLISH_CONFLICT', 409);
}

function validateUpdate(body: ListBody) {
  return {
    shareId: requireShareId(body.shareId),
    merge: prepareMergeInput(body),
    // Carried whole for the legacy whole-payload branch, the only part of the
    // operation that still reads the request directly.
    body,
  };
}

/**
 * Two attempts, and EVERYTHING the commit is built from is read again on the
 * second one.
 *
 * The merge is a read-modify-write, and it used to carry no version
 * precondition: two tabs syncing at once could each write the list as they
 * found it. The loser's paper was skipped for having no metadata anywhere, and
 * it stayed skipped for ever — the client empties its hydration after a
 * successful sync, so every later sync names that paper by id alone and the
 * merge cannot find it either. Only `skipped > 0` in the response ever said so.
 */
async function update(admin: ListAdmin, uid: string, { shareId, merge, body }: PreparedOperations['/lists/update'], { now }: OperationSettings) {
  const owner = await requireOwnedShare(admin, uid, shareId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The membership comes from the private list, not from the request. One
    // extra read — the same document `publish` already reads — and in exchange
    // no client version, present or past, can shrink a published list by
    // sending a stale idea of what is in it.
    const list = await admin.getDocument<PrivateList>(['users', uid, 'lists', owner.listId]);
    const membership = Array.isArray(list?.paperIds) ? list.paperIds : null;

    let payload;
    let listCount = null;
    let skipped = 0;
    let pinnedTo: string | null | undefined = null;
    if (membership || merge.requestIds) {
      const existing = await admin.getDocument<ListPayload, true>(['publicLists', shareId], { withMeta: true });
      if (!existing) throw new PublicListApiError('SHARE_NOT_FOUND', 404);
      const merged = mergePreparedPayload(merge, existing.data, membership);
      payload = merged.payload;
      listCount = merged.listCount;
      skipped = merged.skipped;
      pinnedTo = existing.updateTime;
    } else {
      // No membership anywhere to merge against: the legacy whole-payload
      // replace, kept for a caller that sends neither. Nothing was read to
      // build it, so there is no lost update to guard and no version to pin.
      payload = buildPublicListPayload(body);
    }

    const timestamp = new Date(now());
    // `description` is always in the mask and only sometimes in the fields: a
    // list that drops its description must lose it from the public document
    // rather than keep the old one. `createdAt` is in neither, so it cannot move.
    const fields = { ...payload, updatedAt: timestamp };
    const write = mergeWrite(
      admin.name(['publicLists', shareId]),
      fields,
      pinnedTo ? { updateTime: pinnedTo } : {},
    );
    write.updateMask = {
      fieldPaths: [...new Set([...Object.keys(fields), 'description'])],
    };

    const writes = [
      write,
      mergeWrite(admin.name(['users', uid, 'lists', owner.listId]), {
        publicSyncedAt: timestamp,
      }),
    ];
    try {
      await admin.commit(writes);
    } catch (error) {
      // A lost precondition is a concurrent writer, not a failure. Read it all
      // again and rebuild; a second loss is the caller's to retry (409).
      if (attempt === 0 && error instanceof FirestoreAdminError && error.status === 409) continue;
      throw error;
    }
    return {
      shareId,
      ...payload,
      // What the owner needs to understand a count that does not match: how many
      // papers the list holds, and how many of them had nothing to publish.
      ...(listCount === null ? {} : { listCount, skipped }),
    };
  }
  // Unreachable: the loop returns or throws on every path.
  throw new PublicListApiError('PUBLISH_CONFLICT', 409);
}

function validateUnpublish(body: ListBody) {
  // `body.listId` is read no more. The share document already records which
  // private list it belongs to, and that record is the only one that can be
  // trusted here: a client working from a stale idea of its own lists could
  // delete share S while clearing the pointer of a DIFFERENT published list,
  // which left one list pointing at a share that no longer exists — neither
  // unpublishable (the ownership lookup 404s) nor deletable (firestore.rules
  // vetoes it) — and another list's public copy unreachable for good. `update`
  // has always taken the id from here; so does this.
  return { shareId: requireShareId(body.shareId) };
}

async function unpublish(admin: ListAdmin, uid: string, { shareId }: PreparedOperations['/lists/unpublish']) {
  const owner = await requireOwnedShare(admin, uid, shareId);

  // The private list loses its pointer in the same commit — and its F12
  // stamps with it: an unpublished list is not on any profile and has no
  // public copy to be in step with. Without the pointer cleanup the owner
  // would be left with a list that claims to be published and a delete rule
  // that refuses to let it go.
  const writes = [
    deleteWrite(admin.name(['publicLists', shareId])),
    deleteWrite(admin.name(['publicListOwners', shareId])),
    clearFieldsWrite(admin.name(['users', uid, 'lists', owner.listId]), [
      'publicShareId', 'onProfile', 'publicSyncedAt',
    ]),
  ];
  await admin.commit(writes);
  return { shareId, unpublished: true };
}

const OPERATIONS: { [Key in OperationPath]: ListOperation<Key> } = {
  '/lists/publish': { validate: validatePublish, run: publish },
  '/lists/update': { validate: validateUpdate, run: update },
  '/lists/unpublish': { validate: validateUnpublish, run: unpublish },
};

export function handlePublicListRequest<Path extends OperationPath>(request: Request, env: WorkerEnv, pathname: Path, options?: ListOptions): Promise<OperationResults[Path]>;
export function handlePublicListRequest(request: Request, env: WorkerEnv, pathname: string, options?: ListOptions): Promise<OperationResults[OperationPath]>;
export async function handlePublicListRequest(request: Request, env: WorkerEnv, pathname: string, options: ListOptions = {}) {
  if (!PUBLIC_LIST_PATHS.has(pathname)) throw new PublicListApiError('NOT_FOUND', 404);
  if (request.method !== 'POST') throw new PublicListApiError('METHOD_NOT_ALLOWED', 405);
  if (!isServiceAccountConfigured(env)) {
    throw new PublicListApiError('PUBLISHING_NOT_CONFIGURED', 503);
  }

  // No cached identity here: this route publishes to the open web.
  const identity = await verifyFirebaseIdentity(request, env, { allowCache: false });
  const body = await readBody(request);
  const operation: ListOperation<OperationPath> = OPERATIONS[pathname as OperationPath];

  // Syntax first, quota second. Refusing a malformed body costs nothing, and
  // charging for it meant a handful of Firebase accounts could spend the whole
  // global daily allowance on rejects and take publishing away from everybody
  // — without paying a single Firestore operation for the privilege.
  //
  // What still charges, on purpose: every failure that DID reach Firestore —
  // LIST_NOT_FOUND, SHARE_NOT_FOUND, NOT_THE_OWNER, ALREADY_PUBLISHED.
  // Each of those spends a read of the free-tier allowance,
  // and this cap is the only thing keeping that allowance bounded.
  const prepared = operation.validate(body);
  await reservePublishQuota(env, identity.uid);

  const admin = options.admin || createFirestoreAdmin(env);
  const settings = {
    cryptoApi: options.cryptoApi || crypto,
    now: options.now || (() => Date.now()),
  };
  try {
    return await operation.run(admin, identity.uid, prepared, settings);
  } catch (error) {
    if (error instanceof FirestoreAdminError || error instanceof FirebaseServiceAccountError) {
      // A lost race on create is the only precondition this route can hit.
      throw new PublicListApiError(
        error.status === 409 ? 'PUBLISH_CONFLICT' : 'PUBLISH_FAILED',
        error.status === 409 ? 409 : 502,
      );
    }
    throw error;
  }
}
