import {
  FOLLOW_PAGE_SIZE,
  readFollowedUsersPage,
  readFollowersPage,
} from '../../services/followUserService.js';
import { readUserProfileOverRest } from '../../services/userProfileService.js';
import { isTransientReadError, patientRead, slowNoticeStatus } from '../../utils/boundedRead.js';
import { auth } from '../../services/firebase.js';
import {
  followRowProfileCache,
  ownProfileCache,
  ownProfileKey,
  readFollowList,
  rememberFollowList,
} from '../../utils/profileSessionCaches.js';

/**
 * Loading one tab of the follow sheet: a page of edges as rows, and the
 * account behind each row. Two callers share it — the sheet itself, and the
 * counter on the profile that prefetches on intent — so what a row is, and
 * what may be written into the session caches, is decided in one place.
 *
 * Both reads go over REST (src/utils/firestoreRest.js). The follow sheet is
 * where the SDK's listen stream was measured lying: a stream that had died
 * under a live client answered the edge query with an *empty* page from the
 * cache after ten seconds, and the sheet — and then the session cache —
 * repeated "No followers yet" for an account with a follower until the page
 * was reloaded. A plain request has no cache to answer from, so an empty page
 * here is the server's own word.
 *
 * The second rule is about the rows. A profile read that fails is not an
 * answer either: the old sheet turned any failure into `null`, cached it, and
 * rendered "Account unavailable" for the rest of the tab session — for an
 * account that was merely unreachable for a moment. Here only a deterministic
 * answer settles a row: the document, its confirmed absence, or a denial.
 * Everything transient leaves the row pending and, with patience, is asked
 * again.
 */

const PAGE_READERS = Object.freeze({
  followers: readFollowersPage,
  following: readFollowedUsersPage,
});

export const FOLLOW_MODES = Object.freeze(Object.keys(PAGE_READERS));

/** The tab statuses in which the page is still on its way. */
const WAITING_STATUSES = Object.freeze(['loading', 'slow', 'offline']);

/**
 * What a slow notice may do to a tab's status, or `null` for nothing.
 *
 * `patientRead` reports every transient rejection as slow, and over REST a
 * dead network rejects in a few milliseconds: measured, the sheet said "this
 * is taking longer than usual" 44 ms after opening, before anything had
 * taken long. So a notice only speaks once the wait has been felt
 * (`slowNoticeStatus`) — unless the browser itself says it is offline, which
 * needs no waiting to be true. And it only ever moves between the waiting
 * states: a tab with rows keeps them, and a tab that reached its stalled or
 * failed verdict keeps its Retry button instead of sliding back onto the
 * skeleton with the next retry.
 */
export function nextWaitingStatus(previousStatus, elapsedMs, info) {
  const status = previousStatus ?? 'loading';
  if (!WAITING_STATUSES.includes(status)) return null;
  const notice = slowNoticeStatus(elapsedMs, info);
  return notice && notice !== status ? notice : null;
}

/** Rows carry uids; the names come from whatever the profile cache already holds. */
export function hydrate(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ uid: row.uid, profile: followRowProfileCache.get(row.uid) }));
}

/** One bounded page of edges, as rows the sheet can paint at once. */
export async function readFollowPage(uid, mode, { cursor = null, signal } = {}, overrides) {
  const read = PAGE_READERS[mode];
  if (!read || !uid) return { rows: [], cursor: null, hasMore: false };
  const result = await read(uid, { cursor, pageSize: FOLLOW_PAGE_SIZE, signal }, overrides);
  return { rows: hydrate(result.edges), cursor: result.cursor, hasMore: result.hasMore };
}

/**
 * The account behind each row that has none yet, each one landing on its own.
 * Not a `Promise.all` — one slow profile used to hold up every other name on
 * screen, and there is nothing the reader gains by waiting for the row they
 * were not looking at.
 *
 * `patience` is a `patientRead` options object — bounded attempts, retries
 * behind a backoff, the late answer still delivered — or `null` for a single
 * plain attempt, which is all a prefetch deserves. Either way `onProfile`
 * only ever hears a settled answer; `null` there means "this account is not
 * readable", never "the read did not come back".
 */
export function resolveRowProfiles(rows, { signal, onProfile, patience = null } = {}, overrides) {
  const viewerUid = overrides?.currentUser === undefined
    ? auth.currentUser?.uid
    : overrides.currentUser?.uid;
  (Array.isArray(rows) ? rows : []).filter(row => row.profile === undefined).forEach((row) => {
    const deliver = (profile) => {
      const settled = profile ?? null;
      followRowProfileCache.set(row.uid, settled);
      onProfile?.(row.uid, settled);
    };
    // The reads are anonymous, so no request carries a token and none pays a
    // CORS preflight. The one profile anonymity cannot see is the reader's
    // own while it is private — and that one this tab already holds.
    if (viewerUid && row.uid === viewerUid) {
      const own = ownProfileCache.get(ownProfileKey(viewerUid))?.profile;
      if (own) {
        deliver(own);
        return;
      }
    }
    const read = () => readUserProfileOverRest(row.uid, { signal }, overrides);
    const attempt = patience
      ? patientRead(read, { ...patience, label: `profile ${row.uid}`, signal, onLateResult: deliver })
      : read();
    attempt.then(deliver, (error) => {
      // A dropped request, a timeout, a cancelled read: the row stays pending.
      if (!isTransientReadError(error)) deliver(null);
    });
  });
}

const prefetching = new Set();

/**
 * Warms one tab before the reader asks for it — from the counter's hover or
 * focus — so the sheet opens on rows instead of on a skeleton. One page, one
 * plain attempt per row, and nothing written on failure: a prefetch that did
 * not work simply did not happen.
 */
export function prefetchFollowList(uid, mode, overrides) {
  if (!uid || !PAGE_READERS[mode] || readFollowList(uid, mode)) return;
  const key = `${uid}:${mode}`;
  if (prefetching.has(key)) return;
  prefetching.add(key);
  readFollowPage(uid, mode, {}, overrides)
    .then((page) => {
      rememberFollowList(uid, mode, { ...page, status: 'ready' });
      resolveRowProfiles(page.rows, {}, overrides);
    })
    .catch(() => {})
    .finally(() => prefetching.delete(key));
}
