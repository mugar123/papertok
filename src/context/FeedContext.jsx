import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { IS_DEMO, db } from '../services/firebase';
import { collection, query, where, orderBy, limit, getDocs, startAfter, doc, setDoc, deleteDoc, updateDoc, deleteField, increment } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { fetchPapers, clearCache, fetchPapersByIds, getAuthorPapers } from '../services/arxivService';
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
  const { user, userPreferences, followedAuthors } = useAuth();
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [feedMode, setFeedMode] = useState('top'); // Default to TikTok algorithm

  // Per-mode cache: { recent: { papers, page, hasMore }, top: { ... } }
  const feedCache = useRef({});

  const [likedPaperIds, setLikedPaperIds] = useState(new Set());
  const [notInterestedIds, setNotInterestedIds] = useState(new Set());
  const [savedPaperIds, setSavedPaperIds] = useState(new Set());
  const [readPaperIds, setReadPaperIds] = useState(new Set());
  const categoryAffinities = useRef({});
  const categoryCooldowns = useRef({});
  const conceptAffinities = useRef({});
  const relatedCandidates = useRef([]);

  // --- TIKTOK-STYLE SCORING & RE-RANKING ---
  const calculateAndAttachScore = useCallback((paper) => {
    let affinityScore = 0;
    if (paper.primaryCategory && categoryAffinities.current[paper.primaryCategory]) {
      affinityScore = categoryAffinities.current[paper.primaryCategory];
    }
    
    let prefScore = 0;
    if (userPreferences && userPreferences.includes(paper.primaryCategory)) {
      prefScore = 100;
    }
    
    let authorBoost = 0;
    if (paper.authors && followedAuthors && followedAuthors.length > 0) {
      if (paper.authors.some(a => followedAuthors.includes(a))) {
        authorBoost = 50; // Massive boost for followed authors
      }
    }
    
    const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = Math.max(0, 20 * Math.exp(-daysOld / 3)); // 3-day half-life for highly dynamic feed
    
    let semanticScore = 0;
    let citationBoost = 0;
    
    if (paper.openAlex) {
      if (paper.openAlex.concepts) {
        paper.openAlex.concepts.forEach(c => {
           if (conceptAffinities.current[c.id]) {
             semanticScore += c.score * conceptAffinities.current[c.id] * 20; // Massive semantic weight
           }
        });
      }
      if (paper.openAlex.cited_by_count > 0) {
        citationBoost = Math.log10(paper.openAlex.cited_by_count + 1) * 5; // Reduced citation dominance
      }
    }
    
    let graphBoost = 0;
    if (paper._isGraphCandidate) {
       graphBoost = 15;
    }
    
    let cooldownMultiplier = 1.0;
    if (paper.primaryCategory && categoryCooldowns.current[paper.primaryCategory]) {
      const daysSinceRejection = (Date.now() - categoryCooldowns.current[paper.primaryCategory]) / (1000 * 60 * 60 * 24);
      if (daysSinceRejection < 14) {
        cooldownMultiplier = 0.1 + (0.9 * (daysSinceRejection / 14)); // drops to 0.1 on recent skip
        cooldownMultiplier = Math.max(0.1, Math.min(1.0, cooldownMultiplier));
      }
    }
    
    const baseScore = affinityScore + prefScore + recencyBoost + semanticScore + citationBoost + graphBoost + authorBoost;
    const finalScore = baseScore * cooldownMultiplier;
    
    paper._dynamicScore = finalScore;
    paper._debugScore = {
      total: finalScore,
      baseTotal: baseScore,
      affinity: affinityScore,
      preference: prefScore,
      recency: recencyBoost,
      semantic: semanticScore,
      citations: citationBoost,
      graphBoost: graphBoost,
      authorBoost: authorBoost,
      cooldownMultiplier: cooldownMultiplier,
      isExploration: paper._debugScore?.isExploration || false
    };
  }, [userPreferences, followedAuthors]);

  const reRankFeed = useCallback((sourcePaperId = null) => {
    setPapers(prevPapers => {
       if (!prevPapers || prevPapers.length <= 1) return prevPapers;
       
       let splitIndex = 0;
       if (sourcePaperId) {
         const idx = prevPapers.findIndex(p => p.id === sourcePaperId);
         if (idx !== -1) splitIndex = idx;
       }
       
       // Index up to splitIndex are currently on screen or past, do not shift them under the user's feet
       const lockedPapers = prevPapers.slice(0, splitIndex + 1);
       const queue = [...prevPapers.slice(splitIndex + 1)];
       
       if (queue.length === 0) return prevPapers;
       
       queue.forEach(paper => {
          if (!paper._debugScore?.isExploration) {
            calculateAndAttachScore(paper);
          }
       });
       
       // Only sort non-exploration papers, keeping exploration papers loosely in their bottom 50% slots
       const exploitQueue = queue.filter(p => !p._debugScore?.isExploration);
       const exploreQueue = queue.filter(p => p._debugScore?.isExploration);
       
       exploitQueue.sort((a, b) => {
          const scoreA = isNaN(a._dynamicScore) ? 0 : a._dynamicScore;
          const scoreB = isNaN(b._dynamicScore) ? 0 : b._dynamicScore;
          return scoreB - scoreA;
       });
       
       // Reconstruct queue
       const newQueue = [...exploitQueue];
       exploreQueue.forEach(explorePaper => {
          // Re-inject randomly in the bottom half
          const maxInsertIndex = newQueue.length;
          const minInsertIndex = Math.floor(newQueue.length * 0.5);
          const insertIndex = minInsertIndex + Math.floor(Math.random() * (maxInsertIndex - minInsertIndex + 1));
          newQueue.splice(insertIndex, 0, explorePaper);
       });
       
       return [...lockedPapers, ...newQueue];
    });
  }, [calculateAndAttachScore]);

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

    // Real Firebase mode
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
            
            let decayFactor = 1;
            if (data.timestamp) {
              const ts = new Date(data.timestamp).getTime();
              const daysOld = (Date.now() - ts) / (1000 * 60 * 60 * 24);
              decayFactor = Math.max(0.2, Math.exp(-daysOld / 30));
              
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
            // Continuous view time: max 15 points
            if (data.viewTime) {
               const cappedTime = Math.min(data.viewTime, 60); // Cap at 60s
               impact += cappedTime * 0.25; 
            }
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
        categoryAffinities.current = affinities;
        categoryCooldowns.current = cooldowns;
        conceptAffinities.current = conceptWeights;
        relatedCandidates.current = relatedArxivIds;
      } catch (err) {
        console.error('Error loading interactions:', err);
      }
    };
    loadInteractions();
  }, [user]);

  // Load papers when preferences are available
  const loadPapers = useCallback(async (reset = false, mode, randomizeStart = false, pageOverride) => {
    if (!userPreferences || userPreferences.length === 0) return;
    if (!reset && loading) return;

    const activeMode = mode || feedMode;

    setLoading(true);
    setError(null);
    
    let currentPage = reset ? 0 : (pageOverride !== undefined ? pageOverride : page);
    if (randomizeStart) {
      // Pick a random page between 0 and 5 to avoid arXiv deep pagination timeouts
      // Deep pagination (e.g. start > 500) takes 15+ seconds on arXiv and causes our timeout to trigger
      currentPage = Math.floor(Math.random() * 5);
    }

    try {
      let newPapers = [];
      if (activeMode === 'top' || activeMode === null) {
        const allCategories = getAllLeafCategories();
        
        // Determine user's parent areas
        const userAreas = new Set();
        userPreferences.forEach(pref => {
          const leaf = allCategories.find(c => c.id === pref);
          if (leaf) userAreas.add(leaf.area);
        });

        // Setup Capa 2: Graph/Related (25%) -> candidates pool
        let candidatesToFetch = [];
        if (relatedCandidates.current && relatedCandidates.current.length > 0) {
           candidatesToFetch = [...relatedCandidates.current].sort(() => 0.5 - Math.random()).slice(0, 10);
        }

        // Setup Capa 3: Trending Científico (15%) -> Pick trending categories
        const validTrending = allCategories
          .filter(c => userAreas.has(c.area))
          .filter(c => !userPreferences.includes(c.id))
          .filter(c => (categoryAffinities.current[c.id] || 0) >= -2)
          .map(c => c.id);
        const trendingCategories = validTrending.sort(() => 0.5 - Math.random()).slice(0, 2);

        // Setup Capa 4: Exploración/Random (10%) -> Pick random categories
        const randomCats = allCategories
          .filter(c => !userPreferences.includes(c.id) && !trendingCategories.includes(c.id))
          .map(c => c.id)
          .sort(() => 0.5 - Math.random())
          .slice(0, 2);

        // COMBINED FETCH
        // Instead of making 4 parallel requests, we combine them into a single RSS/Atom request.
        const combinedCats = Array.from(new Set([...userPreferences, ...trendingCategories, ...randomCats]));
        
        const promises = [
          fetchPapers(combinedCats, currentPage * 25, 30, 'recent').catch(e => { console.warn('Combined fetch failed', e); return []; })
        ];

        if (candidatesToFetch.length > 0) {
           promises.push(fetchPapersByIds(candidatesToFetch).catch(() => []));
        } else {
           promises.push(Promise.resolve([]));
        }
        
        // Inject 1 paper from a followed author
        if (followedAuthors && followedAuthors.length > 0) {
          const randAuthor = followedAuthors[Math.floor(Math.random() * followedAuthors.length)];
          promises.push(getAuthorPapers(randAuthor, 2).catch(() => []));
        } else {
          promises.push(Promise.resolve([]));
        }

        const [combinedPapers, graphPapers, authorPapers] = await Promise.all(promises);

        // Separate the combined papers back into logic buckets to respect ratios (roughly)
        let coreToEnrich = []; 
        const exploitPapers = [];
        const trendingPapers = [];
        const randomPapers = [];
        
        combinedPapers.forEach(p => {
          const isUserPref = p.allCategories.some(c => userPreferences.includes(c));
          const isTrending = p.allCategories.some(c => trendingCategories.includes(c));
          const isRandom = p.allCategories.some(c => randomCats.includes(c));
          
          if (isUserPref) {
            exploitPapers.push(p);
          } else if (isTrending) {
            trendingPapers.push(p);
          } else if (isRandom) {
            randomPapers.push(p);
          } else {
            exploitPapers.push(p); // Fallback
          }
        });
        
        // --- OPENALEX ENRICHMENT ---
        coreToEnrich = [...exploitPapers, ...graphPapers, ...trendingPapers];

        if (authorPapers && authorPapers.length > 0) {
          authorPapers.forEach(p => {
             // We give it a special flag so it bypasses all cooldowns and gets forced to the top
             p._debugScore = { isExploration: false };
             coreToEnrich.push(p);
          });
        }


        // Tag graph papers before deduplication
        graphPapers.forEach(p => p._isGraphCandidate = true);
        
        // Deduplicate core and filter out explicitly interacted papers (DO NOT filter sessionSeenPapers here)
        const uniqueMap = new Map();
        coreToEnrich.forEach(p => {
          if (!uniqueMap.has(p.id) &&
              !likedPaperIds.has(p.id) &&
              !savedPaperIds.has(p.id) &&
              !readPaperIds.has(p.id) &&
              !notInterestedIds.has(p.id)) {
            
            uniqueMap.set(p.id, p);
          }
        });
        
        const sortedCore = Array.from(uniqueMap.values());
        
        // Calculate and attach debug scores before sorting
        sortedCore.forEach(paper => {
           calculateAndAttachScore(paper, userPreferences);
        });

        // Sort ONLY exploit + trending
        sortedCore.sort((a, b) => {
          const scoreA = isNaN(a._debugScore?.total) ? 0 : a._debugScore.total;
          const scoreB = isNaN(b._debugScore?.total) ? 0 : b._debugScore.total;
          return scoreB - scoreA;
        });

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
          // Insert randomly in the bottom 50% of the feed so they are not dominating the top
          const maxInsertIndex = newPapers.length;
          const minInsertIndex = Math.floor(newPapers.length * 0.5);
          const insertIndex = minInsertIndex + Math.floor(Math.random() * (maxInsertIndex - minInsertIndex + 1));
          newPapers.splice(insertIndex, 0, randomPaper);
        });
      } else {
        newPapers = await fetchPapers(userPreferences, currentPage * PAGE_SIZE, PAGE_SIZE, activeMode);
      }
      let filtered = newPapers.filter((p) => 
        !notInterestedIds.has(p.id) && 
        !readPaperIds.has(p.id) &&
        !likedPaperIds.has(p.id) &&
        !savedPaperIds.has(p.id) &&
        !sessionSeenPapers.has(p.id)
      );

      // If everything was filtered out but we actually fetched papers, it means the user has seen them all.
      // We must fetch the NEXT page automatically.
      if (filtered.length === 0 && newPapers.length > 0) {
        // First try bypassing sessionSeenPapers to avoid empty feed
        const bypassSeen = newPapers.filter((p) => 
          !notInterestedIds.has(p.id) && 
          !readPaperIds.has(p.id) &&
          !likedPaperIds.has(p.id) &&
          !savedPaperIds.has(p.id)
        );
        if (bypassSeen.length > 0) {
          console.log("Bypassing sessionSeenPapers filter to prevent rate limit cascade.");
          filtered = bypassSeen;
        } else if (currentPage < 10) { // Limit auto-fetch depth to avoid infinite loops
          console.log(`All fetched papers were seen and interacted, fetching page ${currentPage + 1} automatically...`);
          const nextPageToFetch = currentPage + 1;
          // Set loading to false so the next loadPapers doesn't get blocked by the `if (!reset && loading) return;` check
          setLoading(false);
          setPage(nextPageToFetch);
          
          if (loadPapersRef.current) {
            setTimeout(() => loadPapersRef.current(false, activeMode, false, nextPageToFetch), 0);
          } else {
            setTimeout(() => loadPapers(false, activeMode, false, nextPageToFetch), 0);
          }
          return;
        }
      }

      // NOW we add the final papers we are going to show to sessionSeenPapers
      filtered.forEach(p => sessionSeenPapers.add(p.id));
      saveSessionSeen();

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

      // Asynchronous OpenAlex Enrichment (Lazy Loading to prevent UI blocking)
      const arxivIdsToEnrich = nextPapers.map(p => p.id);
      enrichPapersBatch(arxivIdsToEnrich).then(openAlexData => {
         setPapers(current => {
            return current.map(p => {
               if (openAlexData[p.id]) {
                  return { ...p, openAlex: openAlexData[p.id] };
               }
               return p;
            });
         });
         // Re-rank the feed now that we have semantic scores and citation data
         // Small timeout to let React finish the state update above
         setTimeout(() => reRankFeed(), 50);
      }).catch(err => console.error("Lazy enrichment failed", err));
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

  const hasFetchedInitially = useRef(false);
  // Initial load
  useEffect(() => {
    if (userPreferences && userPreferences.length > 0 && papers.length === 0 && !hasFetchedInitially.current) {
      hasFetchedInitially.current = true;
      loadPapers(true, null, true); // randomizeStart = true to ensure fresh feed
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
      // Re-filter cached papers to ensure newly liked/saved papers are removed
      const refiltered = cached.papers.filter(p => 
        !notInterestedIds.has(p.id) && 
        !readPaperIds.has(p.id) &&
        !likedPaperIds.has(p.id) &&
        !savedPaperIds.has(p.id)
      );
      
      setPapers(refiltered);
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

    if (isCurrentlyLiked) {
      newLiked.delete(paper.id);
      if (paper.primaryCategory) categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) - 5;
    } else {
      newLiked.add(paper.id);
      if (paper.primaryCategory) categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) + 5;
      if (paper.openAlex?.concepts) {
        paper.openAlex.concepts.forEach(c => {
           conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + 1;
        });
      }
    }
    setLikedPaperIds(newLiked);
    reRankFeed();

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
  }, [user, likedPaperIds, reRankFeed]);

  const markNotInterested = useCallback(async (paper) => {
    if (!user) return;
    const newNotInterested = new Set(notInterestedIds);
    newNotInterested.add(paper.id);
    setNotInterestedIds(newNotInterested);
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));

    if (paper.primaryCategory) {
       categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) - 10;
       categoryCooldowns.current[paper.primaryCategory] = Date.now();
    }
    if (paper.openAlex?.concepts) {
      paper.openAlex.concepts.forEach(c => {
         conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) - 2;
      });
    }
    reRankFeed(paper.id);

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
  }, [user, notInterestedIds, reRankFeed]);

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
    
    // Instantly update local weights for real-time re-ranking
    if (paper.primaryCategory) {
      categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) + (Math.min(timeInSeconds, 60) * 0.25);
    }
    if (paper.openAlex?.concepts) {
      paper.openAlex.concepts.forEach(c => {
         conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + (Math.min(timeInSeconds, 60) * 0.05);
      });
    }
    if (timeInSeconds >= 3.0) {
      reRankFeed(paper.id);
    }

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
  }, [user, reRankFeed]);

  const trackPdfOpened = useCallback(async (paper) => {
    if (!user || IS_DEMO) return;
    
    // Instantly update local weights for real-time re-ranking
    if (paper.primaryCategory) {
      categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) + 4;
    }
    if (paper.openAlex?.concepts) {
      paper.openAlex.concepts.forEach(c => {
         conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + 1;
      });
    }
    reRankFeed(paper.id);

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
  }, [user, reRankFeed]);

  const trackSkip = useCallback(async (paper) => {
    if (!user || IS_DEMO) return;
    
    // Instantly update local weights for real-time re-ranking
    if (paper.primaryCategory) {
      categoryAffinities.current[paper.primaryCategory] = (categoryAffinities.current[paper.primaryCategory] || 0) - 1;
    }
    // DO NOT call reRankFeed here to prevent lag when scrolling past cards quickly

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
    reRankFeed(paper.id);
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
