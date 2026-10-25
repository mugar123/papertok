import { SIGNED_OUT_ACCOUNT } from './account-scope.ts';

type FeedResume = { scrollTop: number; index: number; paperId: string | null };

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
// For You's place, which FeedContext also reads: a restore on another page
// learns from it the card the reader comes back to. It names the account, so
// another account's feed never opens on it.
export const forYouScrollKey = (account: string | null | undefined) => `forYou:${account || SIGNED_OUT_ACCOUNT}`;

const NOWHERE = Object.freeze({ scrollTop: 0, index: 0, paperId: null });

type ResumeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function readStored(storage: ResumeStorage | null, key: string) {
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

export function createFeedResumeMemory({ storage = defaultStorage() }: { storage?: ResumeStorage | null } = {}) {
  const entries = new Map<string, FeedResume>();
  const seeded = new Set<string>();

  const get = (key: string) => {
    if (!entries.has(key) && !seeded.has(key)) {
      seeded.add(key);
      const stored = readStored(storage, key);
      if (stored) entries.set(key, stored);
    }
    return entries.get(key) || NOWHERE;
  };

  const remember = (key: string, { scrollTop = 0, index = 0, paperId = null }: Partial<FeedResume> = {}) => {
    seeded.add(key);
    entries.set(key, {
      scrollTop: Number(scrollTop) || 0,
      index: Math.max(0, Math.trunc(Number(index)) || 0),
      paperId: paperId || null,
    });
  };

  const persist = (key: string) => {
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

  // Every place goes, the stored ones too: another account's feeds open on
  // their first card.
  const clear = () => {
    entries.clear();
    seeded.clear();
    if (!storage) return;
    try {
      Object.keys(storage).filter(key => key.startsWith(FEED_RESUME_STORAGE_PREFIX)).forEach(key => storage.removeItem(key));
    } catch {
      // A storage that refuses keeps its places; For You's names its account,
      // so another account still does not read it.
    }
  };

  return { get, remember, persist, clear };
}

// The places of this tab's feeds: FeedContainer keeps them, FeedContext reads
// For You's, and App clears them when the account changes.
export const feedResumeMemory = createFeedResumeMemory();
