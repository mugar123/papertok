/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect } from 'react';
import { IS_DEMO, auth, googleProvider, db } from '../services/firebase';
import { onAuthStateChanged, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const AuthContext = createContext(null);

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
        }
        setLoading(false);
      }, 0);
      return;
    }

    let authChangeId = 0;
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      const changeId = ++authChangeId;
      setLoading(true);
      setUser(currentUser);
      setOnboardingComplete(false);
      setUserPreferences(null);
      setFollowedAuthors([]);

      if (currentUser) {
        // Fetch user data from firestore
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (changeId !== authChangeId) return;
          if (userDoc.exists()) {
            const data = userDoc.data();
            setOnboardingComplete(data.onboardingComplete || false);
            setUserPreferences(data.preferences || data.selectedCategories || null);
            setFollowedAuthors(data.followedAuthors || []);
          } else {
            setOnboardingComplete(false);
          }
        } catch (err) {
          if (changeId === authChangeId) console.error("Error fetching user data", err);
        }
      }
      if (changeId === authChangeId) setLoading(false);
    });

    return unsubscribe;
  }, []);

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
      setError(err.message);
    }
  };

  const signOut = async () => {
    if (IS_DEMO) {
      setUser(null);
      setOnboardingComplete(false);
      setUserPreferences(null);
      setFollowedAuthors([]);
      localStorage.removeItem('papertok_user');
      return;
    }
    try {
      await firebaseSignOut(auth);
    } catch (err) {
      setError(err.message);
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

  const value = {
    user,
    loading,
    error,
    onboardingComplete,
    userPreferences,
    followedAuthors,
    signInWithGoogle,
    signOut,
    completeOnboarding,
    updatePreferences,
    setUserPreferences,
    toggleFollowAuthor,
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
