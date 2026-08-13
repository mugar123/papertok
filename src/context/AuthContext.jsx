/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';
import { IS_DEMO, auth, googleProvider, db } from '../services/firebase';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { deleteField, doc, getDoc, getDocFromCache, setDoc } from 'firebase/firestore';
import {
  DEFAULT_READING_PREFERENCES,
  normalizeReadingPreferences,
} from '../utils/userSettings';
import { settleWithin } from '../utils/asyncTiming';
import { normalizeProfilePhoto } from '../utils/profileImage';
import { clearUserScopedStorage } from '../utils/userScopedStorage';

const AuthContext = createContext(null);
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
      setOnboardingComplete(false);
      setUserPreferences(null);
      setFollowedAuthors([]);
      setReadingPreferences(DEFAULT_READING_PREFERENCES);
      setProfilePhoto(null);

      if (currentUser) {
        const userRef = doc(db, 'users', currentUser.uid);
        const isCurrent = () => !disposed && changeId === authChangeId;
        const applyProfile = (snapshot) => {
          if (!snapshot?.exists() || !isCurrent()) return false;
          const data = snapshot.data();
          setOnboardingComplete(Boolean(data.onboardingComplete));
          setUserPreferences(data.preferences || data.selectedCategories || null);
          setFollowedAuthors(data.followedAuthors || []);
          setReadingPreferences(normalizeReadingPreferences(data.readingPreferences));
          setProfilePhoto(normalizeProfilePhoto(data.profilePhoto));
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
          if (!applyProfile(remote.value) && !hydratedFromCache) {
            setOnboardingComplete(false);
          }
        } else if (!hydratedFromCache) {
          setProfileLoadError('PROFILE_LOAD_FAILED');
          if (remote.status === 'rejected') {
            console.error('Error fetching user data', remote.reason);
          } else {
            console.warn('Profile loading exceeded the timeout');
          }
        }
      }
      if (!disposed && changeId === authChangeId) setLoading(false);
    });

    return () => {
      disposed = true;
      authChangeId += 1;
      unsubscribe();
    };
  }, [profileReloadKey]);

  const retryProfileLoad = () => {
    setProfileLoadError(null);
    setProfileReloadKey(key => key + 1);
  };

  const signInWithGoogle = async () => {
    setError(null);
    if (IS_DEMO) {
      setTimeout(() => {
        const demoUser = {
          uid: 'demo-user-123',
          displayName: 'Demo User',
          email: 'demo@papertok.app',
          photoURL: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Felix'
        };
        setUser(demoUser);
        demoSet('user', demoUser);
      }, 500);
      return;
    }
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(err?.code || 'AUTH_FAILED');
    }
  };

  const signOut = async () => {
    const signingOutUserId = user?.uid;
    if (IS_DEMO) {
      setUser(null);
      setOnboardingComplete(false);
      setUserPreferences(null);
      setFollowedAuthors([]);
      setReadingPreferences(DEFAULT_READING_PREFERENCES);
      setProfilePhoto(null);
      localStorage.removeItem('papertok_user');
      return;
    }
    try {
      await firebaseSignOut(auth);
      clearUserScopedStorage(signingOutUserId);
    } catch (err) {
      setError(err?.code || 'AUTH_FAILED');
    }
  };

  const completeOnboarding = async (preferences) => {
    setUserPreferences(preferences);
    setOnboardingComplete(true);
    
    if (IS_DEMO) {
      demoSet('selectedCategories', preferences);
      demoSet('onboardingComplete', true);
      return;
    }

    if (user) {
      await setDoc(doc(db, 'users', user.uid), {
        onboardingComplete: true,
        preferences
      }, { merge: true });
    }
  };

  const updatePreferences = async (newPreferences) => {
    setUserPreferences(newPreferences);
    
    if (IS_DEMO) {
      demoSet('selectedCategories', newPreferences);
      return;
    }

    if (user) {
      await setDoc(doc(db, 'users', user.uid), {
        preferences: newPreferences
      }, { merge: true });
    }
  };

  const toggleFollowAuthor = async (authorName) => {
    const newFollowed = followedAuthors.includes(authorName)
      ? followedAuthors.filter(a => a !== authorName)
      : [...followedAuthors, authorName];
    
    setFollowedAuthors(newFollowed);

    if (IS_DEMO) {
      demoSet('followedAuthors', newFollowed);
      return;
    }

    if (user) {
      await setDoc(doc(db, 'users', user.uid), {
        followedAuthors: newFollowed
      }, { merge: true });
    }
  };

  const updateReadingPreferences = async (updates) => {
    const previous = readingPreferences;
    const next = normalizeReadingPreferences({ ...readingPreferences, ...updates });
    setReadingPreferences(next);

    try {
      if (IS_DEMO) {
        demoSet('readingPreferences', next);
        return next;
      }

      if (user) {
        await setDoc(doc(db, 'users', user.uid), {
          readingPreferences: next,
        }, { merge: true });
      }
      return next;
    } catch (updateError) {
      setReadingPreferences(previous);
      throw updateError;
    }
  };

  const updateProfilePhoto = async (value) => {
    const previous = profilePhoto;
    const next = normalizeProfilePhoto(value);
    if (value && !next) throw new Error('La imagen procesada no es válida.');
    setProfilePhoto(next);

    try {
      if (IS_DEMO) {
        demoSet('profilePhoto', next);
        return next;
      }

      if (user) {
        await setDoc(doc(db, 'users', user.uid), {
          profilePhoto: next || deleteField(),
        }, { merge: true });
      }
      return next;
    } catch (updateError) {
      setProfilePhoto(previous);
      throw updateError;
    }
  };

  const value = {
    user,
    loading,
    error,
    onboardingComplete,
    userPreferences,
    followedAuthors,
    readingPreferences,
    profilePhoto,
    profileLoadError,
    signInWithGoogle,
    signOut,
    completeOnboarding,
    updatePreferences,
    setUserPreferences,
    toggleFollowAuthor,
    updateReadingPreferences,
    updateProfilePhoto,
    retryProfileLoad,
    isDemo: IS_DEMO,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
