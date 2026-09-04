import { createSessionCache } from './sessionCache.js';

/**
 * The session caches the profile screens share.
 *
 * They live here rather than inside one component because two screens read the
 * same documents: `/profile` (PublicProfilePage in owner mode) and
 * `/settings/profile` (ProfilePage). Moving between them is the single most
 * common navigation in this part of the app, and with a cache per component
 * each crossing paid for the same read again and sat on a spinner while it
 * happened.
 *
 * Sharing one entry makes the two screens one view of one document, which also
 * makes staleness a real obligation: `rememberOwnProfile` and `forgetOwnProfile`
 * exist so a save or a deletion updates the shared view instead of leaving the
 * other screen to paint what the account no longer says.
 *
 * Keys carry the identity (`own:{uid}` / `handle:{handle}`) so no account can
 * ever be served another account's entry. Nothing here survives a reload.
 */
export const ownProfileCache = createSessionCache({ maxEntries: 8 });
export const ownListsCache = createSessionCache({ maxEntries: 4 });
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
export const listPapersCache = createSessionCache({ maxEntries: 2 });
export const pinnableListsCache = createSessionCache({ maxEntries: 4 });
export const likedExtraCache = createSessionCache({ maxEntries: 4 });
// The showcase (F12): the one `profileLists/{uid}` read a visitor's Listas
// tab costs, keyed by uid so remounts repaint instead of re-reading.
export const showcaseCache = createSessionCache({ maxEntries: 8 });

/**
 * The two follow counters of a profile, keyed by uid.
 *
 * They were the last thing on the profile header still arriving from the
 * network on every single mount. The reason is not slowness, it is the shape of
 * the read: a `count()` aggregation is server-only — Firestore never serves one
 * from the local cache, however warm the channel — so re-entering your own
 * profile paid a full round trip to redraw two numbers that had not moved,
 * while the rest of the header painted instantly from the caches above. Cached,
 * the counters paint with everything else and the aggregation revalidates
 * behind them.
 */
export const followStatsCache = createSessionCache({ maxEntries: 8 });

/**
 * What the follow sheet has loaded for one tab, keyed `{uid}:{mode}`.
 *
 * The sheet unmounts every time it closes, so each open re-read the edge query
 * and every profile behind it — for a list the reader had just been looking at.
 * Rows are stored as uids and re-hydrated from `followRowProfileCache` on the
 * way back in, so a name read once is never awaited again.
 */
export const followListCache = createSessionCache({ maxEntries: 8 });

/**
 * The public profile behind one row of those lists, keyed by uid.
 *
 * Bigger than the other slots because it is the one people actually accumulate:
 * both tabs overlap on mutuals, paging adds thirty at a time, and the same
 * accounts come back on every profile you open. `undefined` is "never asked",
 * `null` is "asked, and that account is gone" — the row renders those two very
 * differently.
 */
export const followRowProfileCache = createSessionCache({ maxEntries: 64 });

export function ownProfileKey(uid) {
  return uid ? `own:${uid}` : null;
}

export function handleProfileKey(handle) {
  return handle ? `handle:${handle}` : null;
}

/**
 * Entries are `{ profile }` wrappers, because "this account has no public
 * profile yet" is a null that is itself worth caching — an absent wrapper
 * means "not asked", which is a different thing.
 */
export function rememberOwnProfile(uid, profile) {
  const key = ownProfileKey(uid);
  if (!key) return;
  ownProfileCache.set(key, { profile });
  // The handle-keyed entry is the same document seen from the public side;
  // leaving the old one behind would serve a renamed profile under its
  // previous name.
  if (profile?.handle) ownProfileCache.set(handleProfileKey(profile.handle), { profile });
}

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

const ownListsReadAt = new Map();

/** Caches a lists read and stamps it fresh. Both readers of the collection use it. */
export function rememberOwnLists(uid, lists) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
  ownListsReadAt.set(uid, Date.now());
}

/** Updates the cached lists in place, without claiming they were re-read. */
export function reviseOwnLists(uid, lists) {
  if (!uid || !Array.isArray(lists)) return;
  ownListsCache.set(uid, lists);
}

/**
 * True when the cached lists are recent enough to skip the read entirely.
 * Pure but for the clock, which is injectable so the tests never wait.
 */
export function ownListsAreFresh(uid, now = Date.now(), ttlMs = OWN_LISTS_FRESH_MS) {
  if (!uid || !ownListsCache.get(uid)) return false;
  const readAt = ownListsReadAt.get(uid);
  return typeof readAt === 'number' && now - readAt < ttlMs;
}

export function forgetOwnLists(uid) {
  if (!uid) return;
  ownListsCache.delete(uid);
  ownListsReadAt.delete(uid);
}

/** The papers this account's lists screen has already resolved. */
export function readListPapers(uid) {
  return uid ? listPapersCache.get(uid) : undefined;
}

/**
 * Folds newly resolved papers into what the account already had.
 *
 * Merged rather than replaced: a list is opened one at a time, and replacing
 * would throw away the previous list's papers on every visit — which is the
 * re-fetching this cache exists to stop.
 */
export function rememberListPapers(uid, papers) {
  if (!uid || !papers || typeof papers !== 'object') return;
  const known = listPapersCache.get(uid);
  listPapersCache.set(uid, known ? { ...known, ...papers } : { ...papers });
}

export function forgetListPapers(uid) {
  if (!uid) return;
  listPapersCache.delete(uid);
}

/**
 * A counter is worth remembering only when it is a real number. The header
 * uses `{ count: null }` as its "the read failed" sentinel, and caching that
 * would turn one bad moment into a dash that outlives it.
 */
function usableStat(stat) {
  return stat && typeof stat.count === 'number' && Number.isFinite(stat.count) ? stat : null;
}

/**
 * Folds whichever counters have landed into the cached pair. Partial by design:
 * the two aggregations are no longer awaited together, so each one writes
 * through the moment it answers.
 */
export function rememberFollowStats(uid, stats) {
  if (!uid || !stats) return;
  const next = { ...(followStatsCache.get(uid) || {}) };
  const followers = usableStat(stats.followers);
  const followed = usableStat(stats.followed);
  if (followers) next.followers = followers;
  if (followed) next.followed = followed;
  if (!next.followers && !next.followed) return;
  followStatsCache.set(uid, next);
}

export function forgetFollowStats(uid) {
  if (!uid) return;
  followStatsCache.delete(uid);
  followListCache.delete(`${uid}:followers`);
  followListCache.delete(`${uid}:following`);
}

export function followListKey(uid, mode) {
  return uid && mode ? `${uid}:${mode}` : null;
}

/** One tab's first page, kept so reopening the sheet repaints instead of reading. */
export function rememberFollowList(uid, mode, page) {
  const key = followListKey(uid, mode);
  if (!key || !page || !Array.isArray(page.rows)) return;
  followListCache.set(key, page);
}

export function readFollowList(uid, mode) {
  const key = followListKey(uid, mode);
  return key ? followListCache.get(key) : undefined;
}

export function forgetOwnProfile(uid, handle) {
  const key = ownProfileKey(uid);
  if (key) ownProfileCache.delete(key);
  if (handle) ownProfileCache.delete(handleProfileKey(handle));
  if (uid) {
    forgetOwnLists(uid);
    pinnableListsCache.delete(uid);
    forgetFollowStats(uid);
  }
}
