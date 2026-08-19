/**
 * Following other users (F2).
 *
 * One document per edge in `follows/{followerUid}_{targetUid}`. The composite
 * id carries the whole design:
 *
 *   - the edge cannot be duplicated, because the second create lands on a
 *     document that already exists and Firestore refuses it;
 *   - unfollowing is a delete by id, no query, no index;
 *   - "do I follow this person" is one `get`, not a search.
 *
 * This is deliberately NOT `users/{uid}/following`. That subcollection is
 * private, owner-only, and models external entities (authors, topics,
 * institutions) that feed the ranking. Follower lists have to be readable by
 * other people, which a private subcollection cannot do without breaking the
 * contract the feed depends on. The header counter labelled "Following" keeps
 * showing that subcollection; this file never touches it.
 *
 * Nothing here is imported by the feed. A feed load still costs one read.
 */

import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  where,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';

/** One page of a follower or following list. Matches the plan's `limit(30)`. */
export const FOLLOW_PAGE_SIZE = 30;

/**
 * The counters are `count()` aggregations, and they are capped.
 *
 * Firestore bills an aggregation as one read per 1000 index entries scanned, so
 * a cap of exactly 1000 makes a counter cost exactly one read, forever, no
 * matter how large the graph gets — the property that matters here, since the
 * counters render on every profile visit. Past the cap the UI says "1000+",
 * which is honest rather than wrong.
 *
 * `firestore.rules` refuses any query on `follows` whose limit exceeds this, so
 * the ceiling is enforced by the database and not merely by this file. The
 * documented escalation if a profile ever really passes it is the reserved
 * `followerCount` field, maintained by the service identity — which is why that
 * field stays frozen for clients in the rules.
 */
export const FOLLOW_COUNT_CAP = 1000;

/** Uids that cannot contain the `_` separator, matching `validFollowUid`. */
const UID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export class FollowUnsupportedError extends Error {
  constructor() {
    super('Following users is unavailable in demo mode.');
    this.name = 'FollowUnsupportedError';
    this.code = 'FOLLOWS_UNSUPPORTED_IN_DEMO';
  }
}

export class SelfFollowError extends Error {
  constructor() {
    super('An account cannot follow itself.');
    this.name = 'SelfFollowError';
    this.code = 'FOLLOW_SELF';
  }
}

function cleanUid(value) {
  const uid = typeof value === 'string' ? value.trim() : '';
  return UID_PATTERN.test(uid) ? uid : '';
}

/**
 * The edge id. Exported because the rules derive the same string from
 * `request.auth.uid` and the body, and a test asserts the two agree.
 */
export function followEdgeId(followerUid, targetUid) {
  const follower = cleanUid(followerUid);
  const target = cleanUid(targetUid);
  if (!follower || !target) return '';
  return `${follower}_${target}`;
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    document: overrides.document || doc,
    getDocument: overrides.getDocument || getDoc,
    setDocument: overrides.setDocument || setDoc,
    deleteDocument: overrides.deleteDocument || deleteDoc,
    now: overrides.now || serverTimestamp,
    // The three query shapes are injected as a unit so the unit tests can run
    // without a Firestore, exactly like `publishedLists` in userProfileService.
    countEdges: overrides.countEdges || defaultCountEdges,
    readEdgePage: overrides.readEdgePage || defaultReadEdgePage,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new FollowUnsupportedError();
}

function requireViewer(api) {
  const uid = cleanUid(api.currentUser?.uid);
  if (!uid) throw new Error('Authentication is required to follow a user.');
  return uid;
}

function edgeReference(api, edgeId) {
  return api.document(api.database, 'follows', edgeId);
}

/**
 * A capped `count()`. One read, always: the cap is the same 1000 entries
 * Firestore bills as a single read, and the rules reject anything larger.
 */
async function defaultCountEdges(database, field, uid) {
  const snapshot = await getCountFromServer(query(
    collection(database, 'follows'),
    where(field, '==', uid),
    limit(FOLLOW_COUNT_CAP),
  ));
  return snapshot.data().count;
}

/**
 * One bounded page, newest first. `startAfter` takes the raw document snapshot
 * of the last row, which is why the cursor travels back out of here opaque.
 */
async function defaultReadEdgePage(database, field, uid, pageSize, cursor) {
  const constraints = [
    where(field, '==', uid),
    orderBy('createdAt', 'desc'),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(pageSize),
  ];
  const snapshot = await getDocs(query(collection(database, 'follows'), ...constraints));
  return snapshot.docs.map(document => ({
    id: document.id,
    data: document.data(),
    cursor: document,
  }));
}

function boundedPageSize(requested) {
  const size = Number.isInteger(requested) && requested > 0 ? requested : FOLLOW_PAGE_SIZE;
  return Math.min(size, FOLLOW_PAGE_SIZE);
}

/**
 * Follows `targetUid`.
 *
 * Idempotent by design and by repair: the composite id means a second follow
 * writes the same document, and the rules answer that with `permission-denied`
 * because an edge has no mutable state (`allow update: if false`). A denial is
 * only reported as a failure once a read has confirmed the edge is not already
 * the caller's — otherwise a double click would surface an error for a state
 * that is exactly what the user asked for.
 */
export async function followUser(targetUid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const followerUid = requireViewer(api);
  const target = cleanUid(targetUid);
  if (!target) throw new TypeError('A target user is required.');
  if (target === followerUid) throw new SelfFollowError();

  const edgeId = followEdgeId(followerUid, target);
  try {
    await api.setDocument(edgeReference(api, edgeId), {
      followerUid,
      targetUid: target,
      createdAt: api.now(),
    });
    return { following: true, changed: true };
  } catch (error) {
    if (error?.code !== 'permission-denied') throw error;
    const existing = await api.getDocument(edgeReference(api, edgeId));
    if (existing?.exists() && existing.data()?.followerUid === followerUid) {
      return { following: true, changed: false };
    }
    throw error;
  }
}

/**
 * Unfollows `targetUid`. Same idempotency: deleting an edge that is not there
 * is denied by the rules (there is no `resource` to own), and that denial means
 * "already unfollowed" only once a read says the document really is absent.
 */
export async function unfollowUser(targetUid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const followerUid = requireViewer(api);
  const target = cleanUid(targetUid);
  if (!target) throw new TypeError('A target user is required.');

  const edgeId = followEdgeId(followerUid, target);
  try {
    await api.deleteDocument(edgeReference(api, edgeId));
    return { following: false, changed: true };
  } catch (error) {
    if (error?.code !== 'permission-denied') throw error;
    const existing = await api.getDocument(edgeReference(api, edgeId));
    if (!existing?.exists()) return { following: false, changed: false };
    throw error;
  }
}

/** One read, and only for a signed-in visitor looking at somebody else. */
export async function isFollowing(targetUid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const followerUid = cleanUid(api.currentUser?.uid);
  const target = cleanUid(targetUid);
  if (!followerUid || !target || followerUid === target) return false;
  const snapshot = await api.getDocument(edgeReference(api, followEdgeId(followerUid, target)));
  return Boolean(snapshot?.exists());
}

function cappedCount(count) {
  const value = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return { count: Math.min(value, FOLLOW_COUNT_CAP), capped: value >= FOLLOW_COUNT_CAP };
}

/** How many accounts follow `uid`. One read. */
export async function countFollowers(uid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const target = cleanUid(uid);
  if (!target) return { count: 0, capped: false };
  return cappedCount(await api.countEdges(api.database, 'targetUid', target));
}

/** How many accounts `uid` follows. One read. Users only — never entities. */
export async function countFollowedUsers(uid, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const follower = cleanUid(uid);
  if (!follower) return { count: 0, capped: false };
  return cappedCount(await api.countEdges(api.database, 'followerUid', follower));
}

function toPage(rows, field, pageSize) {
  const edges = (Array.isArray(rows) ? rows : [])
    .slice(0, pageSize)
    .map(row => ({ uid: cleanUid(row?.data?.[field]), createdAt: row?.data?.createdAt ?? null }))
    .filter(edge => edge.uid);
  const last = Array.isArray(rows) && rows.length ? rows[Math.min(rows.length, pageSize) - 1] : null;
  return {
    edges,
    // A short page is the end of the list; a full one may or may not be, and
    // asking costs nothing until the reader presses for more.
    cursor: rows?.length >= pageSize ? (last?.cursor ?? null) : null,
    hasMore: rows?.length >= pageSize,
  };
}

/** One bounded page of the accounts following `uid`, newest first. */
export async function readFollowersPage(uid, { cursor = null, pageSize } = {}, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const target = cleanUid(uid);
  const size = boundedPageSize(pageSize);
  if (!target) return { edges: [], cursor: null, hasMore: false };
  const rows = await api.readEdgePage(api.database, 'targetUid', target, size, cursor);
  return toPage(rows, 'followerUid', size);
}

/** One bounded page of the accounts `uid` follows, newest first. */
export async function readFollowedUsersPage(uid, { cursor = null, pageSize } = {}, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const follower = cleanUid(uid);
  const size = boundedPageSize(pageSize);
  if (!follower) return { edges: [], cursor: null, hasMore: false };
  const rows = await api.readEdgePage(api.database, 'followerUid', follower, size, cursor);
  return toPage(rows, 'targetUid', size);
}
