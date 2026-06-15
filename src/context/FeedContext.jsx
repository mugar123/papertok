import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../services/firebase';
import { collection, query, where, orderBy, limit, getDocs, startAfter, doc, setDoc, deleteDoc, updateDoc, deleteField, increment } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { fetchPapers, clearCache } from '../services/arxivService';

const FeedContext = createContext(null);
const PAGE_SIZE = 15;

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

export function FeedProvider({ children }) {
  const { user, userPreferences } = useAuth();
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [feedMode, setFeedMode] = useState('recent'); // 'recent' or 'top'

  // Per-mode cache: { recent: { papers, page, hasMore }, top: { ... } }
  const feedCache = useRef({});

  const [likedPaperIds, setLikedPaperIds] = useState(new Set());
  const [notInterestedIds, setNotInterestedIds] = useState(new Set());
  const [savedPaperIds, setSavedPaperIds] = useState(new Set());
  const [readPaperIds, setReadPaperIds] = useState(new Set());
  const [categoryAffinities, setCategoryAffinities] = useState({});

  // Load user interactions
  useEffect(() => {
    if (!user) return;

    if (IS_DEMO) {
      setLikedPaperIds(new Set(demoGet('likedPaperIds', [])));
      setNotInterestedIds(new Set(demoGet('notInterestedIds', [])));
      setSavedPaperIds(new Set(demoGet('savedPaperIds', [])));
      setReadPaperIds(new Set(demoGet('readPaperIds', [])));
      return;
    }

    // Firebase mode
    const loadInteractions = async () => {
      try {
        
        const interactionsRef = collection(db, 'users', user.uid, 'interactions');
        const snapshot = await getDocs(interactionsRef);
        const liked = new Set();
        const notInterested = new Set();
        const saved = new Set();
        const read = new Set();
        const affinities = {};
        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data.liked) liked.add(doc.id);
          if (data.notInterested) notInterested.add(doc.id);
          if (data.saved) saved.add(doc.id);
          if (data.read) read.add(doc.id);

          const cat = data.paperCategory;
          if (cat) {
            if (!affinities[cat]) affinities[cat] = 0;
            if (data.liked) affinities[cat] += 5;
            if (data.saved) affinities[cat] += 8;
            if (data.openedPdf) affinities[cat] += 4;
            if (data.viewTime) affinities[cat] += data.viewTime * 0.5;
          }
        });
        setLikedPaperIds(liked);
        setNotInterestedIds(notInterested);
        setSavedPaperIds(saved);
        setReadPaperIds(read);
        setCategoryAffinities(affinities);
      } catch (err) {
        console.error('Error loading interactions:', err);
      }
    };
    loadInteractions();
  }, [user]);

  // Load papers when preferences are available
  const loadPapers = useCallback(async (reset = false, mode, randomizeStart = false) => {
    if (!userPreferences || userPreferences.length === 0) return;
    if (!reset && loading) return;

    const activeMode = mode || feedMode;

    setLoading(true);
    setError(null);
    
    let currentPage = reset ? 0 : page;
    if (randomizeStart) {
      // Pick a random page between 0 and 5 to give a fresh slice of papers
      currentPage = Math.floor(Math.random() * 6);
    }

    try {
      let newPapers = [];
      if (activeMode === 'recent' || activeMode === null) {
        // 70% Exploit (user preferences)
        const exploitPapers = await fetchPapers(userPreferences, currentPage * 30, 30, 'recent');
        
        // 20% Trending/Popular
        const trendingCategories = ['cs.AI', 'cs.LG', 'quant-ph', 'physics.pop-ph', 'q-bio.NC'];
        const trendingPapers = await fetchPapers(trendingCategories, currentPage * 10, 10, 'recent');
        
        // 10% Random
        const randomCats = ['math.HO', 'astro-ph.GA', 'econ.GN', 'stat.ML'];
        const randomPapers = await fetchPapers(randomCats, currentPage * 5, 5, 'recent');
        
        const combined = [...exploitPapers, ...trendingPapers, ...randomPapers];
        
        // Deduplicate
        const uniqueMap = new Map();
        combined.forEach(p => {
          if (!uniqueMap.has(p.id)) uniqueMap.set(p.id, p);
        });
        
        newPapers = Array.from(uniqueMap.values());

        // Score and Sort
        newPapers.sort((a, b) => {
          const getScore = (paper) => {
            let score = 0;
            // Affinity bonus
            if (paper.primaryCategory && categoryAffinities[paper.primaryCategory]) {
              score += categoryAffinities[paper.primaryCategory];
            }
            // Preference match
            if (userPreferences.includes(paper.primaryCategory)) {
              score += 10;
            }
            // Recency boost (exponential decay, half life ~14 days)
            const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
            score += Math.max(0, 50 * Math.exp(-daysOld / 14));
            return score;
          };
          return getScore(b) - getScore(a);
        });
      } else {
        newPapers = await fetchPapers(userPreferences, currentPage * PAGE_SIZE, PAGE_SIZE, activeMode);
      }
      const filtered = newPapers.filter((p) => !notInterestedIds.has(p.id) && !readPaperIds.has(p.id));

      let nextPapers;
      let nextPage;
      if (reset) {
        nextPapers = filtered;
        nextPage = currentPage + 1;
      } else {
        const prev = papers;
        const existingIds = new Set(prev.map((p) => p.id));
        const unique = filtered.filter((p) => !existingIds.has(p.id));
        nextPapers = [...prev, ...unique];
        nextPage = currentPage + 1;
      }
      const nextHasMore = newPapers.length > 0;

      setPapers(nextPapers);
      setPage(nextPage);
      setHasMore(nextHasMore);

      // Save to cache
      feedCache.current[activeMode] = { papers: nextPapers, page: nextPage, hasMore: nextHasMore };
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [userPreferences, page, papers, loading, notInterestedIds, readPaperIds, feedMode, categoryAffinities]);

  // Initial load
  useEffect(() => {
    if (userPreferences && userPreferences.length > 0 && papers.length === 0) {
      loadPapers(true);
    }
  }, [userPreferences]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save current papers to cache before switching, then restore or fetch
  const handleSetFeedMode = useCallback((newMode) => {
    if (newMode === feedMode) return;

    // Save current state to cache
    feedCache.current[feedMode] = { papers, page, hasMore };

    // Check if we have cached data for the new mode
    const cached = feedCache.current[newMode];
    if (cached && cached.papers.length > 0) {
      setPapers(cached.papers);
      setPage(cached.page);
      setHasMore(cached.hasMore);
      setFeedMode(newMode);
    } else {
      // No cache — fetch fresh
      setPapers([]);
      setPage(0);
      setHasMore(true);
      setFeedMode(newMode);
      setTimeout(() => loadPapers(true, newMode), 0);
    }
  }, [feedMode, papers, page, hasMore, loadPapers]);

  const loadMore = useCallback(() => {
    if (hasMore && !loading) loadPapers(false);
  }, [hasMore, loading, loadPapers]);

  // Keep a ref to the latest loadPapers so refreshFeed never captures a stale closure
  const loadPapersRef = useRef(loadPapers);
  useEffect(() => { loadPapersRef.current = loadPapers; }, [loadPapers]);

  const [isRefreshing, setIsRefreshing] = useState(false);

  const refreshFeed = useCallback(async () => {
    setIsRefreshing(true);
    clearCache();
    feedCache.current = {};
    // We intentionally DO NOT clear papers here to prevent a black screen flash.
    // loadPapers will overwrite them once the fresh data arrives.
    
    // Force a minimum visual delay of 800ms so the UI has time to show the spinner
    await Promise.all([
      loadPapersRef.current(true, null, true), // reset=true, mode=null, randomizeStart=true
      new Promise((resolve) => setTimeout(resolve, 800))
    ]);
    setIsRefreshing(false);
  }, []);

  const toggleLike = useCallback(async (paper) => {
    if (!user) return;
    const isCurrentlyLiked = likedPaperIds.has(paper.id);
    const newLiked = new Set(likedPaperIds);

    if (isCurrentlyLiked) newLiked.delete(paper.id);
    else newLiked.add(paper.id);
    setLikedPaperIds(newLiked);

    if (IS_DEMO) {
      demoSet('likedPaperIds', Array.from(newLiked));
      // Store paper metadata for lists
      const allSaved = demoGet('savedPapersData', {});
      allSaved[paper.id] = {
        title: paper.title, authors: paper.authors?.slice(0, 3),
        primaryCategory: paper.primaryCategory, published: paper.published,
        arxivId: paper.arxivId, summary: paper.summary?.substring(0, 500),
      };
      demoSet('savedPapersData', allSaved);
    } else {
      try {
        
        const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
        await setDoc(ref, {
          liked: !isCurrentlyLiked,
          paperTitle: paper.title, paperAuthors: paper.authors?.slice(0, 3),
          paperCategory: paper.primaryCategory,
          paperAbstract: paper.summary?.substring(0, 500),
          timestamp: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        console.error('Error saving like:', err);
        setLikedPaperIds(likedPaperIds);
      }
    }
  }, [user, likedPaperIds]);

  const markNotInterested = useCallback(async (paper) => {
    if (!user) return;
    const newNotInterested = new Set(notInterestedIds);
    newNotInterested.add(paper.id);
    setNotInterestedIds(newNotInterested);
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));

    if (IS_DEMO) {
      demoSet('notInterestedIds', Array.from(newNotInterested));
    } else {
      try {
        
        const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
        await setDoc(ref, {
          notInterested: true, paperCategory: paper.primaryCategory,
          paperAbstract: paper.summary?.substring(0, 500),
          timestamp: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        console.error('Error saving not interested:', err);
      }
    }
  }, [user, notInterestedIds]);

  const markAsRead = useCallback(async (paper) => {
    if (!user) return;
    const newRead = new Set(readPaperIds);
    newRead.add(paper.id);
    setReadPaperIds(newRead);
    
    // Instantly remove it from the visual feed
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));

    if (IS_DEMO) {
      demoSet('readPaperIds', Array.from(newRead));
      // Save metadata for the list
      const allSaved = demoGet('savedPapersData', {});
      allSaved[paper.id] = {
        title: paper.title, authors: paper.authors?.slice(0, 3),
        primaryCategory: paper.primaryCategory, published: paper.published,
        arxivId: paper.arxivId, summary: paper.summary?.substring(0, 500),
      };
      demoSet('savedPapersData', allSaved);
    } else {
      try {
        
        const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
        await setDoc(ref, {
          read: true,
          paperTitle: paper.title, paperAuthors: paper.authors?.slice(0, 3),
          paperCategory: paper.primaryCategory, timestamp: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.error('Error saving read status:', err);
      }
    }
  }, [user, readPaperIds]);

  const trackViewTime = useCallback(async (paper, timeInSeconds) => {
    if (!user || IS_DEMO || timeInSeconds < 1) return;
    try {
      const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
      await setDoc(ref, {
        viewTime: increment(timeInSeconds),
        paperCategory: paper.primaryCategory,
        timestamp: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error('Error tracking view time:', err);
    }
  }, [user]);

  const trackPdfOpened = useCallback(async (paper) => {
    if (!user || IS_DEMO) return;
    try {
      const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
      await setDoc(ref, {
        openedPdf: true,
        paperCategory: paper.primaryCategory,
        timestamp: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error('Error tracking PDF open:', err);
    }
  }, [user]);

  const markSaved = useCallback((paperId) => {
    setSavedPaperIds((prev) => {
      const next = new Set(prev);
      next.add(paperId);
      if (IS_DEMO) demoSet('savedPaperIds', Array.from(next));
      return next;
    });
  }, []);

  const unmarkAsRead = useCallback(async (paperId) => {
    if (!user) return;
    const newRead = new Set(readPaperIds);
    newRead.delete(paperId);
    setReadPaperIds(newRead);

    if (IS_DEMO) {
      demoSet('readPaperIds', Array.from(newRead));
    } else {
      try {
        const ref = doc(db, 'users', user.uid, 'interactions', paperId);
        await updateDoc(ref, {
          read: deleteField()
        });
      } catch (err) {
        console.error('Error unmarking read status:', err);
      }
    }
  }, [user, readPaperIds]);

  const value = {
    papers, loading, error, hasMore, isRefreshing,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds,
    feedMode, setFeedMode: handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    toggleLike, markNotInterested, markSaved, markAsRead, unmarkAsRead,
  };

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (!context) throw new Error('useFeed must be used within a FeedProvider');
  return context;
}

export default FeedContext;
