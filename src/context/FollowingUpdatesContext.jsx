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

  // A fast scroll or a fling across several cards calls this once per card,
  // and each call used to run its own JSON parse-plus-stringify of the whole
  // seen list through `persistSeenIds`. Accumulating in this ref and flushing
  // once per microtask coalesces however many cards were marked in the same
  // tick into a single read-modify-write — the state update and the persisted
  // write both still happen, just once for the batch instead of once per
  // card. Nothing reads `seenIds` synchronously right after calling this: the
  // one place that keys off it (the ranking effect in FollowingFeedPage) only
  // recomputes when `items` itself changes, by design, so the microtask delay
  // is invisible to it.
  //
  // The merge reads `seenIdsRef.current` rather than going through
  // `setSeenIds`'s functional-updater form, and `persistSeenIds` is called
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
  const pendingSeenRef = useRef(null);
  const markSeen = useCallback((paper) => {
    const key = typeof paper === 'string' ? paper : getFollowingUpdatePaperKey(paper);
    if (!key || seenIds.has(key)) return;
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
        persistSeenIds([...next]);
      });
    }
    pendingSeenRef.current.add(key);
  }, [persistSeenIds, seenIds]);

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
