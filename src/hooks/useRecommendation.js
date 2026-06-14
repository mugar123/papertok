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
  const [interactions, setInteractions] = useState([]);
  const [isProfileReady, setIsProfileReady] = useState(false);

  // Load interactions from Firestore
  useEffect(() => {
    if (!user) return;

    const loadInteractions = async () => {
      try {
        const interactionsRef = collection(db, 'users', user.uid, 'interactions');
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

        setInteractions(loaded);
        setIsProfileReady(true);
      } catch (err) {
        console.error('Error loading interactions for recommendations:', err);
        setIsProfileReady(true);
      }
    };

    loadInteractions();
  }, [user]);

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
