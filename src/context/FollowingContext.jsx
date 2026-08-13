/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, IS_DEMO } from '../services/firebase';
import { getRorInstitution, normalizeRorId } from '../services/rorService';
import { useAuth } from './AuthContext';
import { useAnalyticsConsent } from './AnalyticsContext';
import {
  createFollowEntity,
  createFollowKey,
  followsEntity,
  getFollowingStorageKey,
  migrateLegacyAuthors,
} from '../utils/following';

const FollowingContext = createContext(null);
const EMPTY_LOCALIZED_INSTITUTION_NAMES = Object.freeze({});

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
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const [followedEntities, setFollowedEntities] = useState([]);
  const [loading, setLoading] = useState(Boolean(user));
  const [error, setError] = useState(null);
  const [pendingFollowKeys, setPendingFollowKeys] = useState(new Set());
  const [institutionLocalizationState, setInstitutionLocalizationState] = useState({
    userId: '',
    names: EMPTY_LOCALIZED_INSTITUTION_NAMES,
  });
  const legacyMigrationAttempted = useRef(false);
  const institutionLocalizationPending = useRef(new Set());
  const localizedInstitutionNames = institutionLocalizationState.userId === user?.uid
    ? institutionLocalizationState.names
    : EMPTY_LOCALIZED_INSTITUTION_NAMES;

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
    const loadingTimeout = window.setTimeout(() => {
      setLoading(false);
    }, 6500);
    const unsubscribe = onSnapshot(followsCollection, async (snapshot) => {
      const current = snapshot.docs.map((item) => ({ ...item.data(), followKey: item.id }));
      const shouldMigrateLegacy = followedAuthors.length > 0 && !legacyMigrationAttempted.current;
      const missingLegacy = shouldMigrateLegacy
        ? migrateLegacyAuthors(followedAuthors).filter((legacy) => !followsEntity(current, legacy))
        : [];

      window.clearTimeout(loadingTimeout);
      setFollowedEntities(current);
      setLoading(false);

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
    }, (snapshotError) => {
      window.clearTimeout(loadingTimeout);
      console.error('Error loading follows', snapshotError);
      setError(snapshotError);
      setFollowedEntities(migrateLegacyAuthors(followedAuthors));
      setLoading(false);
    });
    return () => {
      window.clearTimeout(loadingTimeout);
      unsubscribe();
    };
  }, [user?.uid, followedAuthors]);

  useEffect(() => {
    if (!user?.uid) return undefined;
    const userId = user.uid;
    const candidates = followedEntities.filter((follow) => {
      if (follow.type !== 'institution' || follow.metadata?.localizedNames?.en) return false;
      const followKey = follow.followKey || createFollowKey(follow.type, follow.canonicalId);
      const pendingKey = `${userId}:${followKey}`;
      const rorId = normalizeRorId(follow.externalIds?.ror || follow.canonicalId);
      return rorId
        && !localizedInstitutionNames[followKey]
        && !institutionLocalizationPending.current.has(pendingKey);
    });
    if (candidates.length === 0) return undefined;

    let cancelled = false;
    candidates.forEach((follow) => {
      const followKey = follow.followKey || createFollowKey(follow.type, follow.canonicalId);
      institutionLocalizationPending.current.add(`${userId}:${followKey}`);
    });

    Promise.all(candidates.map(async (follow) => {
      const followKey = follow.followKey || createFollowKey(follow.type, follow.canonicalId);
      const pendingKey = `${userId}:${followKey}`;
      try {
        const institution = await getRorInstitution(follow.externalIds?.ror || follow.canonicalId);
        return institution?.localized_names
          ? [followKey, institution.localized_names]
          : null;
      } catch {
        return null;
      } finally {
        institutionLocalizationPending.current.delete(pendingKey);
      }
    })).then((entries) => {
      if (cancelled) return;
      const validEntries = entries.filter(Boolean);
      if (validEntries.length === 0) return;
      setInstitutionLocalizationState(current => ({
        userId,
        names: {
          ...(current.userId === userId ? current.names : {}),
          ...Object.fromEntries(validEntries),
        },
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [followedEntities, localizedInstitutionNames, user?.uid]);

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
      trackEvent('follow_change', {
        entity_type: entity.type,
        action: wasFollowing ? 'remove' : 'add',
        surface: 'other',
      });
      if (!wasFollowing) markActivation();
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
  }, [followedEntities, markActivation, pendingFollowKeys, trackEvent, user]);

  const localizedFollowedEntities = useMemo(() => followedEntities.map((entity) => {
    if (entity.type !== 'institution' || entity.metadata?.localizedNames?.en) return entity;
    const followKey = entity.followKey || createFollowKey(entity.type, entity.canonicalId);
    const localizedNames = localizedInstitutionNames[followKey];
    return localizedNames
      ? {
        ...entity,
        metadata: {
          ...(entity.metadata || {}),
          localizedNames,
        },
      }
      : entity;
  }), [followedEntities, localizedInstitutionNames]);

  const followedByType = useMemo(() => localizedFollowedEntities.reduce((groups, entity) => {
    groups[entity.type] = [...(groups[entity.type] || []), entity];
    return groups;
  }, {}), [localizedFollowedEntities]);

  const value = useMemo(() => ({
    followedEntities: localizedFollowedEntities,
    followedByType,
    loading,
    error,
    isFollowing,
    isFollowPending,
    toggleFollow,
  }), [error, followedByType, isFollowPending, isFollowing, loading, localizedFollowedEntities, toggleFollow]);

  return <FollowingContext.Provider value={value}>{children}</FollowingContext.Provider>;
}

export function useFollowing() {
  const context = useContext(FollowingContext);
  if (!context) throw new Error('useFollowing must be used within a FollowingProvider');
  return context;
}
