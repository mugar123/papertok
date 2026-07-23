/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

const FollowingUpdatesContext = createContext(null);
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
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({ checkedEntities: 0, totalEntities: 0, failedEntities: 0 });
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const initializedForUser = useRef(null);
  const signature = useMemo(() => getFollowingSignature(followedEntities), [followedEntities]);

  useEffect(() => {
    let cancelled = false;
    const restoreTimeout = setTimeout(() => {
      if (cancelled) return;
      if (!userId) {
        setItems([]);
        setSeenIds(new Set());
        initializedForUser.current = null;
        return;
      }

      const local = readLocalState(userId);
      setSeenIds(new Set(compactSeenIds(local.seenIds || [])));
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
        setSeenIds(current => new Set([...current, ...remoteSeen]));
      })
      .catch(loadError => console.warn('No se pudo sincronizar el estado de novedades', loadError));
    return () => {
      cancelled = true;
      clearTimeout(restoreTimeout);
    };
  }, [followedEntities.length, signature, userId]);

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
      request = fetchFollowingUpdates(followedEntities).finally(() => requestsInFlight.delete(requestKey));
      requestsInFlight.set(requestKey, request);
    }

    if (silent) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const result = await request;
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
      console.error('Error loading followed updates', refreshError);
      setError(refreshError);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [followedEntities, followsLoading, signature, userId]);

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

  const markSeen = useCallback((paper) => {
    const key = typeof paper === 'string' ? paper : getFollowingUpdatePaperKey(paper);
    if (!key || seenIds.has(key)) return;
    const next = new Set(seenIds).add(key);
    setSeenIds(next);
    persistSeenIds([...next]);
  }, [persistSeenIds, seenIds]);

  const markAllSeen = useCallback(() => {
    const next = new Set([...seenIds, ...items.map(getFollowingUpdatePaperKey)]);
    setSeenIds(next);
    persistSeenIds([...next]);
  }, [items, persistSeenIds, seenIds]);

  const unreadCount = useMemo(() => items.reduce((count, paper) => (
    count + (seenIds.has(getFollowingUpdatePaperKey(paper)) ? 0 : 1)
  ), 0), [items, seenIds]);

  const value = useMemo(() => ({
    items,
    seenIds,
    unreadCount,
    loading,
    refreshing,
    error,
    meta,
    lastUpdatedAt,
    refresh,
    markSeen,
    markAllSeen,
  }), [error, items, lastUpdatedAt, loading, markAllSeen, markSeen, meta, refreshing, refresh, seenIds, unreadCount]);

  return <FollowingUpdatesContext.Provider value={value}>{children}</FollowingUpdatesContext.Provider>;
}

export function useFollowingUpdates() {
  const context = useContext(FollowingUpdatesContext);
  if (!context) throw new Error('useFollowingUpdates must be used within a FollowingUpdatesProvider');
  return context;
}
