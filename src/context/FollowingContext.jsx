/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, IS_DEMO } from '../services/firebase';
import { useAuth } from './AuthContext';
import {
  createFollowEntity,
  createFollowKey,
  followsEntity,
  getFollowingStorageKey,
  migrateLegacyAuthors,
} from '../utils/following';

const FollowingContext = createContext(null);

function readDemoFollowing(userId) {
  try {
    return JSON.parse(localStorage.getItem(getFollowingStorageKey(userId)) || '[]');
  } catch {
    return [];
  }
}

function writeDemoFollowing(userId, follows) {
  localStorage.setItem(getFollowingStorageKey(userId), JSON.stringify(follows));
}

export function FollowingProvider({ children }) {
  const { user, followedAuthors } = useAuth();
  const [followedEntities, setFollowedEntities] = useState([]);
  const [loading, setLoading] = useState(Boolean(user));
  const [error, setError] = useState(null);
  const [pendingFollowKeys, setPendingFollowKeys] = useState(new Set());
  const legacyMigrationAttempted = useRef(false);

  useEffect(() => {
    if (!user?.uid) {
      return undefined;
    }

    if (IS_DEMO) {
      const stored = readDemoFollowing(user.uid);
      const migrated = migrateLegacyAuthors(followedAuthors);
      const merged = [...stored];
      migrated.forEach((legacy) => {
        if (!followsEntity(merged, legacy)) merged.push(legacy);
      });
      const timeoutId = setTimeout(() => {
        setFollowedEntities(merged);
        writeDemoFollowing(user.uid, merged);
        localStorage.removeItem('papertok_followedAuthors');
        setLoading(false);
      }, 0);
      return () => clearTimeout(timeoutId);
    }

    const followsCollection = collection(db, 'users', user.uid, 'following');
    return onSnapshot(followsCollection, async (snapshot) => {
      const current = snapshot.docs.map((item) => ({ ...item.data(), followKey: item.id }));
      const shouldMigrateLegacy = followedAuthors.length > 0 && !legacyMigrationAttempted.current;
      const missingLegacy = shouldMigrateLegacy
        ? migrateLegacyAuthors(followedAuthors).filter((legacy) => !followsEntity(current, legacy))
        : [];

      if (shouldMigrateLegacy) {
        legacyMigrationAttempted.current = true;
        try {
          await Promise.all(missingLegacy.map((legacy) => setDoc(
            doc(followsCollection, createFollowKey(legacy.type, legacy.canonicalId)),
            { ...legacy, followedAt: serverTimestamp() },
            { merge: true },
          )));
          await setDoc(doc(db, 'users', user.uid), {
            followedAuthors: [],
            followingMigratedAt: serverTimestamp(),
          }, { merge: true });
        } catch (migrationError) {
          console.warn('No se pudieron migrar todos los seguimientos', migrationError);
        }
      }

      setFollowedEntities(current);
      setLoading(false);
    }, (snapshotError) => {
      console.error('Error loading follows', snapshotError);
      setError(snapshotError);
      setFollowedEntities(migrateLegacyAuthors(followedAuthors));
      setLoading(false);
    });
  }, [user?.uid, followedAuthors]);

  const isFollowing = useCallback((entity) => followsEntity(followedEntities, entity), [followedEntities]);
  const isFollowPending = useCallback((input) => {
    const entity = createFollowEntity(input);
    return entity ? pendingFollowKeys.has(createFollowKey(entity.type, entity.canonicalId)) : false;
  }, [pendingFollowKeys]);

  const toggleFollow = useCallback(async (input) => {
    const entity = createFollowEntity(input);
    if (!entity || !user?.uid) return false;
    const pendingKey = createFollowKey(entity.type, entity.canonicalId);
    if (pendingFollowKeys.has(pendingKey)) return followsEntity(followedEntities, entity);

    const existingFollow = followedEntities.find((follow) => followsEntity([follow], entity));
    const wasFollowing = Boolean(existingFollow);
    const previous = followedEntities;
    const next = wasFollowing
      ? previous.filter((follow) => !followsEntity([follow], entity))
      : [...previous, entity];
    setFollowedEntities(next);
    setError(null);
    setPendingFollowKeys(current => new Set(current).add(pendingKey));

    try {
      if (IS_DEMO) {
        writeDemoFollowing(user.uid, next);
      } else {
        const followRef = doc(db, 'users', user.uid, 'following', createFollowKey(entity.type, entity.canonicalId));
        if (wasFollowing) {
          const existingKey = existingFollow.followKey || createFollowKey(existingFollow.type, existingFollow.canonicalId);
          await deleteDoc(doc(db, 'users', user.uid, 'following', existingKey));
        }
        else await setDoc(followRef, { ...entity, followedAt: serverTimestamp() });
      }
      return !wasFollowing;
    } catch (toggleError) {
      setFollowedEntities(previous);
      setError(toggleError);
      throw toggleError;
    } finally {
      setPendingFollowKeys(current => {
        const updated = new Set(current);
        updated.delete(pendingKey);
        return updated;
      });
    }
  }, [followedEntities, pendingFollowKeys, user]);

  const followedByType = useMemo(() => followedEntities.reduce((groups, entity) => {
    groups[entity.type] = [...(groups[entity.type] || []), entity];
    return groups;
  }, {}), [followedEntities]);

  const value = useMemo(() => ({
    followedEntities,
    followedByType,
    loading,
    error,
    isFollowing,
    isFollowPending,
    toggleFollow,
  }), [error, followedByType, followedEntities, isFollowPending, isFollowing, loading, toggleFollow]);

  return <FollowingContext.Provider value={value}>{children}</FollowingContext.Provider>;
}

export function useFollowing() {
  const context = useContext(FollowingContext);
  if (!context) throw new Error('useFollowing must be used within a FollowingProvider');
  return context;
}
