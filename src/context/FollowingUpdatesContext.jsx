/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FollowingUpdatesContext } from './contexts';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, IS_DEMO } from '../services/firebase';
import { fetchFollowingUpdates } from '../services/followingUpdatesService';
import { useAuth } from './AuthContext';
import { useFollowing } from './FollowingContext';
import {
  compactSeenIds,
  getFollowingSignature,
  getFollowingUpdatePaperKey,
  getFollowingUpdatesStorageKey,
} from '../utils/followingUpdates';

const CACHE_TTL_MS = 15 * 60 * 1000;
// How long a seen mark waits before it is written to storage and Firestore.
// Longer than any snap plus the settle the card takes after it, so the write
// lands on a still feed; short enough that a reader leaving the page a
// moment later still finds the write done (and pagehide flushes anyway).
const SEEN_PERSIST_DELAY_MS = 1500;
const requestsInFlight = new Map();

function readLocalState(userId) {
  try {
    return JSON.parse(localStorage.getItem(getFollowingUpdatesStorageKey(userId)) || '{}');
  } catch {
    return {};
  }
}

function writeLocalState(userId, value) {
  try {
    localStorage.setItem(getFollowingUpdatesStorageKey(userId), JSON.stringify(value));
  } catch {
    // A full or unavailable localStorage should not block the inbox.
  }
}

export function FollowingUpdatesProvider({ children }) {
  const { user } = useAuth();
  const userId = user?.uid || null;
  const { followedEntities, loading: followsLoading } = useFollowing();
  const [items, setItems] = useState([]);
  const [seenIds, setSeenIds] = useState(new Set());
  // Mirrors `seenIds` synchronously — assigned at every `setSeenIds` call
  // site in this file, in the same statement/microtask that produces the
  // next value, never via an effect. That's what makes it safe to read as
  // "the current set" from async callbacks (a `.then()`, a queued
  // microtask): a ref written on an effect lag would still be stale at
  // those points, but one written synchronously alongside every state
  // update never is, since JS callbacks never interleave with each other.
  const seenIdsRef = useRef(seenIds);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({ checkedEntities: 0, totalEntities: 0, failedEntities: 0 });
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const initializedForUser = useRef(null);
  const activeUserIdRef = useRef(userId);
  const signature = useMemo(() => getFollowingSignature(followedEntities), [followedEntities]);

  useLayoutEffect(() => {
    activeUserIdRef.current = userId;
    return () => {
      if (activeUserIdRef.current === userId) activeUserIdRef.current = null;
    };
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    const restoreTimeout = setTimeout(() => {
      if (cancelled) return;
      if (!userId) {
        setItems([]);
        const emptySeen = new Set();
        seenIdsRef.current = emptySeen;
        setSeenIds(emptySeen);
        initializedForUser.current = null;
        return;
      }

      const local = readLocalState(userId);
      const restoredSeen = new Set(compactSeenIds(local.seenIds || []));
      seenIdsRef.current = restoredSeen;
      setSeenIds(restoredSeen);
      if (local.signature === signature && Array.isArray(local.items)) {
        setItems(local.items);
        setMeta(local.meta || { checkedEntities: 0, totalEntities: followedEntities.length, failedEntities: 0 });
        setLastUpdatedAt(local.savedAt || null);
      }
    }, 0);

    if (!userId || IS_DEMO || initializedForUser.current === userId) {
      return () => {
        cancelled = true;
        clearTimeout(restoreTimeout);
      };
    }
    initializedForUser.current = userId;
    getDoc(doc(db, 'users', userId, 'settings', 'followingUpdates'))
      .then((snapshot) => {
        if (cancelled || !snapshot.exists()) return;
        const remoteSeen = compactSeenIds(snapshot.data().seenIds || []);
        const merged = new Set([...seenIdsRef.current, ...remoteSeen]);
        seenIdsRef.current = merged;
        setSeenIds(merged);
      })
      .catch(loadError => console.warn('No se pudo sincronizar el estado de novedades', loadError));
    return () => {
      cancelled = true;
      clearTimeout(restoreTimeout);
    };
  }, [followedEntities.length, signature, userId]);

  // A delivery from the service, as each follow answers (see
  // fetchFollowingUpdates): the items the page ranks are replaced by the
  // papers merged so far, and the page keeps the cards already on screen in
  // place (`mergeOrderedPapers`) and appends what is new. Measured with
  // fourteen follows on a cold cache, the feed used to show its discovery
  // screen for 6.5 s and then every card at once; the first follow answers
  // in ~300 ms. `loading` stays up until the last delivery, which is also the
  // one that writes the cache and sets `lastUpdatedAt`.
  const applyProgress = useCallback((partial) => {
    if (activeUserIdRef.current !== userId) return;
    if (!partial?.papers?.length) return;
    setItems(partial.papers);
    setMeta({
      checkedEntities: partial.checkedEntities,
      totalEntities: partial.totalEntities,
      failedEntities: partial.failedEntities,
    });
  }, [userId]);

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!userId || followsLoading) return;
    if (!followedEntities.length) {
      setItems([]);
      setMeta({ checkedEntities: 0, totalEntities: 0, failedEntities: 0 });
      setLastUpdatedAt(new Date().toISOString());
      return;
    }

    const requestKey = `${userId}:${signature}`;
    let request = requestsInFlight.get(requestKey);
    if (!request) {
      request = fetchFollowingUpdates(followedEntities, {
        onProgress: applyProgress,
      }).finally(() => requestsInFlight.delete(requestKey));
      requestsInFlight.set(requestKey, request);
    }

    if (silent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const result = await request;
      if (activeUserIdRef.current !== userId) return;
      const savedAt = new Date().toISOString();
      setItems(result.papers);
      setMeta({
        checkedEntities: result.checkedEntities,
        totalEntities: result.totalEntities,
        failedEntities: result.failedEntities,
      });
      setLastUpdatedAt(savedAt);
      const local = readLocalState(userId);
      writeLocalState(userId, {
        ...local,
        items: result.papers,
        meta: {
          checkedEntities: result.checkedEntities,
          totalEntities: result.totalEntities,
          failedEntities: result.failedEntities,
        },
        signature,
        savedAt,
      });
    } catch (refreshError) {
      if (activeUserIdRef.current !== userId) return;
      console.error('Error loading followed updates', refreshError);
      setError(refreshError);
    } finally {
      if (activeUserIdRef.current === userId) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyProgress, followedEntities, followsLoading, signature, userId]);

  useEffect(() => {
    if (!userId || followsLoading) return undefined;
    const local = readLocalState(userId);
    const cacheIsFresh = local.signature === signature
      && Date.now() - Date.parse(local.savedAt || 0) < CACHE_TTL_MS;
    if (cacheIsFresh) return undefined;
    const refreshTimeout = setTimeout(() => refresh({ silent: true }), 0);
    return () => clearTimeout(refreshTimeout);
  }, [followsLoading, refresh, signature, userId]);

  const persistSeenIds = useCallback(async (nextSeenIds) => {
    if (!userId) return;
    const compact = compactSeenIds(nextSeenIds);
    const local = readLocalState(userId);
    writeLocalState(userId, { ...local, seenIds: compact });
    if (!IS_DEMO) {
      try {
        await setDoc(doc(db, 'users', userId, 'settings', 'followingUpdates'), {
          seenIds: compact,
          updatedAt: serverTimestamp(),
        }, { merge: true });
      } catch (persistError) {
        console.warn('No se pudo guardar el estado de novedades', persistError);
      }
    }
  }, [userId]);

  // The persisted write, off the scroll path. `persistSeenIds` re-reads and
  // re-serialises the whole local state — the items with their abstracts
  // included — and it used to run in the same task as the card leaving the
  // screen, which is the middle of the snap to the next one. It now waits
  // for the reader to be still (SEEN_PERSIST_DELAY_MS) and always writes the
  // freshest set, so a fling across several cards is one write, taken after
  // the feed has come to rest. A tab hidden or closed inside that window
  // flushes first, the way FeedContext flushes its own debounced writes.
  const pendingSeenPersistRef = useRef(null);
  const flushSeenPersist = useCallback(() => {
    const pending = pendingSeenPersistRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingSeenPersistRef.current = null;
    void persistSeenIds([...seenIdsRef.current]);
  }, [persistSeenIds]);
  const scheduleSeenPersist = useCallback(() => {
    if (pendingSeenPersistRef.current) return;
    pendingSeenPersistRef.current = { timer: setTimeout(flushSeenPersist, SEEN_PERSIST_DELAY_MS) };
  }, [flushSeenPersist]);
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushSeenPersist();
    };
    window.addEventListener('pagehide', flushSeenPersist);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flushSeenPersist);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      flushSeenPersist();
    };
  }, [flushSeenPersist]);

  // A fast scroll or a fling across several cards calls this once per card,
  // and each call used to run its own JSON parse-plus-stringify of the whole
  // seen list through `persistSeenIds`. Accumulating in this ref and flushing
  // once per microtask coalesces however many cards were marked in the same
  // tick into a single state update; the persisted write is scheduled from
  // here and taken later, once the feed is still (`scheduleSeenPersist`).
  // Nothing reads `seenIds` synchronously right after calling this: the
  // one place that keys off it (the ranking effect in FollowingFeedPage) only
  // recomputes when `items` itself changes, by design, so the microtask delay
  // is invisible to it.
  //
  // The merge reads `seenIdsRef.current` rather than going through
  // `setSeenIds`'s functional-updater form, and the persist is scheduled
  // here, outside any updater. A functional updater is not a safe place for
  // this: React Router v7 navigations run inside `startTransition`
  // (App.jsx) under a `<Suspense>` boundary, so a transition render that
  // suspends on a lazy chunk gets discarded and re-rendered — but the
  // updater would already have run and already have fired the localStorage
  // write and the unawaited Firestore `setDoc` for state that never
  // committed. Worse, on a lane rebase the updater re-runs against an older
  // `current` and can persist a *smaller* set; since `persistSeenIds` is
  // async and `setDoc` is last-write-wins, that stale, shorter write can
  // land after a fuller one and resurface already-seen cards. `seenIdsRef`
  // avoids both failure modes because it is written synchronously, in the
  // same statement that computes each next value, at every `setSeenIds`
  // call site in this file (see its declaration above) — never mirrored via
  // an effect, so it is never stale when this microtask reads it, and
  // reading it here doesn't re-run on a discarded/rebased render the way an
  // updater body would.
  //
  // The early return reads the ref too, not `seenIds` state, and that is
  // what keeps this callback's identity stable across a session. With
  // `seenIds` in the dependency list, every card marked seen minted a new
  // `markSeen`; FollowingFeedPage folds it into the `source` it hands
  // FeedContainer, whose per-card callbacks derive from `source`, so every
  // mounted PaperCard lost its memo and re-rendered — and re-subscribed its
  // IntersectionObserver — on the very frame the outgoing card crossed the
  // half-way mark. Measured 2026-09-22 (production bundle, 23 cards, 4x CPU
  // throttle): two full-feed renders per swipe, 100-135 ms each, inside the
  // snap animation. The state update below still happens, once per batch;
  // what no longer happens is the function changing under its consumers.
  const pendingSeenRef = useRef(null);
  const markSeen = useCallback((paper) => {
    const key = typeof paper === 'string' ? paper : getFollowingUpdatePaperKey(paper);
    if (!key || seenIdsRef.current.has(key)) return;
    if (!pendingSeenRef.current) {
      pendingSeenRef.current = new Set();
      queueMicrotask(() => {
        const pending = pendingSeenRef.current;
        pendingSeenRef.current = null;
        const next = new Set(seenIdsRef.current);
        let changed = false;
        pending.forEach((pendingKey) => {
          if (!next.has(pendingKey)) {
            next.add(pendingKey);
            changed = true;
          }
        });
        if (!changed) return;
        seenIdsRef.current = next;
        setSeenIds(next);
        scheduleSeenPersist();
      });
    }
    pendingSeenRef.current.add(key);
  }, [scheduleSeenPersist]);

  const value = useMemo(() => ({
    items,
    seenIds,
    loading,
    refreshing,
    error,
    meta,
    lastUpdatedAt,
    refresh,
    markSeen,
  }), [error, items, lastUpdatedAt, loading, markSeen, meta, refreshing, refresh, seenIds]);

  return <FollowingUpdatesContext.Provider value={value}>{children}</FollowingUpdatesContext.Provider>;
}

export function useFollowingUpdates() {
  const context = useContext(FollowingUpdatesContext);
  if (!context) throw new Error('useFollowingUpdates must be used within a FollowingUpdatesProvider');
  return context;
}
