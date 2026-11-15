import type { OwnList } from './own-lists.ts';
import type { Paper } from '../models/paper.ts';

import { mergeListPaperCopies } from './list-paper-copies.ts';
import { readStoredListPapers, saveStoredListPapers } from './user-scoped-storage.ts';
import { createSessionCache } from './session-cache.ts';

/**
 * The session caches the account's own screens share.
 *
 * They live here rather than inside one component because several screens read
 * the same documents: the lists page and the save modal read the lists. With a
 * cache per component each crossing paid for the same read again and sat on a
 * spinner while it happened.
 *
 * Keys carry the uid so no account can ever be served another account's entry.
 * Paper metadata also survives reloads in bounded, account-scoped device storage.
 */
export const ownListsCache = createSessionCache<OwnList[]>({ maxEntries: 4 });
/**
 * Paper metadata the lists screen has already paid for, keyed by uid.
 *
 * `savedPapers` on that screen is plain component state, so leaving a list to
 * read a paper and coming back re-fetched every document the tab had in its
 * hands seconds earlier — and Firestore's own cache cannot cover it, because
 * `firebase.js` deliberately keeps the in-memory one with no persistence.
 *
 * One entry per account rather than per paper: the value is the whole
 * `{ [paperId]: paper }` map, which is what the screen seeds its state from, and
 * an LRU over individual papers would evict the middle of a list.
 */
export const listPapersCache = createSessionCache<Record<string, Partial<Paper>>>({ maxEntries: 2 });

/**
 * How long a lists read stays good enough to reuse without asking again.
 *
 * Saving papers in a burst is the case this exists for: the save modal opens
 * once per paper, and every open used to re-read all sixty list documents.
 * Fifty saves meant fifty full re-reads on a channel already carrying a write
 * per save to the same document, and that is what saturated into an endless
 * skeleton. Inside this window the modal trusts what it has.
 *
 * Correctness comes from write-through, not from luck: `handleSave` folds its
 * own edit into the cached lists before the window expires, and the lists page
 * stamps the cache from its own authoritative read. What is left is a list
 * renamed on ANOTHER device going unnoticed for at most this long — a price
 * worth one thirtieth of the reads.
 */
export const OWN_LISTS_FRESH_MS = 30_000;

const ownListsReadAt = new Map<string, number>();

/** Caches a lists read and stamps it fresh. Both readers of the collection use it. */
export function rememberOwnLists(uid: string | undefined, lists: OwnList[]) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
  ownListsReadAt.set(uid, Date.now());
}

/** Updates the cached lists in place, without claiming they were re-read. */
export function reviseOwnLists(uid: string | undefined, lists: OwnList[]) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
}

/**
 * True when the cached lists are recent enough to skip the read entirely.
 * Pure but for the clock, which is injectable so the tests never wait.
 */
export function ownListsAreFresh(uid: string, now = Date.now(), ttlMs = OWN_LISTS_FRESH_MS) {
  if (!uid || !ownListsCache.get(uid)) return false;
  const readAt = ownListsReadAt.get(uid);
  return typeof readAt === 'number' && now - readAt < ttlMs;
}

export function forgetOwnLists(uid: string | undefined) {
  if (!uid) return;
  ownListsCache.delete(uid);
  ownListsReadAt.delete(uid);
}

/** The papers this account's lists screen has already resolved. */
export function readListPapers(uid: string, storage?: Parameters<typeof readStoredListPapers>[1]) {
  if (!uid) return undefined;
  let papers = listPapersCache.get(uid);
  if (!papers) {
    papers = readStoredListPapers(uid, storage);
    listPapersCache.set(uid, papers);
  }
  return papers;
}

/**
 * Folds newly resolved papers into what the account already had.
 *
 * Merged rather than replaced: a list is opened one at a time, and replacing
 * would throw away the previous list's papers on every visit — which is the
 * re-fetching this cache exists to stop. Each copy is merged by the rule the
 * screen's own state uses (`mergeListPaperCopies`), so the next visit is
 * seeded with the copy the screen showed, not the one that arrived last.
 */
export function rememberListPapers(uid: string, papers: Record<string, Partial<Paper>>, source: 'saved' | 'interaction', storage?: Parameters<typeof saveStoredListPapers>[2]) {
  if (!uid || !papers || typeof papers !== 'object') return;
  const merged = mergeListPaperCopies(readListPapers(uid, storage) ?? {}, papers, source);
  // Move received entries to the end so the bounded device copy keeps them first.
  const next = { ...merged };
  for (const id of Object.keys(papers)) {
    delete next[id];
    next[id] = merged[id];
  }
  listPapersCache.set(uid, next);
  saveStoredListPapers(uid, next, storage);
}

/**
 * The papers whose `savedPapers` read has answered this session, keyed by
 * uid: the document came back, or the server confirmed there is none. Until
 * it has, a paper the lists hold no field or date for is read again
 * (`listPaperNeedsRead`), so a failed read stays retryable.
 */
const listSavedAnswers = createSessionCache<Set<string>>({ maxEntries: 2 });

export function rememberSavedAnswers(uid: string, paperIds: string[]) {
  if (!uid || paperIds.length === 0) return;
  listSavedAnswers.set(uid, new Set([...(listSavedAnswers.get(uid) ?? []), ...paperIds]));
}

export function savedAnswered(uid: string | undefined, paperId: string) {
  return Boolean(uid && listSavedAnswers.get(uid)?.has(paperId));
}

/**
 * The papers the lists asked a provider the field of this session
 * (`readPaperFields`) and got an answer for, keyed by uid, so a paper the
 * provider does not name is not asked on every visit to its list. A paper
 * whose arXiv request failed is left out and asked again.
 */
const listFieldAnswers = createSessionCache<Set<string>>({ maxEntries: 2 });

export function rememberFieldAnswers(uid: string, paperIds: string[]) {
  if (!uid || paperIds.length === 0) return;
  listFieldAnswers.set(uid, new Set([...(listFieldAnswers.get(uid) ?? []), ...paperIds]));
}

export function fieldAnswered(uid: string | undefined, paperId: string) {
  return Boolean(uid && listFieldAnswers.get(uid)?.has(paperId));
}

/** End the account's paper session, including the answers that suppress reads. */
export function forgetListPapers(uid: string | undefined) {
  if (!uid) return;
  listPapersCache.delete(uid);
  listSavedAnswers.delete(uid);
  listFieldAnswers.delete(uid);
}
