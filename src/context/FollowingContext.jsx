/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FollowingContext } from './contexts';
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

const EMPTY_LOCALIZED_INSTITUTION_NAMES = Object.freeze({});

/**
 * How long the app waits for the first snapshot of `following` before it stops
 * blocking on it. Long enough that a healthy connection never sees it.
 */
const FIRST_SNAPSHOT_GRACE_MS = 6500;

/**
 * The follow list has not arrived yet, and the app has stopped waiting for it.
 *
 * Not a failure: the listener is still attached and Firestore reconnects on its
 * own. It exists so consumers can tell "we do not know what this account
 * follows" from "this account follows nobody" — a distinction that decides
 * whether it is safe to write notification preferences derived from the list.
 */
export class FollowsUnavailableError extends Error {
  constructor() {
    super('The follow list has not arrived yet.');
    this.name = 'FollowsUnavailableError';
    this.code = 'FOLLOWS_UNAVAILABLE';
    this.retryable = true;
  }
}

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
  // The legacy authors, reachable from inside the subscription without being a
  // dependency of it. See the two effects below.
  const followedAuthorsRef = useRef(followedAuthors);
  // Mirrored in an effect, like the other stale-closure guards in this app
  // (see FeedContext): a ref must not be written during render.
  useEffect(() => { followedAuthorsRef.current = followedAuthors; }, [followedAuthors]);
  // True once a snapshot for the account below has actually arrived. A ref, not
  // state: the migration effect only needs to read it, and writing it from the
  // snapshot callback keeps it correct before the re-render it triggers.
  const followsArrived = useRef(false);
  const localizedInstitutionNames = institutionLocalizationState.userId === user?.uid
    ? institutionLocalizationState.names
    : EMPTY_LOCALIZED_INSTITUTION_NAMES;

  useEffect(() => {
    if (!user?.uid) {
      return undefined;
    }

    if (IS_DEMO) {
      const stored = readDemoFollowing(user.uid);
      const migrated = migrateLegacyAuthors(followedAuthorsRef.current);
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

    followsArrived.current = false;
    legacyMigrationAttempted.current = false;
    const followsCollection = collection(db, 'users', user.uid, 'following');
    /**
     * The grace period before the app stops waiting for the first snapshot.
     *
     * It has to exist: FeedContext will not load a feed while `loading` is
     * true, so a listener that never delivers would leave the app on an empty
     * screen. But clearing `loading` on a timer and saying nothing else was a
     * timeout presented as an answer — an account that follows fifty people
     * rendered as an account that follows nobody, and the settings screen
     * offered to help them start following someone.
     *
     * So it clears `loading` *and* raises `error`. The listener stays attached
     * and Firestore reconnects on its own, so the first real snapshot clears
     * the error and the screen heals with no user action.
     */
    const loadingTimeout = window.setTimeout(() => {
      setLoading(false);
      setError(new FollowsUnavailableError());
    }, FIRST_SNAPSHOT_GRACE_MS);

    const unsubscribe = onSnapshot(followsCollection, (snapshot) => {
      window.clearTimeout(loadingTimeout);
      followsArrived.current = true;
      setFollowedEntities(snapshot.docs.map((item) => ({ ...item.data(), followKey: item.id })));
      // Whatever went wrong before, this is the server's own answer.
      setError(null);
      setLoading(false);
    }, (snapshotError) => {
      window.clearTimeout(loadingTimeout);
      console.error('Error loading follows', snapshotError);
      setError(snapshotError);
      setFollowedEntities(migrateLegacyAuthors(followedAuthorsRef.current));
      setLoading(false);
    });
    return () => {
      window.clearTimeout(loadingTimeout);
      unsubscribe();
    };
    // Keyed on the account and nothing else. `followedAuthors` used to be a
    // dependency, and it is a fresh array on every profile apply — which
    // AuthContext does twice per sign-in, once from cache and once from the
    // server. That tore down and rebuilt the only Firestore listener in the app
    // at least twice per sign-in, re-reading the whole collection each time.
    // The migration below is what actually needs those authors, so it reads
    // them itself.
  }, [user?.uid]);

  /**
   * One-off migration of the pre-`following` author list.
   *
   * Split out of the subscription on purpose: it is the only thing that needed
   * `followedAuthors`, and keeping it here means the listener no longer
   * restarts every time that array is replaced by an identical one. It waits
   * for a real snapshot, because migrating against an empty placeholder would
   * re-create follows the user had already removed.
   */
  useEffect(() => {
    const userId = user?.uid;
    if (!userId || IS_DEMO) return;
    if (!followsArrived.current || legacyMigrationAttempted.current) return;
    if (followedAuthors.length === 0) return;

    legacyMigrationAttempted.current = true;
    const followsCollection = collection(db, 'users', userId, 'following');
    const missingLegacy = migrateLegacyAuthors(followedAuthors)
      .filter((legacy) => !followsEntity(followedEntities, legacy));

    (async () => {
      try {
        await Promise.all(missingLegacy.map((legacy) => setDoc(
          doc(followsCollection, createFollowKey(legacy.type, legacy.canonicalId)),
          { ...legacy, followedAt: serverTimestamp() },
          { merge: true },
        )));
        await setDoc(doc(db, 'users', userId), {
          followedAuthors: [],
          followingMigratedAt: serverTimestamp(),
        }, { merge: true });
      } catch (migrationError) {
        console.warn('No se pudieron migrar todos los seguimientos', migrationError);
      }
    })();
  }, [user?.uid, followedAuthors, followedEntities]);

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
