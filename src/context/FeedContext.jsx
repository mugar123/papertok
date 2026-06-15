import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../services/firebase';
import { collection, query, where, orderBy, limit, getDocs, startAfter, doc, setDoc, deleteDoc, updateDoc, deleteField, increment } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { fetchPapers, clearCache, fetchPapersByIds } from '../services/arxivService';
import { getDeviceInfo } from '../utils/device';
import { CATEGORIES, getCategorySimilarity, getAllLeafCategories } from '../data/categories';
import { enrichPapersBatch, getArxivIdsForOpenAlexWorks } from '../services/openAlexService';

const FeedContext = createContext(null);
const PAGE_SIZE = 15;

// Global session state to ensure fresh feed on reloads
const storedSeen = typeof window !== 'undefined' ? localStorage.getItem('papertok_seenIds') : null;
const sessionSeenPapers = new Set(storedSeen ? JSON.parse(storedSeen) : []);

function saveSessionSeen() {
  const seenArray = Array.from(sessionSeenPapers).slice(-500); // Keep last 500
  localStorage.setItem('papertok_seenIds', JSON.stringify(seenArray));
}

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
  const [categoryCooldowns, setCategoryCooldowns] = useState({});
  const [conceptAffinities, setConceptAffinities] = useState({});
  const [relatedCandidates, setRelatedCandidates] = useState([]);

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
        const cooldowns = {};

        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data.liked) liked.add(doc.id);
          if (data.notInterested) notInterested.add(doc.id);
          if (data.saved) saved.add(doc.id);
          if (data.read) read.add(doc.id);

          const cat = data.paperCategory;
          if (cat) {
            if (!affinities[cat]) affinities[cat] = 0;
            
            // Time decay for historical interactions
            let decayFactor = 1;
            if (data.timestamp) {
              const ts = new Date(data.timestamp).getTime();
              const daysOld = (Date.now() - ts) / (1000 * 60 * 60 * 24);
              decayFactor = Math.max(0.2, Math.exp(-daysOld / 30)); // 30-day half life, min 0.2
              
              if (data.notInterested) {
                if (!cooldowns[cat] || ts > cooldowns[cat]) {
                  cooldowns[cat] = ts;
                }
              }
            }

            let impact = 0;
            if (data.liked) impact += 5;
            if (data.saved) impact += 8;
            if (data.openedPdf) impact += 4;
            if (data.viewTime) impact += data.viewTime * 0.5;
            if (data.skip) impact -= 1;
            if (data.pdfBounce) impact -= 2;
            if (data.notInterested) impact -= 10;
            
            affinities[cat] += impact * decayFactor;

            // Conceptual penalties for related categories on Not Interested
            if (data.notInterested) {
              Object.keys(CATEGORIES).forEach(areaKey => {
                Object.keys(CATEGORIES[areaKey].subcategories).forEach(otherCat => {
                  if (otherCat !== cat) {
                    const sim = getCategorySimilarity(cat, otherCat);
                    if (sim > 0) {
                      if (!affinities[otherCat]) affinities[otherCat] = 0;
                      let penalty = 0;
                      if (sim >= 0.8) penalty = -5;
                      else if (sim >= 0.4) penalty = -3;
                      else penalty = -1;
                      affinities[otherCat] += penalty * decayFactor;
                    }
                  }
                });
              });
            }
          }
        });
        
        // Clamping to avoid infinite bubbles
        Object.keys(affinities).forEach(cat => {
          affinities[cat] = Math.max(-10, Math.min(100, affinities[cat]));
        });
        
        // --- OpenAlex Semantic Profile ---
        const positiveIds = [...liked, ...saved];
        let conceptWeights = {};
        let relatedWorksPool = [];
        
        if (positiveIds.length > 0) {
           const openAlexData = await enrichPapersBatch(positiveIds);
           
           positiveIds.forEach(id => {
              const data = openAlexData[id];
              if (data) {
                 data.concepts.forEach(c => {
                    if (!conceptWeights[c.id]) conceptWeights[c.id] = 0;
                    conceptWeights[c.id] += c.score; // Score is confidence [0, 1]
                 });
                 if (data.related_works) {
                    relatedWorksPool.push(...data.related_works);
                 }
              }
           });
        }
        
        const relatedArxivIds = await getArxivIdsForOpenAlexWorks(relatedWorksPool);
        
        setLikedPaperIds(liked);
        setNotInterestedIds(notInterested);
        setSavedPaperIds(saved);
        setReadPaperIds(read);
        setCategoryAffinities(affinities);
        setCategoryCooldowns(cooldowns);
        setConceptAffinities(conceptWeights);
        setRelatedCandidates(relatedArxivIds);
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
      // Pick a random page between 0 and 50 to give a fresh slice of papers
      currentPage = Math.floor(Math.random() * 50);
    }

    try {
      let newPapers = [];
      if (activeMode === 'recent' || activeMode === null) {
        // CAPA 1: Exploit (50%) -> fetch userPreferences
        const exploitPapers = await fetchPapers(userPreferences, currentPage * 20, 20, 'recent');
        
        // CAPA 2: Graph/Related (25%) -> fetch from relatedCandidates pool
        let graphPapers = [];
        if (relatedCandidates && relatedCandidates.length > 0) {
           const candidatesToFetch = [...relatedCandidates].sort(() => 0.5 - Math.random()).slice(0, 10);
           graphPapers = await fetchPapersByIds(candidatesToFetch);
        }
        
        const allCategories = getAllLeafCategories();
        
        // Determine user's parent areas
        const userAreas = new Set();
        userPreferences.forEach(pref => {
          const leaf = allCategories.find(c => c.id === pref);
          if (leaf) userAreas.add(leaf.area);
        });

        // CAPA 3: Trending Científico (15%) -> Pick trending categories
        const validTrending = allCategories
          .filter(c => userAreas.has(c.area))
          .filter(c => !userPreferences.includes(c.id))
          .filter(c => (categoryAffinities[c.id] || 0) >= -2)
          .map(c => c.id);
          
        const trendingCategories = validTrending.sort(() => 0.5 - Math.random()).slice(0, 5);
        let trendingPapers = [];
        if (trendingCategories.length > 0) {
          trendingPapers = await fetchPapers(trendingCategories, currentPage * 10, 10, 'recent');
        }
        
        // CAPA 4: Exploración (10%)
        const validRandom = allCategories
          .filter(c => !userPreferences.includes(c.id))
          .filter(c => (categoryAffinities[c.id] || 0) >= -2)
          .map(c => c.id);
          
        const randomCats = validRandom.sort(() => 0.5 - Math.random()).slice(0, 4);
        let randomPapers = [];
        if (randomCats.length > 0) {
          randomPapers = await fetchPapers(randomCats, currentPage * 5, 5, 'recent');
        }
        
        // --- OPENALEX ENRICHMENT ---
        const coreToEnrich = [...exploitPapers, ...graphPapers, ...trendingPapers];
        const arxivIdsToEnrich = coreToEnrich.map(p => p.id);
        const openAlexData = await enrichPapersBatch(arxivIdsToEnrich);
        
        // Deduplicate core and filter out already seen/interacted papers
        const uniqueMap = new Map();
        coreToEnrich.forEach(p => {
          if (!uniqueMap.has(p.id) &&
              !likedPaperIds.has(p.id) &&
              !savedPaperIds.has(p.id) &&
              !readPaperIds.has(p.id) &&
              !notInterestedIds.has(p.id) &&
              !sessionSeenPapers.has(p.id)) {
            uniqueMap.set(p.id, p);
          }
        });
        
        const sortedCore = Array.from(uniqueMap.values());
        
        // Mark these as seen for the session so they don't repeat on next load
        sortedCore.forEach(p => sessionSeenPapers.add(p.id));
        saveSessionSeen();

        // Calculate and attach debug scores before sorting
        sortedCore.forEach(paper => {
          let affinityScore = 0;
          if (paper.primaryCategory && categoryAffinities[paper.primaryCategory]) {
            affinityScore = categoryAffinities[paper.primaryCategory];
          }
          
          let prefScore = 0;
          if (userPreferences.includes(paper.primaryCategory)) {
            prefScore = 20; // Increased base preference weight
          }
          
          // Reduced recency dominance, max 20 points, decays over 30 days
          const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
          const recencyBoost = Math.max(0, 20 * Math.exp(-daysOld / 30));
          
          // SEMANTIC SCORE (OpenAlex)
          let semanticScore = 0;
          let citationBoost = 0;
          
          const oaData = openAlexData[paper.id];
          if (oaData) {
            paper.openAlex = oaData; // Attach for UI display
            oaData.concepts.forEach(c => {
               if (conceptAffinities[c.id]) {
                 semanticScore += c.score * conceptAffinities[c.id] * 10; // Increased semantic weight
               }
            });
            if (oaData.cited_by_count > 0) {
              citationBoost = Math.log10(oaData.cited_by_count + 1) * 10; // Increased citation weight
            }
          }
          
          // Graph Capa 2 Boost
          let graphBoost = 0;
          if (graphPapers.some(gp => gp.id === paper.id)) {
             graphBoost = 15;
          }
          
          let cooldownMultiplier = 1.0;
          if (paper.primaryCategory && categoryCooldowns[paper.primaryCategory]) {
            const daysSinceRejection = (Date.now() - categoryCooldowns[paper.primaryCategory]) / (1000 * 60 * 60 * 24);
            if (daysSinceRejection < 14) {
              cooldownMultiplier = 0.2 + (0.8 * (daysSinceRejection / 14));
              cooldownMultiplier = Math.max(0.2, Math.min(1.0, cooldownMultiplier));
            }
          }
          
          const baseScore = affinityScore + prefScore + recencyBoost + semanticScore + citationBoost + graphBoost;
          const finalScore = baseScore * cooldownMultiplier;
          
          paper._debugScore = {
            total: finalScore,
            baseTotal: baseScore,
            affinity: affinityScore,
            preference: prefScore,
            recency: recencyBoost,
            semantic: semanticScore,
            citations: citationBoost,
            graphBoost: graphBoost,
            cooldownMultiplier: cooldownMultiplier,
            isExploration: false
          };
        });

        // Sort ONLY exploit + trending
        sortedCore.sort((a, b) => b._debugScore.total - a._debugScore.total);

        // Inject random papers dynamically (Anti-bubbles)
        newPapers = [...sortedCore];
        const uniqueRandoms = randomPapers.filter(p => !uniqueMap.has(p.id));
        
        uniqueRandoms.forEach(randomPaper => {
          randomPaper._debugScore = {
            total: 0,
            affinity: 0,
            preference: 0,
            recency: 0,
            isExploration: true
          };
          // Insert randomly in the top 80% of the feed so they are actually seen
          const maxInsertIndex = Math.max(1, Math.floor(newPapers.length * 0.8));
          const insertIndex = Math.floor(Math.random() * maxInsertIndex);
          newPapers.splice(insertIndex, 0, randomPaper);
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
  }, [
    userPreferences, page, papers, loading, feedMode, 
    notInterestedIds, readPaperIds, likedPaperIds, savedPaperIds, 
    categoryAffinities, categoryCooldowns, conceptAffinities, relatedCandidates
  ]);

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
          deviceType: getDeviceInfo().type,
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
          deviceType: getDeviceInfo().type,
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
          paperCategory: paper.primaryCategory, 
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
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
        timestamp: new Date().toISOString(),
        deviceType: getDeviceInfo().type,
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
        timestamp: new Date().toISOString(),
        deviceType: getDeviceInfo().type,
        context: 'feed',
      }, { merge: true });
    } catch (err) {
      console.error('Error tracking PDF open:', err);
    }
  }, [user]);

  const trackSkip = useCallback(async (paper) => {
    if (!user || IS_DEMO) return;
    try {
      const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
      await setDoc(ref, {
        skip: increment(1),
        paperCategory: paper.primaryCategory,
        timestamp: new Date().toISOString(),
        deviceType: getDeviceInfo().type,
        context: 'feed',
      }, { merge: true });
    } catch (err) {
      console.error('Error tracking skip:', err);
    }
  }, [user]);

  const trackPdfBounce = useCallback(async (paper) => {
    if (!user || IS_DEMO) return;
    try {
      const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
      await setDoc(ref, {
        pdfBounce: increment(1),
        paperCategory: paper.primaryCategory,
        timestamp: new Date().toISOString(),
        deviceType: getDeviceInfo().type,
        context: 'feed',
      }, { merge: true });
    } catch (err) {
      console.error('Error tracking PDF bounce:', err);
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
    trackViewTime, trackPdfOpened, trackSkip, trackPdfBounce
  };

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (!context) throw new Error('useFeed must be used within a FeedProvider');
  return context;
}

export default FeedContext;
