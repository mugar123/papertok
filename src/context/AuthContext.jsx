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

  useEffect(() => {
    if (IS_DEMO) {
      // Demo mode: check if user has "logged in" before
      const demoUser = demoGet('user', null);
      if (demoUser) {
        setUser(demoUser);
        setOnboardingComplete(demoGet('onboardingComplete', false));
        setUserPreferences(demoGet('selectedCategories', null));
      }
      setLoading(false);
      return;
    }

    // Real Firebase mode

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const userDocRef = doc(db, 'users', firebaseUser.uid);
          const userDoc = await getDoc(userDocRef);
          if (userDoc.exists()) {
            const data = userDoc.data();
            setOnboardingComplete(data.onboardingComplete || false);
            setUserPreferences(data.selectedCategories || null);
          } else {
            await setDoc(userDocRef, {
              displayName: firebaseUser.displayName,
              photoURL: firebaseUser.photoURL,
              email: firebaseUser.email,
              createdAt: new Date().toISOString(),
              onboardingComplete: false,
              selectedCategories: [],
            });
            setOnboardingComplete(false);
          }
        } catch (err) {
          console.error('Error loading user data:', err);
        }
      } else {
        setUser(null);
        setOnboardingComplete(false);
        setUserPreferences(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    setError(null);
    try {
      setLoading(true);
      if (IS_DEMO) {
        // Demo mode: simulate login
        const demoUser = {
          uid: 'demo-user-001',
          displayName: 'Demo User',
          email: 'demo@papertok.app',
          photoURL: null,
        };
        setUser(demoUser);
        demoSet('user', demoUser);
        // Check onboarding
        setOnboardingComplete(demoGet('onboardingComplete', false));
        setUserPreferences(demoGet('selectedCategories', null));
        setLoading(false);
      } else {
        await signInWithPopup(auth, googleProvider);
      }
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const signOut = async () => {
    try {
      if (IS_DEMO) {
        setUser(null);
        setOnboardingComplete(false);
        setUserPreferences(null);
        localStorage.removeItem('papertok_user');
      } else {
        await firebaseSignOut(auth);
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const completeOnboarding = async (selectedCategories) => {
    if (!user) return;
    try {
      if (IS_DEMO) {
        demoSet('onboardingComplete', true);
        demoSet('selectedCategories', selectedCategories);
      } else {
        const userDocRef = doc(db, 'users', user.uid);
        await setDoc(userDocRef, {
          onboardingComplete: true,
          selectedCategories,
        }, { merge: true });
      }
      setOnboardingComplete(true);
      setUserPreferences(selectedCategories);
    } catch (err) {
      console.error('Error saving onboarding:', err);
      setError(err.message);
    }
  };

  const updatePreferences = async (selectedCategories) => {
    if (!user) return;
    try {
      if (IS_DEMO) {
        demoSet('selectedCategories', selectedCategories);
      } else {
        const userDocRef = doc(db, 'users', user.uid);
        await setDoc(userDocRef, {
          selectedCategories,
        }, { merge: true });
      }
      setUserPreferences(selectedCategories);
    } catch (err) {
      console.error('Error updating preferences:', err);
      setError(err.message);
      throw err;
    }
  };

  const value = {
    user,
    loading,
    error,
    onboardingComplete,
    userPreferences,
    signInWithGoogle,
    signOut,
    completeOnboarding,
    updatePreferences,
    setUserPreferences,
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

export default AuthContext;
