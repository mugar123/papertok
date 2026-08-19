/**
 * Moderation (P7), sized for one human admin.
 *
 * Users create reports and nothing else — the queue, its statuses and every
 * action on reported content belong to the admin uid wired into the rules.
 * Reported content stays visible to everyone while it waits (auto-hiding at
 * N reports would hand any N accounts a censorship button), but the reporter
 * stops seeing it immediately on their own device: that part is client
 * state, persisted locally, not a data-layer fact.
 *
 * The killswitch lives in `config/moderation`: one document the admin can
 * write from a phone, read by the rules on every comment/stub create. No
 * deploy involved in freezing the app's public writes.
 *
 * Nothing here is imported by the feed. A feed load still costs one read.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';

export const REPORT_REASONS = Object.freeze(['spam', 'abuse', 'other', 'dup-stub']);
export const REPORT_NOTE_MAX = 500;
export const REPORT_QUEUE_PAGE_SIZE = 50;
const TARGET_PATH_MAX = 500;
const LOCAL_HIDDEN_KEY = 'papertok:locallyHiddenComments';
const LOCAL_HIDDEN_CAP = 300;

export class ReportUnsupportedError extends Error {
  constructor() {
    super('Reporting is unavailable in demo mode.');
    this.name = 'ReportUnsupportedError';
    this.code = 'REPORTS_UNSUPPORTED_IN_DEMO';
  }
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    document: overrides.document || doc,
    newReportRef: overrides.newReportRef || (database => doc(collection(database, 'reports'))),
    batch: overrides.batch || (database => writeBatch(database)),
    getDocument: overrides.getDocument || getDoc,
    setDocument: overrides.setDocument || setDoc,
    updateDocument: overrides.updateDocument || updateDoc,
    now: overrides.now || serverTimestamp,
    countIncrement: overrides.countIncrement || increment,
    readQueuePage: overrides.readQueuePage || defaultReadQueuePage,
    storage: overrides.storage === undefined ? defaultStorage() : overrides.storage,
  };
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function requireSupported(api) {
  if (api.isDemo) throw new ReportUnsupportedError();
}

function requireViewer(api) {
  const uid = typeof api.currentUser?.uid === 'string' ? api.currentUser.uid : '';
  if (!uid) throw new Error('Authentication is required to report.');
  return uid;
}

/**
 * Only comment documents can be acted on from the queue, so only their paths
 * may enter it. Parsing instead of trusting keeps an admin action from ever
 * writing outside `papers/{key}/comments/{id}` — the queue renders strings a
 * reporter chose, and those strings must not steer the admin's pen.
 */
export function parseCommentTargetPath(targetPath) {
  const value = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!value || value.length > TARGET_PATH_MAX) return null;
  const match = value.match(/^papers\/([A-Za-z0-9_-]+)\/comments\/([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { paperKey: match[1], commentId: match[2] };
}

export function commentTargetPath(paperKey, commentId) {
  return `papers/${paperKey}/comments/${commentId}`;
}

/**
 * Files a report, throttled like every social create (60 s interval, in the
 * same batch). The report is fire-and-forget for the reporter: they can
 * never read it back.
 */
export async function submitReport({ targetPath, targetAuthorUid, reason, note }, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const uid = requireViewer(api);
  if (!REPORT_REASONS.includes(reason)) throw new TypeError('Unknown report reason.');
  const path = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!path || path.length > TARGET_PATH_MAX) throw new TypeError('A target path is required.');
  const authorUid = typeof targetAuthorUid === 'string' ? targetAuthorUid.trim() : '';
  const noteText = typeof note === 'string' ? note.trim().slice(0, REPORT_NOTE_MAX) : '';

  const batch = api.batch(api.database);
  batch.set(api.newReportRef(api.database), {
    reporterUid: uid,
    targetPath: path,
    targetAuthorUid: authorUid,
    reason,
    ...(noteText ? { note: noteText } : {}),
    status: 'open',
    createdAt: api.now(),
  });
  batch.set(
    api.document(api.database, 'users', uid, 'rateLimits', 'reports'),
    { lastAt: api.now(), count: api.countIncrement(1) },
    { merge: true },
  );
  await batch.commit();
}

async function defaultReadQueuePage(database, pageSize) {
  const snapshot = await getDocs(query(
    collection(database, 'reports'),
    where('status', '==', 'open'),
    orderBy('createdAt', 'asc'),
    limit(pageSize),
  ));
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

/** The admin's FIFO queue: oldest open reports first, one bounded page. */
export async function fetchOpenReports(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  return api.readQueuePage(api.database, REPORT_QUEUE_PAGE_SIZE);
}

/** Closes a report either way. Admin-only by rules. */
export async function setReportStatus(reportId, status, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  if (!['open', 'resolved', 'dismissed'].includes(status)) {
    throw new TypeError('Unknown report status.');
  }
  await api.updateDocument(api.document(api.database, 'reports', reportId), { status });
}

/** Hides or shows a reported comment. Admin-only by rules. */
export async function setCommentVisibility(targetPath, visible, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const target = parseCommentTargetPath(targetPath);
  if (!target) throw new TypeError('Not a comment path.');
  await api.updateDocument(
    api.document(api.database, 'papers', target.paperKey, 'comments', target.commentId),
    { status: visible ? 'visible' : 'hidden' },
  );
}

/** The killswitch document; absent means nothing is frozen. */
export async function readModerationConfig(overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const snapshot = await api.getDocument(api.document(api.database, 'config', 'moderation'));
  const data = snapshot?.exists() ? snapshot.data() : {};
  return {
    commentsFrozen: data.commentsFrozen === true,
    annotationsFrozen: data.annotationsFrozen === true,
    relayFrozen: data.relayFrozen === true,
  };
}

/** Flips one killswitch flag. Admin-only by rules; merge keeps the others. */
export async function setCommentsFrozen(frozen, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  await api.setDocument(
    api.document(api.database, 'config', 'moderation'),
    { commentsFrozen: frozen === true, updatedAt: api.now() },
    { merge: true },
  );
}

function readLocalHidden(api) {
  try {
    const raw = api.storage?.getItem(LOCAL_HIDDEN_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The reporter's own view: content they reported disappears for them at
 * once, on this device, while the admin decides for everyone else. Bounded
 * so the stored list cannot grow without limit.
 */
export function locallyHiddenCommentIds(overrides) {
  return new Set(readLocalHidden(operations(overrides)));
}

export function hideCommentLocally(commentId, overrides) {
  const api = operations(overrides);
  if (typeof commentId !== 'string' || !commentId) return;
  const ids = readLocalHidden(api).filter(id => id !== commentId);
  ids.push(commentId);
  try {
    api.storage?.setItem(LOCAL_HIDDEN_KEY, JSON.stringify(ids.slice(-LOCAL_HIDDEN_CAP)));
  } catch {
    // Storage full or unavailable: the report still went through; local
    // hiding is best-effort comfort, not a guarantee.
  }
}
