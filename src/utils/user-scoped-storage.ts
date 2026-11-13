type ScopedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

import type { Paper } from '../models/paper.ts';
import { paperLegacyAdapter, readStoredClassification } from '../models/paper.ts';
import { serializeLibraryPaper } from './reading-library.ts';
import type { OwnList } from './own-lists.ts';
import { MAX_VIEWED_IDS } from './interaction-profile.ts';

const LEGACY_SEEN_PAPERS_KEY = 'papertok_seenIds';
// Until the list held only viewed papers it held every paper a load showed, so
// it names cards that never were on screen. It is read once, to start the new
// list, and swept.
const LOADED_PAPERS_KEY_PREFIX = 'papertok_seenIds:';
const SEEN_PAPERS_KEY_PREFIX = 'papertok_viewedIds:';
const DRIFT_CHECK_KEY_PREFIX = 'papertok_profileDriftCheckedAt:';
const FOLLOW_STATS_KEY_PREFIX = 'papertok_followStats:';
const OWN_LISTS_KEY_PREFIX = 'papertok_ownLists:';
const LIST_PAPERS_KEY_PREFIX = 'papertok_listPapers:';
const OWN_PROFILE_KEY_PREFIX = 'papertok_ownProfile:';
const ONBOARDING_KEY_PREFIX = 'papertok_onboarding:';
const CUSTOM_FEED_DISMISSED_KEY_PREFIX = 'papertok_customFeedDismissed:';
// The comments a reporter chose not to see, from when the app had comments.
// Nothing writes it any more; sign-out still sweeps it so a list left in a
// browser does not outlive the feature.
const LOCAL_HIDDEN_PREFIX = 'papertok:locallyHiddenComments';
// The key this list lived under before it was scoped. Never migrated — one
// browser's two accounts have no shared answer to migrate to — only swept.
const LEGACY_LOCAL_HIDDEN_KEY = LOCAL_HIDDEN_PREFIX;

function getStorage<T extends ScopedStorage>(storage?: T | null) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function getSeenPapersStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${SEEN_PAPERS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/** No uid, no key: an anonymous hide would be a global hide again. */
export function getLocalHiddenStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${LOCAL_HIDDEN_PREFIX}:${encodeURIComponent(userId)}`;
}

export function readSeenPaperIds(userId: string | null | undefined, storage?: ScopedStorage | null): Set<string> {
  const key = getSeenPapersStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return new Set();

  try {
    const parsed = JSON.parse(target.getItem(key) || '[]') as string[] | null;
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function saveSeenPaperIds(userId: string | null | undefined, paperIds: Iterable<string>, storage?: ScopedStorage | null, limit = MAX_VIEWED_IDS) {
  const key = getSeenPapersStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    const ids = Array.from(paperIds || []).slice(-limit);
    target.setItem(key, JSON.stringify(ids));
  } catch {
    // The feed can continue when storage is unavailable or full.
  }
}

export function getDriftCheckStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${DRIFT_CHECK_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * When this device last verified the interaction aggregate against its
 * subcollection. Kept per device rather than in the aggregate so the check needs
 * no extra Firestore write and no schema change.
 */
export function readProfileDriftCheckedAt(userId: string | null, storage?: ScopedStorage | null) {
  const key = getDriftCheckStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return 0;

  try {
    const parsed = Number(target.getItem(key));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function saveProfileDriftCheckedAt(userId: string, timestamp: number, storage?: ScopedStorage | null) {
  const key = getDriftCheckStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    target.setItem(key, String(timestamp));
  } catch {
    // Losing the throttle only means checking again sooner than needed.
  }
}

export function getOwnListsStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${OWN_LISTS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

function getListPapersStorageKey(userId: string) {
  return `${LIST_PAPERS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

const LIST_PAPERS_STORAGE_BYTES = 1_048_576;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCachedPaper(value: unknown): value is Partial<Paper> & { id: string; title: string } {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || typeof value.title !== 'string' || !value.title) return false;
  const textFields = ['primaryCategory', 'published', 'summary', 'arxivId', 'doi', 'journal', 'pdfUrl', 'landingPageUrl'];
  if (textFields.some(key => value[key] !== undefined && typeof value[key] !== 'string')) return false;
  if (value.year !== null && value.year !== undefined && (typeof value.year !== 'number' || !Number.isFinite(value.year))) return false;
  if (typeof value.classificationVersion !== 'number') return false;
  if (!Array.isArray(value.categories) || !value.categories.every(item => typeof item === 'string')) return false;
  if (!Array.isArray(value.authors) || !value.authors.every(item => typeof item === 'string'
    || (isRecord(item) && typeof item.name === 'string'
      && ['id', 'orcid', 'fullName', 'affiliation'].every(key => item[key] === undefined || item[key] === null || typeof item[key] === 'string')))) return false;
  if (value.primaryTopic !== undefined) {
    const topic = value.primaryTopic;
    if (!isRecord(topic) || typeof topic.id !== 'string'
      || (topic.display_name !== undefined && typeof topic.display_name !== 'string')) return false;
    for (const key of ['field', 'subfield', 'domain']) {
      const ref = topic[key];
      if (ref !== undefined && (!isRecord(ref) || typeof ref.id !== 'string' || typeof ref.display_name !== 'string')) return false;
    }
  }
  return true;
}

function cachedAuthors(paper: Partial<Paper>) {
  return (paper.authors || []).map(author => typeof author === 'string' ? author : ({
    name: author.name,
    ...(author.id && { id: author.id }),
    ...(author.orcid && { orcid: author.orcid }),
    ...(author.fullName && { fullName: author.fullName }),
    ...(author.affiliation && { affiliation: author.affiliation }),
  }));
}

/** Only paper metadata: list membership, notes and reading state remain server-owned. */
export function readStoredListPapers(userId: string, storage?: ScopedStorage | null): Record<string, Partial<Paper>> {
  if (!userId) return {};
  try {
    const raw = getStorage(storage)?.getItem(getListPapersStorageKey(userId));
    if (!raw || raw.length * 2 > LIST_PAPERS_STORAGE_BYTES) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.papers)) return {};
    return Object.fromEntries(parsed.papers.filter(isCachedPaper).map(paper => [paper.id, paperLegacyAdapter({
      ...serializeLibraryPaper({ ...paper, authors: cachedAuthors(paper) }),
      ...readStoredClassification(paper),
    })]));
  } catch {
    // Storage may be blocked or contain an incomplete write from an older client.
    return {};
  }
}

export function saveStoredListPapers(userId: string, papers: Record<string, Partial<Paper>>, storage?: ScopedStorage | null, budgetBytes = LIST_PAPERS_STORAGE_BYTES) {
  if (!userId) return;
  try {
    const target = getStorage(storage);
    if (!target) return;
    const entries = [];
    let bytes = 64;
    // Recently received papers go first. Whole entries fit or are left to the next read.
    for (const [id, paper] of Object.entries(papers).reverse()) {
      if (!paper.title || paper.title === id) continue;
      const entry = serializeLibraryPaper({ ...paper, id });
      const stored = { ...entry, authors: cachedAuthors(entry) };
      const size = (JSON.stringify(stored).length + 1) * 2;
      if (bytes + size > budgetBytes) continue;
      bytes += size;
      entries.push(stored);
    }
    target.setItem(getListPapersStorageKey(userId), JSON.stringify({ version: 1, papers: entries.reverse() }));
  } catch {
    // Full or unavailable device storage must not prevent reading the list.
  }
}

// Written by the removed public-profile editor. Nothing writes it now;
// sign-out still sweeps it from devices that stored one.
function getOwnProfileStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${OWN_PROFILE_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * Roughly how much of this device's storage the lists may occupy.
 *
 * Not a guess at a quota — a bound on a payload that scales with the account.
 * The rules cap a list at 500 paper ids and a page at 60 lists, so an extreme
 * account would serialise to something like a third of a megabyte, written on
 * every visit. A realistic one is a few kilobytes. This keeps the extreme from
 * being paid for by everyone.
 */
export const OWN_LISTS_STORAGE_BUDGET_BYTES = 262_144;

/**
 * The owner's lists, as this device last saw them.
 *
 * `ownListsCache` already spares every re-entry within a tab, but it dies on
 * reload — and the first visit after one is exactly where the seam showed:
 * Favorites, Read later and Reading history are assembled from data already in
 * memory and paint in the first frame, while the owner's own lists waited on a
 * read and dropped in behind them. Two of the five cards arriving late is not a
 * slow screen, it is a screen that looks finished before it is.
 *
 * The cost: a list renamed on another device keeps its old name for as long
 * as the read takes. What is NOT accepted is a card that cannot be opened — so
 * a list is stored whole, with its paper ids, or it is not stored at all. A
 * seeded card that opened onto an empty list would be the "we could not find
 * out" lie wearing yet another hat.
 */
export function readStoredLists(userId: string, storage?: ScopedStorage | null): OwnList[] | null {
  const key = getOwnListsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!Array.isArray(parsed)) return null;
    const lists = parsed.filter(entry => (
      entry && typeof entry === 'object'
      && typeof entry.id === 'string' && entry.id
      && Array.isArray(entry.paperIds)
    ));
    return lists.length > 0 ? lists : null;
  } catch {
    return null;
  }
}

export function saveStoredLists(userId: string | undefined, lists: OwnList[] | null | undefined, storage?: ScopedStorage | null, budgetBytes = OWN_LISTS_STORAGE_BUDGET_BYTES) {
  const key = getOwnListsStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !Array.isArray(lists)) return;

  try {
    // Only what a card renders and what opening one needs. `updatedAt` and
    // `publicSyncedAt` are deliberately dropped: they drive the public-sync
    // freshness check, and a stale pair read back from a previous session
    // could make a published list look out of date — or worse, up to date —
    // before the real documents have said anything.
    const stored = [];
    let bytes = 2;
    for (const list of lists) {
      if (!list?.id) continue;
      const entry = {
        id: list.id,
        name: typeof list.name === 'string' ? list.name : '',
        emoji: list.emoji ?? null,
        color: list.color ?? null,
        paperIds: Array.isArray(list.paperIds) ? list.paperIds : [],
        publicShareId: list.publicShareId ?? null,
      };
      const size = JSON.stringify(entry).length + 1;
      // Whole lists, never partial ones: a list that does not fit is simply not
      // seeded, and arrives with the read like it does today.
      if (bytes + size > budgetBytes) break;
      bytes += size;
      stored.push(entry);
    }

    if (stored.length === 0) target.removeItem(key);
    else target.setItem(key, JSON.stringify(stored));
  } catch {
    // A device that cannot store them just pays the read, as before.
  }
}

export function getOnboardingStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${ONBOARDING_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

/**
 * Interests onboarding, as this device last finished it.
 *
 * Firestore's in-memory cache dies on reload. A returning visit then waits on
 * `users/{uid}` before it knows `onboardingComplete`, and a slow or empty
 * answer sent the account through the interest picker again. Remembering the
 * flag here lets the router keep them in the app until the document confirms.
 */
export function readStoredOnboarding(userId: string, storage?: ScopedStorage | null): { complete: boolean; preferences: string[] } | null {
  const key = getOnboardingStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return null;

  try {
    const parsed = JSON.parse(target.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences.filter((value: unknown) => typeof value === 'string')
      : [];
    if (parsed.complete !== true && preferences.length === 0) return null;
    return { complete: parsed.complete === true || preferences.length > 0, preferences };
  } catch {
    return null;
  }
}

export function saveStoredOnboarding(userId: string, state: { preferences?: unknown[]; complete?: boolean }, storage?: ScopedStorage | null) {
  const key = getOnboardingStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target || !state) return;

  try {
    const preferences = Array.isArray(state.preferences)
      ? state.preferences.filter(value => typeof value === 'string')
      : [];
    const complete = state.complete === true || preferences.length > 0;
    if (!complete && preferences.length === 0) {
      target.removeItem(key);
      return;
    }
    target.setItem(key, JSON.stringify({ complete, preferences }));
  } catch {
    // Missing local memory only means the next visit waits on Firestore.
  }
}

/** One key per account for the papers removed from each of its custom feeds (custom-feed-dismissed.ts). */
export function getCustomFeedDismissedStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${CUSTOM_FEED_DISMISSED_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

// Written by the follow counters of the removed profile page. Nothing writes
// it now; sign-out still sweeps it from devices that stored one.
function getFollowStatsStorageKey(userId: string | null | undefined) {
  if (!userId) return null;
  return `${FOLLOW_STATS_KEY_PREFIX}${encodeURIComponent(userId)}`;
}

export function removeLegacySeenPaperIds(storage?: ScopedStorage | null, userId?: string | null) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(LEGACY_SEEN_PAPERS_KEY);
    const viewedKey = getSeenPapersStorageKey(userId);
    if (!viewedKey) return;
    const loadedKey = `${LOADED_PAPERS_KEY_PREFIX}${encodeURIComponent(userId!)}`;
    const loaded = target.getItem(loadedKey);
    target.removeItem(loadedKey);
    // The loaded list includes every paper the reader viewed before the list
    // kept only viewed ones. Starting from nothing would show those again; its
    // cards nobody viewed stay hidden only until views push them out.
    if (loaded === null || target.getItem(viewedKey) !== null) return;
    const ids: unknown = JSON.parse(loaded);
    if (Array.isArray(ids)) saveSeenPaperIds(userId, ids.filter((id): id is string => typeof id === 'string' && id.length > 0), target);
  } catch {
    // Storage cleanup is best effort.
  }
}

export function clearUserScopedStorage(userId: string | undefined, storage?: (ScopedStorage & Pick<Storage, 'key' | 'length'>) | null) {
  const target = getStorage(storage);
  if (!target || !userId) return;
  const encodedUserId = encodeURIComponent(userId);
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const exactKeys = new Set([
    getSeenPapersStorageKey(userId),
    `${LOADED_PAPERS_KEY_PREFIX}${encodedUserId}`,
    getDriftCheckStorageKey(userId),
    getFollowStatsStorageKey(userId),
    getOwnListsStorageKey(userId),
    getListPapersStorageKey(userId),
    getOwnProfileStorageKey(userId),
    getOnboardingStorageKey(userId),
    getCustomFeedDismissedStorageKey(userId),
    getLocalHiddenStorageKey(userId),
    LEGACY_LOCAL_HIDDEN_KEY,
    `papertok_following_${safeUserId}`,
    `papertok_following_updates_${safeUserId}`,
    `papertok_readingLibrary_${userId}`,
  ]);
  const feedPrefix = `papertok_feed_snapshot_${encodedUserId}_`;

  try {
    const keys = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key) keys.push(key);
    }
    keys.filter(key => exactKeys.has(key) || key.startsWith(feedPrefix))
      .forEach(key => target.removeItem(key));
  } catch {
    // Cleanup must not prevent Firebase from ending the session.
  }
}
