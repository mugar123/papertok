/* eslint-disable react-refresh/only-export-components */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './contexts';
import { IS_DEMO, auth, db } from '../services/firebase';
import { onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import {
  SIGN_IN_PROVIDERS,
  linkSignInProvider,
  providerIdsOf,
  signInWithProvider,
} from '../services/authIdentityService';
import { deleteField, doc, getDoc, getDocFromCache, setDoc } from 'firebase/firestore';
import {
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
} from '../utils/userSettings';
import { settleWithin } from '../utils/asyncTiming';
import { normalizeProfilePhoto } from '../utils/profileImage';
import { clearUserScopedStorage, readStoredOnboarding, saveStoredOnboarding } from '../utils/userScopedStorage';
import { hydrateAccountCaches, resetAccountWarmup, warmAccountCaches } from '../services/accountWarmup.js';
import { forgetOwnProfile } from '../utils/profileSessionCaches.js';
import { accountLooksOnboarded } from '../utils/accountOnboarding.js';

const PROFILE_CACHE_TIMEOUT_MS = 800;
const PROFILE_NETWORK_TIMEOUT_MS = 7000;

// ── Demo mode storage helpers ──
function demoGet(key, fallback) {
  try {
    const v = localStorage.getItem(`papertok_${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function demoSet(key, value) {
  localStorage.setItem(`papertok_${key}`, JSON.stringify(value));
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [userPreferences, setUserPreferences] = useState(null);
  const [followedAuthors, setFollowedAuthors] = useState([]);
  const [readingPreferences, setReadingPreferences] = useState(DEFAULT_READING_PREFERENCES);
  const [profilePhoto, setProfilePhoto] = useState(null);
  const [profileLoadError, setProfileLoadError] = useState(null);
  // Which doors this account has (F5). Kept in state rather than read from
  // `user.providerData` at render time because linking does not always
  // re-emit an auth state change, and a settings row that still says
  // "Connect" right after connecting is a row nobody trusts.
  const [signInProviders, setSignInProviders] = useState([]);
  const [profileReloadKey, setProfileReloadKey] = useState(0);

  useEffect(() => {
    if (IS_DEMO) {
      setTimeout(() => {
        // Demo mode: check if user has "logged in" before
        const demoUser = demoGet('user', null);
        if (demoUser) {
          setUser(demoUser);
          setOnboardingComplete(demoGet('onboardingComplete', false));
          setUserPreferences(demoGet('selectedCategories', null));
          setFollowedAuthors(demoGet('followedAuthors', []));
          setReadingPreferences(normalizeReadingPreferences(demoGet('readingPreferences', {})));
          setProfilePhoto(normalizeProfilePhoto(demoGet('profilePhoto', null)));
          setSignInProviders(providerIdsOf(demoUser));
        }
        setLoading(false);
      }, 0);
      return;
    }

    let authChangeId = 0;
    let disposed = false;
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      const changeId = ++authChangeId;
      setLoading(true);
      setProfileLoadError(null);
      setUser(currentUser);
      setFollowedAuthors([]);
      setReadingPreferences(DEFAULT_READING_PREFERENCES);
      setProfilePhoto(null);
      setSignInProviders(providerIdsOf(currentUser));

      if (currentUser) {
        hydrateAccountCaches(currentUser.uid);
        void warmAccountCaches(currentUser.uid);
        const storedOnboarding = readStoredOnboarding(currentUser.uid);
        if (storedOnboarding?.complete) {
          setOnboardingComplete(true);
          if (storedOnboarding.preferences.length > 0) {
            setUserPreferences(storedOnboarding.preferences);
          }
        } else {
          setOnboardingComplete(false);
          setUserPreferences(null);
        }
        const userRef = doc(db, 'users', currentUser.uid);
        const isCurrent = () => !disposed && changeId === authChangeId;
        const applyProfile = (snapshot) => {
          if (!snapshot?.exists() || !isCurrent()) return false;
          const data = snapshot.data();
          const onboarded = accountLooksOnboarded(data);
          setOnboardingComplete(onboarded);
          const preferences = data.preferences || data.selectedCategories || null;
          setUserPreferences(preferences);
          setFollowedAuthors(data.followedAuthors || []);
          setReadingPreferences(normalizeReadingPreferences(data.readingPreferences));
          setProfilePhoto(normalizeProfilePhoto(data.profilePhoto));
          if (onboarded) {
            saveStoredOnboarding(currentUser.uid, {
              complete: true,
              preferences: Array.isArray(preferences) ? preferences : [],
            });
          }
          return true;
        };

        const cached = await settleWithin(
          getDocFromCache(userRef),
          PROFILE_CACHE_TIMEOUT_MS,
        );
        if (!isCurrent()) return;

        const hydratedFromCache = cached.status === 'fulfilled' && applyProfile(cached.value);
        if (hydratedFromCache) setLoading(false);

        const remote = await settleWithin(getDoc(userRef), PROFILE_NETWORK_TIMEOUT_MS);
        if (!isCurrent()) return;

        if (remote.status === 'fulfilled') {
          if (!applyProfile(remote.value) && !hydratedFromCache && !storedOnboarding?.complete) {
            setOnboardingComplete(false);
          }
        } else if (!hydratedFromCache && !storedOnboarding?.complete) {
          setProfileLoadError('PROFILE_LOAD_FAILED');
          if (remote.status === 'rejected') {
            console.error('Error fetching user data', remote.reason);
          } else {
            console.warn('Profile loading exceeded the timeout');
          }
        }
      } else {
        setOnboardingComplete(false);
        setUserPreferences(null);
      }
      if (!disposed && changeId === authChangeId) setLoading(false);
    });

    return () => {
      disposed = true;
      authChangeId += 1;
      unsubscribe();
    };
  }, [profileReloadKey]);

  const retryProfileLoad = useCallback(() => {
    setProfileLoadError(null);
    setProfileReloadKey(key => key + 1);
  }, []);

  // No reactive read besides state setters and module-level constants, so this
  // never needs to be recreated — every context consumer that depends on it
  // (both sign-in buttons below) inherits that stability.
  const signInWith = useCallback(async (providerId) => {
    setError(null);
    if (IS_DEMO) {
      setTimeout(() => {
        const demoUser = {
          uid: 'demo-user-123',
          displayName: 'Demo User',
          email: 'demo@papertok.app',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix',
          providerData: [{ providerId }],
        };
        setUser(demoUser);
        setSignInProviders(providerIdsOf(demoUser));
        demoSet('user', demoUser);
      }, 500);
      return { isNewUser: false, providerId };
    }
    try {
      return await signInWithProvider(providerId);
    } catch (err) {
      setError(err?.code || 'AUTH_FAILED');
      throw err;
    }
  }, []);

  const signInWithGoogle = useCallback(
    () => signInWith(SIGN_IN_PROVIDERS.google),
    [signInWith],
  );
  const signInWithGitHub = useCallback(
    () => signInWith(SIGN_IN_PROVIDERS.github),
    [signInWith],
  );

  /**
   * Attaches a second sign-in method to the account already in session (F5).
   * Both providers open the same uid afterwards, so nothing in Firestore moves
   * and nothing needs migrating. Errors are classified by the service and
   * thrown on: the caller shows them next to the button that was pressed,
   * rather than in the page-wide banner meant for a failed sign-in.
   */
  const linkGitHubAccount = useCallback(async () => {
    const result = await linkSignInProvider(SIGN_IN_PROVIDERS.github);
    setSignInProviders(providerIdsOf(result.user || auth.currentUser));
    return result;
  }, []);

  // `user?.uid` rather than `user`: Firebase re-emits `currentUser` on token
  // refresh with the same uid but a new object reference, and that must not
  // recreate a function whose only reactive read is the id.
  const signOut = useCallback(async () => {
    const signingOutUserId = user?.uid;
    if (IS_DEMO) {
      setUser(null);
      setOnboardingComplete(false);
      setUserPreferences(null);
      setFollowedAuthors([]);
      setReadingPreferences(DEFAULT_READING_PREFERENCES);
      setProfilePhoto(null);
      setSignInProviders([]);
      localStorage.removeItem('papertok_user');
      return;
    }
    try {
      await firebaseSignOut(auth);
      clearUserScopedStorage(signingOutUserId);
      forgetOwnProfile(signingOutUserId);
      resetAccountWarmup(signingOutUserId);
    } catch (err) {
      setError(err?.code || 'AUTH_FAILED');
    }
  }, [user?.uid]);

  const completeOnboarding = useCallback(async (preferences) => {
    setUserPreferences(preferences);
    setOnboardingComplete(true);

    if (IS_DEMO) {
      demoSet('selectedCategories', preferences);
      demoSet('onboardingComplete', true);
      return;
    }

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), {
        onboardingComplete: true,
        preferences
      }, { merge: true });
      saveStoredOnboarding(userId, { complete: true, preferences });
    }
  }, [user?.uid]);

  const updatePreferences = useCallback(async (newPreferences) => {
    setUserPreferences(newPreferences);

    if (IS_DEMO) {
      demoSet('selectedCategories', newPreferences);
      return;
    }

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), {
        preferences: newPreferences
      }, { merge: true });
      saveStoredOnboarding(userId, { complete: true, preferences: newPreferences });
    }
  }, [user?.uid]);

  // Needs the previous list itself, not just its owner's id: the new array is
  // both written to Firestore and (in demo mode) to storage in this same call,
  // so a functional state update alone would not hand it back for that.
  const toggleFollowAuthor = useCallback(async (authorName) => {
    const newFollowed = followedAuthors.includes(authorName)
      ? followedAuthors.filter(a => a !== authorName)
      : [...followedAuthors, authorName];

    setFollowedAuthors(newFollowed);

    if (IS_DEMO) {
      demoSet('followedAuthors', newFollowed);
      return;
    }

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), {
        followedAuthors: newFollowed
      }, { merge: true });
    }
  }, [followedAuthors, user?.uid]);

  // Same reasoning: `previous` is what a failed write rolls back to, read from
  // the closure rather than from a functional update the error path could not
  // reach.
  const updateReadingPreferences = useCallback(async (updates) => {
    const userId = user?.uid;
    const previous = readingPreferences;
    const next = normalizeReadingPreferences({ ...readingPreferences, ...updates });
    setReadingPreferences(next);

    try {
      if (IS_DEMO) {
        demoSet('readingPreferences', next);
        return next;
      }

      if (userId) {
        await setDoc(doc(db, 'users', userId), {
          readingPreferences: next,
        }, { merge: true });
      }
      return next;
    } catch (updateError) {
      setReadingPreferences(previous);
      throw updateError;
    }
  }, [readingPreferences, user?.uid]);

  const updateProfilePhoto = useCallback(async (value) => {
    const userId = user?.uid;
    const previous = profilePhoto;
    const next = normalizeProfilePhoto(value);
    if (value && !next) throw new Error('La imagen procesada no es válida.');
    setProfilePhoto(next);

    try {
      if (IS_DEMO) {
        demoSet('profilePhoto', next);
        return next;
      }

      if (userId) {
        await setDoc(doc(db, 'users', userId), {
          profilePhoto: next || deleteField(),
        }, { merge: true });
      }
      return next;
    } catch (updateError) {
      setProfilePhoto(previous);
      throw updateError;
    }
  }, [profilePhoto, user?.uid]);

  // Every key here is either a primitive/state value (already stable — React
  // only replaces it when its own setter is called) or one of the callbacks
  // above, each wrapped in `useCallback` with the narrowest deps its body
  // actually reads. Wrapping this object without that would have changed
  // nothing: a `useMemo` recomputes whenever anything in its dependency list
  // has a new identity, and an unwrapped function has a new identity every
  // render regardless of what it reads.
  const value = useMemo(() => ({
    user,
    loading,
    error,
    onboardingComplete,
    userPreferences,
    followedAuthors,
    readingPreferences,
    profilePhoto,
    profileLoadError,
    signInProviders,
    signInWithGoogle,
    signInWithGitHub,
    linkGitHubAccount,
    signOut,
    completeOnboarding,
    updatePreferences,
    setUserPreferences,
    toggleFollowAuthor,
    updateReadingPreferences,
    updateProfilePhoto,
    retryProfileLoad,
    isDemo: IS_DEMO,
  }), [
    completeOnboarding, error, followedAuthors, linkGitHubAccount, loading,
    onboardingComplete, profileLoadError, profilePhoto, readingPreferences,
    retryProfileLoad, setUserPreferences, signInProviders, signInWithGitHub,
    signInWithGoogle, signOut, toggleFollowAuthor, updatePreferences,
    updateProfilePhoto, updateReadingPreferences, user, userPreferences,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
