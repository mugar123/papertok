/**
 * Telling apart the reload the reader asked for from the one the app forced.
 *
 * The feed deliberately survives a reload: `utils/feedResumeMemory.js` keeps
 * the card it was left on in sessionStorage, and `context/FeedContext.jsx`
 * keeps a snapshot of the papers themselves in localStorage for 15 minutes.
 * Both exist because the app reloads the tab WITHOUT BEING ASKED — twice over:
 *
 *   - `main.jsx` reloads on `vite:preloadError`, when a deploy has taken away
 *     the chunk an `import()` was reaching for;
 *   - the service worker takes control on `activated` after a deploy and
 *     workbox reloads the page itself (see the long note in `main.jsx`).
 *
 * Either can land mid-reading-session. Dropping the reader at the top of a
 * freshly ranked feed there reads as the whole app having lost their place,
 * which is the bug the continuity was built to fix.
 *
 * But it also caught the reload the reader DID ask for. Pressing the browser's
 * reload button and getting the same paper back is the opposite failure: the
 * one gesture everyone uses to mean "give me this again, properly" was the one
 * gesture that changed nothing.
 *
 * So the app marks its own reloads on the way out, and a boot that finds no
 * mark treats a reload as the reader's. A mark is consumed when it is read, so
 * it can never make a later, genuine reload look forced.
 */

import { FEED_RESUME_STORAGE_PREFIX } from './feedResumeMemory.js';
import { FOLLOWING_ORDER_STORAGE_KEY } from './followingOrderStorage.js';

export const APP_RELOAD_KEY = 'papertok_app_forced_reload_at';

/** The snapshot's own prefix, from `context/FeedContext.jsx`. */
export const FEED_SNAPSHOT_STORAGE_PREFIX = 'papertok_feed_snapshot_';

/**
 * How stale a mark may be and still describe THIS boot.
 *
 * The mark is written in the same task as `location.reload()`, so on the next
 * boot it is a page load old — under a second on any connection, since the
 * document is served before any of this runs. A minute is generous enough to
 * absorb a slow reload and short enough that a mark left by a crash cannot
 * quietly swallow a reader's reload minutes later. It is consumed on read
 * regardless, so at most one reload can ever be misread.
 */
const MARK_WINDOW_MS = 60_000;

function safeSession() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function safeLocal() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Called immediately before the app reloads itself. */
export function markAppForcedReload({ storage = safeSession(), now = Date.now() } = {}) {
  if (!storage) return;
  try {
    storage.setItem(APP_RELOAD_KEY, String(now));
  } catch {
    // No storage means every reload reads as the reader's, which is the safer
    // way to be wrong: at worst they get the fresh feed they asked for.
  }
}

/**
 * Whether the reload that produced this boot was the app's own. Consumes the
 * mark, so it answers true at most once per mark.
 */
export function consumeAppForcedReload({ storage = safeSession(), now = Date.now() } = {}) {
  if (!storage) return false;
  let raw;
  try {
    raw = storage.getItem(APP_RELOAD_KEY);
    storage.removeItem(APP_RELOAD_KEY);
  } catch {
    return false;
  }
  const at = Number(raw);
  return Number.isFinite(at) && at > 0 && now - at >= 0 && now - at < MARK_WINDOW_MS;
}

/**
 * Whether this document was reached by a reload at all.
 *
 * `PerformanceNavigationTiming.type` is the only reading that survives a
 * HashRouter: `navigate` on a first visit or a link, `reload` on either kind of
 * reload, `back_forward` on a history step. It cannot tell WHICH kind of
 * reload, which is what the mark is for.
 */
export function isReloadNavigation({ perf = typeof performance !== 'undefined' ? performance : null } = {}) {
  try {
    const entry = perf?.getEntriesByType?.('navigation')?.[0];
    return entry?.type === 'reload';
  } catch {
    return false;
  }
}

/**
 * The decision, kept separate from the reading of it so it can be tested
 * without a browser: a reload the reader asked for starts the feed fresh.
 */
export function shouldStartFeedFresh({ isReload, wasAppForced }) {
  return Boolean(isReload) && !wasAppForced;
}

/**
 * Drop everything that would make the feed come back as it was: the card each
 * surface was left on, the order the Following feed left with, and the
 * snapshot of the papers themselves. What remains — the reader's interactions,
 * their profile, their seen-set — is not continuity, it is their data.
 */
export function clearFeedContinuity({ session = safeSession(), local = safeLocal() } = {}) {
  const removed = [];
  const sweep = (storage, matches) => {
    if (!storage) return;
    let keys;
    try {
      keys = Object.keys(storage);
    } catch {
      return;
    }
    for (const key of keys) {
      if (!matches(key)) continue;
      try {
        storage.removeItem(key);
        removed.push(key);
      } catch {
        // A key that will not go is not worth failing a boot over.
      }
    }
  };
  sweep(session, (key) => key.startsWith(FEED_RESUME_STORAGE_PREFIX) || key === FOLLOWING_ORDER_STORAGE_KEY);
  sweep(local, (key) => key.startsWith(FEED_SNAPSHOT_STORAGE_PREFIX));
  return removed;
}

/**
 * The whole gesture, for `main.jsx` to call once before React renders — the
 * feed reads both stores on its first render, so this has to have happened by
 * then.
 */
export function applyReloadPolicy({ session, local, perf, now } = {}) {
  const isReload = isReloadNavigation({ perf });
  const wasAppForced = consumeAppForcedReload({ storage: session, now });
  if (!shouldStartFeedFresh({ isReload, wasAppForced })) return { fresh: false, removed: [] };
  return { fresh: true, removed: clearFeedContinuity({ session, local }) };
}
