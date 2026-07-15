import { useState, useEffect, useCallback, useMemo } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../services/firebase';
import { useAuth } from '../context/AuthContext';
import { buildUserProfile, rankPapers } from '../utils/recommendation';

/**
 * Custom hook for the recommendation system.
 * Loads user interactions and provides paper ranking functions.
 */
export function useRecommendation() {
  const { user } = useAuth();
  const [profileState, setProfileState] = useState({
    userId: null,
    interactions: [],
    ready: false,
  });

  // Load interactions from Firestore
  useEffect(() => {
    let cancelled = false;
    const userId = user?.uid;

    if (!userId) return undefined;

    const loadInteractions = async () => {
      try {
        const interactionsRef = collection(db, 'users', userId, 'interactions');
        const snapshot = await getDocs(interactionsRef);

        const loaded = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          loaded.push({
            paperId: doc.id,
            liked: data.liked || false,
            notInterested: data.notInterested || false,
            paper: {
              id: doc.id,
              title: data.paperTitle || '',
              summary: data.paperAbstract || '',
              authors: data.paperAuthors || [],
              primaryCategory: data.paperCategory || '',
            },
          });
        });

        if (!cancelled) {
          setProfileState({ userId, interactions: loaded, ready: true });
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Error loading interactions for recommendations:', err);
          setProfileState({ userId, interactions: [], ready: true });
        }
      }
    };

    loadInteractions();
    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const interactions = useMemo(() => (
    profileState.userId === user?.uid ? profileState.interactions : []
  ), [profileState, user?.uid]);
  const isProfileReady = Boolean(user?.uid && profileState.userId === user.uid && profileState.ready);

  // Build user profile (memoized)
  const userProfile = useMemo(() => {
    return buildUserProfile(interactions);
  }, [interactions]);

  // Rank papers for the user
  const rankPapersForUser = useCallback(
    (papers) => {
      return rankPapers(papers, userProfile);
    },
    [userProfile]
  );

  return {
    rankPapersForUser,
    userProfile,
    isProfileReady,
    interactionCount: interactions.length,
  };
}
