/**
 * Comments on papers (P6): threads under `papers/{paperKey}/comments`.
 *
 * The shape of every write here is pinned by `firestore.rules`:
 *
 *   - a create travels in a batch with its throttle stamp
 *     (`users/{uid}/rateLimits/comments`), and with the stub when it is the
 *     paper's first comment — three documents, one atomic commit;
 *   - the author's handle is a denormalized snapshot the rules verify
 *     against the live profile, so it cannot be someone else's name;
 *   - a private profile cannot comment (commenting is a public act) —
 *     enforced by the rules, explained by the UI;
 *   - deleting a parent takes its replies with it. The first batch carries
 *     the parent plus a page of replies; if more pages remain they are
 *     swept as orphans (parent already gone), each batch bounded. A crash
 *     between batches leaves only invisible, sweepable leftovers — replies
 *     never render without their parent — and a retry finishes the job.
 *
 * Threads are read oldest-first ON PURPOSE: a reply always postdates its
 * parent, so in ascending order a parent is always on-screen (or earlier)
 * before its replies arrive. One query, no denormalized reply counts, no
 * reply ever waiting for a parent stuck in a later page.
 *
 * Counts are capped `count()` aggregations, the F2 pattern — there is no
 * client-written counter for a cascade delete to corrupt.
 *
 * Nothing here is imported by the feed. A feed load still costs one read.
 */

import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';
import { buildPaperStubData } from './paperStubService.js';

export const COMMENT_PAGE_SIZE = 20;
export const COMMENT_TEXT_MAX = 4000;
/** Same 1000-entry cap as follows: one billed read per count, forever. */
export const COMMENT_COUNT_CAP = 1000;
/** Mirrors the rules intervals; used only to phrase errors, never to enforce. */
export const COMMENT_INTERVAL_SECONDS = 15;
/** A parent and up to this many replies fit one atomic batch (cap is 500). */
const CASCADE_PAGE_SIZE = 400;
const MY_COMMENTS_PAGE_SIZE = 30;

export class CommentUnsupportedError extends Error {
  constructor() {
    super('Comments are unavailable in demo mode.');
    this.name = 'CommentUnsupportedError';
    this.code = 'COMMENTS_UNSUPPORTED_IN_DEMO';
  }
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    document: overrides.document || doc,
    newCommentRef: overrides.newCommentRef
      || ((database, paperKey) => doc(collection(database, 'papers', paperKey, 'comments'))),
    batch: overrides.batch || (database => writeBatch(database)),
    getDocument: overrides.getDocument || getDoc,
    setDocument: overrides.setDocument || setDoc,
    updateDocument: overrides.updateDocument || updateDoc,
    deleteDocument: overrides.deleteDocument || deleteDoc,
    now: overrides.now || serverTimestamp,
    countIncrement: overrides.countIncrement || increment,
    // The query shapes travel as a unit so the unit tests run without a
    // Firestore, exactly like followUserService.
    readThreadPage: overrides.readThreadPage || defaultReadThreadPage,
    readReplyPage: overrides.readReplyPage || defaultReadReplyPage,
    countThread: overrides.countThread || defaultCountThread,
    readAuthorPage: overrides.readAuthorPage || defaultReadAuthorPage,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new CommentUnsupportedError();
}

function requireViewer(api) {
  const uid = typeof api.currentUser?.uid === 'string' ? api.currentUser.uid : '';
  if (!uid) throw new Error('Authentication is required to comment.');
  return uid;
}

function commentReference(api, paperKey, commentId) {
  return api.document(api.database, 'papers', paperKey, 'comments', commentId);
}

function stampInto(batch, api, uid, action) {
  // `merge` makes the same call a create the first time and an update after,
  // which is exactly the pair of rules that implements the interval.
  batch.set(
    api.document(api.database, 'users', uid, 'rateLimits', action),
    { lastAt: api.now(), count: api.countIncrement(1) },
    { merge: true },
  );
}

function cleanCommentText(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw new TypeError('A comment needs text.');
  if (value.length > COMMENT_TEXT_MAX) {
    throw new TypeError(`A comment cannot exceed ${COMMENT_TEXT_MAX} characters.`);
  }
  return value;
}

/**
 * Publishes a comment — the full batch the rules expect. `anchor` comes from
 * `resolveThreadAnchor`; when the stub does not exist yet it is created in
 * the same commit, from the same paper object, so the thread and its first
 * message are born together or not at all.
 */
export async function createComment({ anchor, paper, authorHandle, text, replyTo = null }, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireViewer(api);
  if (!anchor?.key) throw new TypeError('A thread anchor is required.');
  const handle = typeof authorHandle === 'string' ? authorHandle.trim() : '';
  if (!handle) throw new TypeError('The author handle snapshot is required.');
  const body = {
    authorUid: uid,
    authorHandle: handle,
    text: cleanCommentText(text),
    status: 'visible',
    createdAt: api.now(),
    ...(typeof replyTo === 'string' && replyTo ? { replyTo } : {}),
  };

  const batch = api.batch(api.database);
  if (!anchor.stubExists) {
    const stubData = buildPaperStubData(paper);
    if (!stubData || `${stubData.canonicalKey}` !== anchor.identity) {
      throw new TypeError('This paper cannot anchor a public thread.');
    }
    batch.set(api.document(api.database, 'papers', anchor.key), {
      ...stubData,
      createdAt: api.now(),
      createdBy: uid,
    });
    stampInto(batch, api, uid, 'stubs');
  }
  const commentRef = api.newCommentRef(api.database, anchor.key);
  batch.set(commentRef, body);
  stampInto(batch, api, uid, 'comments');
  await batch.commit();
  return { id: commentRef.id, comment: { ...body, createdAt: new Date() } };
}

/** The author rewrites their text; the server clock marks the edit. */
export async function editComment(paperKey, commentId, text, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  requireViewer(api);
  await api.updateDocument(commentReference(api, paperKey, commentId), {
    text: cleanCommentText(text),
    editedAt: api.now(),
  });
}

/**
 * Deletes a comment. A reply is one delete; a parent is the cascade: parent
 * plus a page of replies atomically, then bounded orphan sweeps for anything
 * beyond the first page. Safe to re-run — sweeping is idempotent.
 */
export async function deleteComment({ paperKey, commentId, isReply = false }, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  requireViewer(api);

  if (isReply) {
    await api.deleteDocument(commentReference(api, paperKey, commentId));
    return { deleted: 1 };
  }

  let deleted = 0;
  let parentPending = true;
  for (;;) {
    const replies = await api.readReplyPage(api.database, paperKey, commentId, CASCADE_PAGE_SIZE);
    if (!parentPending && !replies.length) break;
    const batch = api.batch(api.database);
    if (parentPending) batch.delete(commentReference(api, paperKey, commentId));
    for (const reply of replies) {
      batch.delete(commentReference(api, paperKey, reply.id));
    }
    await batch.commit();
    deleted += replies.length + (parentPending ? 1 : 0);
    parentPending = false;
    if (replies.length < CASCADE_PAGE_SIZE) break;
  }
  return { deleted };
}

async function defaultReadThreadPage(database, paperKey, pageSize, cursor) {
  const snapshot = await getDocs(query(
    collection(database, 'papers', paperKey, 'comments'),
    orderBy('createdAt', 'asc'),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({
    id: document.id, data: document.data(), cursor: document,
  }));
}

async function defaultReadReplyPage(database, paperKey, parentId, pageSize) {
  const snapshot = await getDocs(query(
    collection(database, 'papers', paperKey, 'comments'),
    where('replyTo', '==', parentId),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
}

async function defaultCountThread(database, paperKey) {
  const snapshot = await getCountFromServer(query(
    collection(database, 'papers', paperKey, 'comments'),
    limit(COMMENT_COUNT_CAP),
  ));
  return snapshot.data().count;
}

async function defaultReadAuthorPage(database, uid, pageSize, cursor) {
  const snapshot = await getDocs(query(
    collectionGroup(database, 'comments'),
    where('authorUid', '==', uid),
    orderBy('createdAt', 'desc'),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({
    id: document.id,
    data: document.data(),
    // papers/{paperKey}/comments/{id} — the grandparent names the thread.
    paperKey: document.ref.parent.parent?.id ?? null,
    cursor: document,
  }));
}

/**
 * One bounded page of a thread, oldest first (see the header for why), with
 * an opaque cursor for the next page.
 */
export async function fetchThreadPage(paperKey, { cursor = null, pageSize } = {}, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const size = Number.isInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, COMMENT_PAGE_SIZE)
    : COMMENT_PAGE_SIZE;
  const rows = await api.readThreadPage(api.database, paperKey, size, cursor);
  const comments = rows.map(row => ({ id: row.id, ...row.data }));
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    comments,
    cursor: rows.length >= size ? (last?.cursor ?? null) : null,
    hasMore: rows.length >= size,
  };
}

/** One comment by id — the moderation queue resolving a reported target. */
export async function fetchComment(paperKey, commentId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const snapshot = await api.getDocument(commentReference(api, paperKey, commentId));
  return snapshot?.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

/** Capped thread size: one read, `1000+` past the cap. */
export async function fetchCommentCount(paperKey, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const raw = await api.countThread(api.database, paperKey);
  const count = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
  return { count: Math.min(count, COMMENT_COUNT_CAP), capped: count >= COMMENT_COUNT_CAP };
}

/**
 * One bounded page of the signed-in account's own comments across all
 * papers, newest first — including hidden ones, which is where an author
 * learns a comment of theirs was moderated.
 */
export async function fetchMyCommentsPage({ cursor = null, pageSize } = {}, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireViewer(api);
  const size = Number.isInteger(pageSize) && pageSize > 0
    ? Math.min(pageSize, MY_COMMENTS_PAGE_SIZE)
    : MY_COMMENTS_PAGE_SIZE;
  const rows = await api.readAuthorPage(api.database, uid, size, cursor);
  const comments = rows.map(row => ({ id: row.id, paperKey: row.paperKey, ...row.data }));
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    comments,
    cursor: rows.length >= size ? (last?.cursor ?? null) : null,
    hasMore: rows.length >= size,
  };
}

/**
 * Groups a thread's rows into render order: top-level comments in arrival
 * order, each carrying its replies. A reply whose parent is not in `rows`
 * (possible only for moderated-away or mid-sweep parents) is dropped rather
 * than rendered floating. Pure; exported for tests and for the sheet.
 */
export function groupThread(rows) {
  const topLevel = [];
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id || row.replyTo) continue;
    const entry = { ...row, replies: [] };
    byId.set(row.id, entry);
    topLevel.push(entry);
  }
  for (const row of rows) {
    if (!row?.id || !row.replyTo) continue;
    byId.get(row.replyTo)?.replies.push(row);
  }
  return topLevel;
}
