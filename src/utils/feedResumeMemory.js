/**
 * The card each feed was left on, per surface, in a memory that survives a
 * reload of the tab.
 *
 * It used to be three maps at module scope in FeedContainer — index, paper
 * id, pixel offset — which a reload throws away, and the tab reloads itself
 * without being asked: main.jsx does so when a lazy chunk has gone missing
 * after a deploy, and the service worker does when it takes a new build.
 * Coming back from the profile then opened the feed at the top, and read as
 * the whole feed reloading (the profile chunk is what a deploy most often
 * takes away: it was fetched on first visit, not warmed at idle).
 *
 * sessionStorage, not localStorage: the place belongs to this tab and to this
 * visit. A new tab starts at the top; a reload of this one does not. The
 * write happens once per settled scroll (`persist`), never per scroll event,
 * and only the paper id and the index are stored — a pixel offset is only
 * meaningful against the viewport that produced it, so a restored place
 * carries a token offset that says "somewhere to go back to" and nothing more.
 */
export const FEED_RESUME_STORAGE_PREFIX = 'papertok_feed_resume:';

const NOWHERE = Object.freeze({ scrollTop: 0, index: 0, paperId: null });

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readStored(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(`${FEED_RESUME_STORAGE_PREFIX}${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const index = Number(parsed?.index);
    const paperId = typeof parsed?.paperId === 'string' && parsed.paperId ? parsed.paperId : null;
    if (!paperId || !Number.isInteger(index) || index < 0) return null;
    return { scrollTop: index > 0 ? 1 : 0, index, paperId };
  } catch {
    return null;
  }
}

export function createFeedResumeMemory({ storage = defaultStorage() } = {}) {
  const entries = new Map();
  const seeded = new Set();

  const get = (key) => {
    if (!entries.has(key) && !seeded.has(key)) {
      seeded.add(key);
      const stored = readStored(storage, key);
      if (stored) entries.set(key, stored);
    }
    return entries.get(key) || NOWHERE;
  };

  const remember = (key, { scrollTop = 0, index = 0, paperId = null } = {}) => {
    seeded.add(key);
    entries.set(key, {
      scrollTop: Number(scrollTop) || 0,
      index: Math.max(0, Math.trunc(Number(index)) || 0),
      paperId: paperId || null,
    });
  };

  const persist = (key) => {
    const entry = entries.get(key);
    if (!storage || !entry) return;
    try {
      if (entry.paperId) {
        storage.setItem(`${FEED_RESUME_STORAGE_PREFIX}${key}`, JSON.stringify({ index: entry.index, paperId: entry.paperId }));
      } else {
        storage.removeItem(`${FEED_RESUME_STORAGE_PREFIX}${key}`);
      }
    } catch {
      // A full or locked storage means the place lives only until the reload.
    }
  };

  return { get, remember, persist };
}
