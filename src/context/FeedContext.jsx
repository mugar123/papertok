/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useEffect, useRef, useLayoutEffect } from 'react';
import { IS_DEMO, db } from '../services/firebase';
import { collection, getDocs, doc, setDoc, updateDoc, deleteField, increment } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { useFollowing } from './FollowingContext';
import { fetchPapers, clearCache, fetchPapersByIds, getAuthorPapers } from '../services/arxivService';
import { getDeviceInfo } from '../utils/device';
import { CATEGORIES, getCategorySimilarity, getAllLeafCategories } from '../data/categories';
import { PubmedAdapter } from '../services/adapters/PubmedAdapter';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter';
import { getArxivIdsForOpenAlexWorks, enrichPapersBatch, fetchPapersByDois, getWorksByEntity } from '../services/openAlexService';
import { getPapersByProject } from '../services/openAireService';
import { getPaperRecommendations } from '../services/semanticScholarService';
import { PaperBuilder } from '../services/PaperBuilder';
import {
  applyCategoryAffinityDelta,
  applyRecommendationScore,
  diversifiedWeightedShuffle,
  logRankingBatch,
  readRecommendationWeights,
} from '../utils/recommendationEngine';
import {
  readSeenPaperIds,
  removeLegacySeenPaperIds,
  saveSeenPaperIds,
} from '../utils/userScopedStorage';

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

async function fetchFollowedEntityCandidates(followedEntities, queryMode) {
  const selected = [...(followedEntities || [])]
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  const results = await Promise.allSettled(selected.map(async (follow) => {
    let candidates = [];
    if (follow.type === 'topic') {
      const topicCategories = follow.metadata?.categoryIds?.length
        ? follow.metadata.categoryIds
        : CATEGORIES[follow.canonicalId]
          ? Object.keys(CATEGORIES[follow.canonicalId].subcategories || {})
          : [follow.canonicalId];
      candidates = await fetchPapers([...topicCategories].sort(() => 0.5 - Math.random()).slice(0, 4), Math.floor(Math.random() * 20), 3, queryMode);
    } else if (follow.type === 'author') {
      if (/^A\d+$/i.test(follow.canonicalId)) {
        candidates = (await getWorksByEntity('author', follow.canonicalId, 'publication_date:desc', 1)).papers;
      } else {
        candidates = await getAuthorPapers(follow.displayName, 3);
      }
    } else if (follow.type === 'institution') {
      candidates = (await getWorksByEntity('institution', follow.canonicalId, 'publication_date:desc', 1, '', {}, follow.displayName)).papers;
    } else if (follow.type === 'project') {
      const projectResult = await getPapersByProject(follow.canonicalId, 1);
      const [arxivPapers, doiPapers] = await Promise.all([
        fetchPapersByIds(projectResult.arxivIds || []).catch(() => []),
        fetchPapersByDois(projectResult.dois || []).catch(() => []),
      ]);
      candidates = [...arxivPapers, ...doiPapers];
    }

    return candidates.slice(0, 3).map((paper) => ({
      ...paper,
      _type: 'followed',
      _followedEntityMatches: [...new Set([...(paper._followedEntityMatches || []), follow.canonicalId])],
    }));
  }));

  return PaperBuilder.deduplicate(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
    .slice(0, 6);
}

export function FeedProvider({ children }) {
  const { user, userPreferences, followedAuthors } = useAuth();
  const { followedEntities } = useFollowing();
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [feedMode, setFeedMode] = useState('top'); // Default to TikTok algorithm
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Per-mode cache: { recent: { papers, page, hasMore }, top: { ... } }
  const feedCache = useRef({});

  const [likedPaperIds, setLikedPaperIds] = useState(new Set());
  const [notInterestedIds, setNotInterestedIds] = useState(new Set());
  const [savedPaperIds, setSavedPaperIds] = useState(new Set());
  const [readPaperIds, setReadPaperIds] = useState(new Set());
  const [recommendationProfileUserId, setRecommendationProfileUserId] = useState(null);
  const recommendationProfileReady = Boolean(user?.uid && recommendationProfileUserId === user.uid);

  // Mirror refs to prevent stale closures in asynchronous recommendation processes
  const likedPaperIdsRef = useRef(likedPaperIds);
  const savedPaperIdsRef = useRef(savedPaperIds);
  const readPaperIdsRef = useRef(readPaperIds);
  const loadPapersRef = useRef(null);
  const notInterestedIdsRef = useRef(notInterestedIds);
  const isTraversingNetwork = useRef(false);
  const feedRequestId = useRef(0);
  const feedSessionId = useRef(0);
  const activeUserId = useRef(user?.uid || null);
  const sessionSeenPapers = useRef(readSeenPaperIds(user?.uid));

  useEffect(() => { likedPaperIdsRef.current = likedPaperIds; }, [likedPaperIds]);
  useEffect(() => { savedPaperIdsRef.current = savedPaperIds; }, [savedPaperIds]);
  useEffect(() => { readPaperIdsRef.current = readPaperIds; }, [readPaperIds]);
  useEffect(() => { notInterestedIdsRef.current = notInterestedIds; }, [notInterestedIds]);
  const categoryAffinities = useRef({});
  const categoryCooldowns = useRef({});
  const conceptAffinities = useRef({});
  const relatedCandidates = useRef([]);
  const temporalPreference = useRef(0); // -1 (classic) to +1 (recent)
  const recommendationWeights = useRef(readRecommendationWeights());
  const boredomLevel = useRef(0); // 0 = happy, higher = more bored
  const BOREDOM_THRESHOLD = 5; // After 5 consecutive fast skips, start exploring

  // --- TIKTOK-STYLE SCORING & RE-RANKING ---
  const calculateAndAttachScore = useCallback((paper, recentPropsCount = {}) => {
    return applyRecommendationScore(paper, {
      userPreferences,
      followedEntities,
      categoryAffinities: categoryAffinities.current,
      categoryCooldowns: categoryCooldowns.current,
      conceptAffinities: conceptAffinities.current,
      temporalPreference: temporalPreference.current,
      weights: recommendationWeights.current,
      recentPropsCount
    });
  }, [userPreferences, followedEntities]);

  const reRankFeed = useCallback((sourcePaperId = null) => {
    setPapers(prevPapers => {
       if (!prevPapers || prevPapers.length <= 1) return prevPapers;
       
       let splitIndex = 0;
       if (sourcePaperId) {
         const idx = prevPapers.findIndex(p => p.id === sourcePaperId);
         if (idx !== -1) splitIndex = idx;
       }
       
       // Index up to splitIndex + 3 are currently on screen or next, do not shift them under the user's feet
       const safeSplit = Math.min(splitIndex + 3, prevPapers.length);
       const lockedPapers = prevPapers.slice(0, safeSplit);
       const queue = [...prevPapers.slice(safeSplit)];
        if (queue.length === 0) return prevPapers;

       const newQueue = diversifiedWeightedShuffle(queue, {
         scorePaper: calculateAndAttachScore,
         weights: recommendationWeights.current,
         initialPapers: lockedPapers,
       });
       logRankingBatch('rerank queue', newQueue);
       
       return [...lockedPapers, ...newQueue];
    });
  }, [calculateAndAttachScore]);

  const reRankFeedRef = useRef(reRankFeed);
  useLayoutEffect(() => {
    reRankFeedRef.current = reRankFeed;
  }, [reRankFeed]);

  const traverseAndExpandNetwork = useCallback(async (paper) => {
    const sessionId = feedSessionId.current;
    if (!activeUserId.current) return;
    if (isTraversingNetwork.current) {
      console.log("[Recomendador] Expansión en progreso. Petición ignorada para evitar saturación de API.");
      return;
    }
    
    isTraversingNetwork.current = true;
    try {
      let enriched = paper.openAlex;
      if (!enriched) {
        const res = await enrichPapersBatch([paper.id]);
        if (sessionId !== feedSessionId.current) return;
        const pid = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1].replace(/v\d+$/, '') : paper.id.replace(/v\d+$/, '');
        enriched = res[pid];
        if (enriched) {
          setPapers(current => current.map(p => p.id === paper.id ? PaperBuilder.merge(p, enriched, 'openalex') : p));
        }
      }
      
      let relatedArxivIds = [];
      
      try {
        // Fetch ML recommendations from Semantic Scholar first (High quality)
        const semanticRecs = await getPaperRecommendations(paper.arxivId);
        relatedArxivIds = [...semanticRecs];
      } catch (err) {
        console.warn("Semantic Scholar fetch failed", err);
      }
      if (sessionId !== feedSessionId.current) return;
      
      if (enriched && enriched.related_works && enriched.related_works.length > 0) {
        console.log(`[Recomendador] Travesando red de citas de OpenAlex para: ${paper.title}`);
        const openAlexRecs = await getArxivIdsForOpenAlexWorks(enriched.related_works);
        if (sessionId !== feedSessionId.current) return;
        relatedArxivIds = [...new Set([...relatedArxivIds, ...openAlexRecs])];
      }
        
      const filteredIds = relatedArxivIds.filter(id => 
        id &&
          !likedPaperIdsRef.current.has(id) &&
          !savedPaperIdsRef.current.has(id) &&
          !readPaperIdsRef.current.has(id) &&
          !notInterestedIdsRef.current.has(id) &&
          !sessionSeenPapers.current.has(id)
        );
        
        if (filteredIds.length === 0) return;
        
        // Fetch the top 5 papers from this citation network
        const newGraphPapers = await fetchPapersByIds(filteredIds.slice(0, 5)).catch(() => []);
        if (sessionId !== feedSessionId.current) return;
        
        if (newGraphPapers.length > 0) {
          newGraphPapers.forEach(p => {
            p._type = 'graph';
            p._isGraphCandidate = true;
            calculateAndAttachScore(p);
            sessionSeenPapers.current.add(p.id); // Mark as seen to avoid duplicate fetches
          });
          
          saveSeenPaperIds(activeUserId.current, sessionSeenPapers.current);
          
          // Insert them in the papers queue ahead of the user
          setPapers(current => {
            const idx = current.findIndex(p => p.id === paper.id);
            if (idx === -1) return current; // paper not found in current feed
            
            // Index up to idx + 3 are currently on screen or next, do not shift them
            const safeSplit = Math.min(idx + 3, current.length);
            const locked = current.slice(0, safeSplit);
            const rest = current.slice(safeSplit);
            
            // Deduplicate against rest of the queue
            const restFiltered = rest.filter(rp => !newGraphPapers.some(ng => ng.id === rp.id));
            
            // Combine rest and new papers
            const combinedRest = [...newGraphPapers, ...restFiltered];
            
            // Re-rank the unread queue using weighted shuffle
            const reRankedRest = diversifiedWeightedShuffle(combinedRest, {
              scorePaper: calculateAndAttachScore,
              weights: recommendationWeights.current,
              initialPapers: locked,
            });
            logRankingBatch('graph expansion', reRankedRest);
            
            return [...locked, ...reRankedRest];
          });
          
          console.log(`[Recomendador] Insertados ${newGraphPapers.length} papers relacionados de OpenAlex en el feed.`);
        }
    } catch (err) {
      console.error('[Recomendador] Error expandiendo la red del paper:', err);
    } finally {
      if (sessionId === feedSessionId.current) isTraversingNetwork.current = false;
    }
  }, [calculateAndAttachScore]);

  // Load user interactions
  useEffect(() => {
    let cancelled = false;
    const userId = user?.uid || null;
    const sessionId = ++feedSessionId.current;

    activeUserId.current = userId;
    sessionSeenPapers.current = readSeenPaperIds(userId);
    removeLegacySeenPaperIds();
    if (!userId) {
      return () => {
        if (feedSessionId.current === sessionId) feedSessionId.current += 1;
        activeUserId.current = null;
      };
    }

    if (IS_DEMO) {
      const timeoutId = setTimeout(() => {
        if (cancelled) return;
        setLikedPaperIds(new Set(demoGet('likedPaperIds', [])));
        setNotInterestedIds(new Set(demoGet('notInterestedIds', [])));
        setSavedPaperIds(new Set(demoGet('savedPaperIds', [])));
        setReadPaperIds(new Set(demoGet('readPaperIds', [])));
        setRecommendationProfileUserId(userId);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
        if (feedSessionId.current === sessionId) feedSessionId.current += 1;
        feedRequestId.current += 1;
        activeUserId.current = null;
      };
    }

    // Real Firebase mode
    const loadInteractions = async () => {
      try {
        const interactionsRef = collection(db, 'users', userId, 'interactions');
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
                      let penalty;
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

        if (cancelled) return;

        setLikedPaperIds(liked);
        setNotInterestedIds(notInterested);
        setSavedPaperIds(saved);
        setReadPaperIds(read);
        categoryAffinities.current = affinities;
        categoryCooldowns.current = cooldowns;
        conceptAffinities.current = {};
        relatedCandidates.current = [];
        setRecommendationProfileUserId(userId);
        
        // --- OpenAlex Semantic Profile ---
        const positiveIds = [...liked, ...saved];
        let conceptWeights = {};
        let relatedWorksPool = [];
        
        if (positiveIds.length > 0) {
           const openAlexData = await enrichPapersBatch(positiveIds);
           
           positiveIds.forEach(id => {
              const pid = id.startsWith('arxiv:') ? id.split(':')[1].replace(/v\d+$/, '') : id.replace(/v\d+$/, '');
              const data = openAlexData[pid];
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
        
        if (cancelled) return;

        conceptAffinities.current = conceptWeights;
        relatedCandidates.current = relatedArxivIds;
        reRankFeedRef.current();
      } catch (err) {
        if (!cancelled) console.error('Error loading interactions:', err);
      } finally {
        if (!cancelled) setRecommendationProfileUserId(userId);
      }
    };
    loadInteractions();

    return () => {
      cancelled = true;
      if (feedSessionId.current === sessionId) feedSessionId.current += 1;
      feedRequestId.current += 1;
      activeUserId.current = null;
    };
  }, [user?.uid]);

  // --- BOREDOM DETECTION ---
  // Tracks consecutive fast skips in the current session to detect user disengagement.
  // When the user rapidly swipes past papers, boredomLevel rises and triggers exploration.
  // Load papers when preferences are available
  const loadPapers = useCallback(async (reset = false, mode, randomizeStart = false, pageOverride) => {
    if (!userPreferences || userPreferences.length === 0) return;
    if (!recommendationProfileReady) return;
    if (!reset && loading) return;

    const activeMode = mode || feedMode;
    const requestId = ++feedRequestId.current;

    setLoading(true);
    setError(null);
    
    let currentPage = reset ? 0 : (pageOverride !== undefined ? pageOverride : page);
    if (randomizeStart) {
      currentPage = Math.floor(Math.random() * 5);
    }

    try {
      let newPapers = [];
      if (activeMode === 'top' || activeMode === null) {
        const allCategories = getAllLeafCategories();
        
        // ─── STEP 1: Rank user's selected categories by learned affinity ───
        const followedTopicIds = followedEntities
          .filter(entity => entity.type === 'topic')
          .flatMap(entity => entity.metadata?.categoryIds?.length
            ? entity.metadata.categoryIds
            : CATEGORIES[entity.canonicalId]
              ? Object.keys(CATEGORIES[entity.canonicalId].subcategories || {})
              : [entity.canonicalId]);
        const rankedPreferences = [...new Set([...userPreferences, ...followedTopicIds])].sort((a, b) => {
          const affA = categoryAffinities.current[a] || 0;
          const affB = categoryAffinities.current[b] || 0;
          return affB - affA;
        });

        // ─── STEP 2: Choose query mode based on temporal preference ───
        const pref = temporalPreference.current || 0;
        let queryMode;
        if (pref > 0.3) {
          queryMode = 'recent';
        } else if (pref < -0.3) {
          queryMode = 'relevance';
        } else {
          queryMode = Math.random() > 0.5 ? 'recent' : 'relevance';
        }

        // ─── STEP 3: Fetch from USER'S CATEGORIES ONLY ───
        let mainPapers = [];
        try {
          // Determine parent areas for each preference
          const getParentArea = (catId) => {
             for (const [areaId, area] of Object.entries(CATEGORIES)) {
               if (area.subcategories && area.subcategories[catId]) return areaId;
             }
             return null;
          };

          const arxivAllowedAreas = ['physics', 'math', 'cs', 'quant', 'eess', 'stat', 'econ', 'elec', 'mech', 'civil', 'chemeng'];
          const arxivCats = rankedPreferences.filter(c => arxivAllowedAreas.includes(getParentArea(c))).slice(0, 5);

          let arxivProm = Promise.resolve([]);
          if (arxivCats.length > 0) {
              arxivProm = fetchPapers(arxivCats, currentPage * PAGE_SIZE, PAGE_SIZE, queryMode);
          }

          const pubmedAllowedAreas = ['med', 'bio', 'q-bio'];
          const pubmedCats = rankedPreferences.filter(c => pubmedAllowedAreas.includes(getParentArea(c))).slice(0, 3);

          let pubmedProm = Promise.resolve([]);
          if (pubmedCats.length > 0) {
             const pubmedAdapter = new PubmedAdapter();
             const pubmedQuery = pubmedCats.map(c => {
                const cat = allCategories.find(x => x.id === c);
                return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
             }).join(' OR ');
             pubmedProm = pubmedAdapter.search(pubmedQuery, currentPage + 1, { internalCategories: pubmedCats }).then(res => res.papers);
          }
          
          let openAlexProm = Promise.resolve([]);
          const openAlexCats = rankedPreferences.slice(0, 5);
          if (openAlexCats.length > 0) {
             const openAlexAdapter = new OpenAlexAdapter();
             const openAlexQuery = openAlexCats.map(c => {
                const cat = allCategories.find(x => x.id === c);
                return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
             }).join(' OR ');
             openAlexProm = openAlexAdapter
               .search(openAlexQuery, currentPage + 1, { internalCategories: openAlexCats })
               .then(res => res.papers);
          }
          
          const sourceResults = await Promise.allSettled([arxivProm, pubmedProm, openAlexProm]);
          mainPapers = PaperBuilder.deduplicate(
            sourceResults.flatMap(result => result.status === 'fulfilled' ? result.value : [])
          );
          if (mainPapers.length === 0 && sourceResults.some(result => result.status === 'rejected')) {
            throw new Error('No se pudieron cargar papers de tus fuentes. Reinténtalo en unos segundos.');
          }
        } catch (e) {
          console.error("Error fetching main papers:", e);
          throw e;
        }
        
        mainPapers.forEach(p => { p._type = 'exploit'; });

        // ─── STEP 4: Graph/Related papers (semantically similar to liked) ───
        let graphPapers = [];
        if (relatedCandidates.current && relatedCandidates.current.length > 0) {
          const candidatesToFetch = [...relatedCandidates.current].sort(() => 0.5 - Math.random()).slice(0, 5);
          graphPapers = await fetchPapersByIds(candidatesToFetch).catch(() => []);
          graphPapers.forEach(p => { p._type = 'graph'; p._isGraphCandidate = true; });
        }

        // ─── STEP 5: Followed topics, authors, institutions and projects ───
        const followedPapers = followedEntities.length > 0
          ? await fetchFollowedEntityCandidates(followedEntities, queryMode).catch(() => [])
          : [];

        // ─── STEP 6: ADAPTIVE EXPLORATION (always baseline, more if bored) ───
        let explorationPapers = [];
        const currentBoredom = boredomLevel.current;
        
        const userAreas = new Set();
        userPreferences.forEach(pref => {
          const leaf = allCategories.find(c => c.id === pref);
          if (leaf) userAreas.add(leaf.area);
        });

        // Fetch adjacent categories within the user's parent areas
        const nearbyCats = allCategories
          .filter(c => userAreas.has(c.area))
          .filter(c => !userPreferences.includes(c.id))
          .filter(c => (categoryAffinities.current[c.id] || 0) >= -2)
          .map(c => c.id)
          .sort(() => 0.5 - Math.random())
          .slice(0, 3);

        const exploreCount = currentBoredom >= BOREDOM_THRESHOLD
          ? Math.min(6, Math.floor((currentBoredom - BOREDOM_THRESHOLD) / 2) + 4)
          : 2; // Baseline of 2 exploration papers

          if (nearbyCats.length > 0) {
          const randomStart = Math.floor(Math.random() * 30);
          
          let fetchedExplore = [];
          try {
            const arxivAllowedAreas = ['physics', 'math', 'cs', 'quant', 'eess', 'stat', 'econ', 'elec', 'mech', 'civil', 'chemeng'];
            const pubmedAllowedAreas = ['med', 'bio', 'q-bio'];

            const getParentArea = (catId) => {
               for (const [areaId, area] of Object.entries(CATEGORIES)) {
                 if (area.subcategories && area.subcategories[catId]) return areaId;
               }
               return null;
            };

            const arxivNearby = nearbyCats.filter(c => arxivAllowedAreas.includes(getParentArea(c)));
            let arxivProm = Promise.resolve([]);
            if (arxivNearby.length > 0) {
               arxivProm = fetchPapers(arxivNearby, randomStart, exploreCount, queryMode).catch(() => []);
            }
            
            const pubmedNearby = nearbyCats.filter(c => pubmedAllowedAreas.includes(getParentArea(c))).slice(0, 3);
            let pubmedProm = Promise.resolve([]);
            if (pubmedNearby.length > 0) {
                const pubmedQuery = pubmedNearby.map(c => {
                   const cat = allCategories.find(x => x.id === c);
                   return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
                }).join(' OR ');
                const pubmedAdapter = new PubmedAdapter();
                pubmedProm = pubmedAdapter.search(pubmedQuery, Math.floor(randomStart/25) + 1).then(res => res.papers).catch(() => []);
            }
            
            let openAlexProm = Promise.resolve([]);
            const openAlexNearby = nearbyCats.slice(0, 3);
            if (openAlexNearby.length > 0) {
                const openAlexAdapter = new OpenAlexAdapter();
                const openAlexQuery = openAlexNearby.map(c => {
                   const cat = allCategories.find(x => x.id === c);
                   return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
                }).join(' OR ');
                openAlexProm = openAlexAdapter
                  .search(openAlexQuery, Math.floor(randomStart / 25) + 1, { internalCategories: openAlexNearby })
                  .then(res => res.papers)
                  .catch(() => []);
            }
            
            const [arx, pub, oa] = await Promise.all([arxivProm, pubmedProm, openAlexProm]);
            // Limit to exploreCount
            fetchedExplore = PaperBuilder.deduplicate([...arx, ...pub, ...oa]).slice(0, exploreCount * 2);
          } catch (e) {
            console.error("Error fetching explore papers:", e);
          }

          fetchedExplore.forEach(p => { 
            p._type = 'exploration';
            p._debugScore = { isExploration: true };
          });
          explorationPapers.push(...fetchedExplore);
        }

        // If highly bored, pull from completely random categories outside user areas
        if (currentBoredom >= BOREDOM_THRESHOLD * 1.5) {
          const randomCats = allCategories
            .filter(c => !userPreferences.includes(c.id) && !nearbyCats.includes(c.id))
            .map(c => c.id)
            .sort(() => 0.5 - Math.random())
            .slice(0, 2);
          
          if (randomCats.length > 0) {
            const randomStart = Math.floor(Math.random() * 30);
            const arxivAllowedAreas = ['physics', 'math', 'cs', 'quant', 'eess', 'stat', 'econ', 'elec', 'mech', 'civil', 'chemeng'];
            const pubmedAllowedAreas = ['med', 'bio', 'q-bio'];
            
            const getParentArea = (catId) => {
               for (const [areaId, area] of Object.entries(CATEGORIES)) {
                 if (area.subcategories && area.subcategories[catId]) return areaId;
               }
               return null;
            };

            const arxivRandom = randomCats.filter(c => arxivAllowedAreas.includes(getParentArea(c)));
            let arxivProm = Promise.resolve([]);
            if (arxivRandom.length > 0) {
                arxivProm = fetchPapers(arxivRandom, randomStart, 2, queryMode).catch(() => []);
            }
            
            const pubmedRandom = randomCats.filter(c => pubmedAllowedAreas.includes(getParentArea(c)));
            let pubmedProm = Promise.resolve([]);
            if (pubmedRandom.length > 0) {
                const pubmedQuery = pubmedRandom.map(c => {
                   const cat = allCategories.find(x => x.id === c);
                   return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
                }).join(' OR ');
                const pubmedAdapter = new PubmedAdapter();
                pubmedProm = pubmedAdapter.search(pubmedQuery, Math.floor(randomStart/25) + 1).then(res => res.papers).catch(() => []);
            }
            
            let openAlexProm = Promise.resolve([]);
            const openAlexRandom = randomCats;
            if (openAlexRandom.length > 0) {
                const openAlexAdapter = new OpenAlexAdapter();
                const openAlexQuery = openAlexRandom.map(c => {
                   const cat = allCategories.find(x => x.id === c);
                   return cat && cat.labelEn ? `"${cat.labelEn}"` : `"${c.replace(/\./g, ' ')}"`;
                }).join(' OR ');
                openAlexProm = openAlexAdapter
                  .search(openAlexQuery, Math.floor(randomStart / 25) + 1, { internalCategories: openAlexRandom })
                  .then(res => res.papers)
                  .catch(() => []);
            }
            
            let randomPapers = [];
            try {
                const [arx, pub, oa] = await Promise.all([arxivProm, pubmedProm, openAlexProm]);
                randomPapers = PaperBuilder.deduplicate([...arx, ...pub, ...oa]).slice(0, 2);
            } catch (e) {
                console.error("Error fetching random bored papers:", e);
            }

            randomPapers.forEach(p => { 
              p._type = 'exploration';
              p._debugScore = { isExploration: true };
            });
            explorationPapers.push(...randomPapers);
          }
        }

        // ─── STEP 7: Merge, deduplicate, score, and shuffle ───
        const allFetched = [...mainPapers, ...graphPapers, ...followedPapers, ...explorationPapers];
        
        const uniqueMap = new Map();
        allFetched.forEach(p => {
          if (!uniqueMap.has(p.id) &&
              !likedPaperIdsRef.current.has(p.id) &&
              !savedPaperIdsRef.current.has(p.id) &&
              !readPaperIdsRef.current.has(p.id) &&
              !notInterestedIdsRef.current.has(p.id)) {
            uniqueMap.set(p.id, p);
          }
        });
        
        const corePapers = Array.from(uniqueMap.values());
        newPapers = corePapers;
      } else {
        newPapers = await fetchPapers(userPreferences, currentPage * PAGE_SIZE, PAGE_SIZE, activeMode);
      }
      if (requestId !== feedRequestId.current) return;

      let filtered = newPapers.filter((p) => 
        !notInterestedIdsRef.current.has(p.id) && 
        !readPaperIdsRef.current.has(p.id) &&
        !likedPaperIdsRef.current.has(p.id) &&
        !savedPaperIdsRef.current.has(p.id) &&
        !sessionSeenPapers.current.has(p.id)
      );

      // If everything was filtered out but we actually fetched papers, it means the user has seen them all.
      // We must fetch the NEXT page automatically.
      if (filtered.length === 0 && newPapers.length > 0) {
        // First try bypassing sessionSeenPapers to avoid empty feed
        const bypassSeen = newPapers.filter((p) => 
          !notInterestedIdsRef.current.has(p.id) && 
          !readPaperIdsRef.current.has(p.id) &&
          !likedPaperIdsRef.current.has(p.id) &&
          !savedPaperIdsRef.current.has(p.id)
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
          
          if (requestId === feedRequestId.current && loadPapersRef.current) {
            setTimeout(() => loadPapersRef.current(false, activeMode, false, nextPageToFetch), 0);
          }
          return;
        }
      }

      if (activeMode === 'top' || activeMode === null) {
        filtered = diversifiedWeightedShuffle(filtered, {
          scorePaper: calculateAndAttachScore,
          weights: recommendationWeights.current,
          initialPapers: reset ? [] : papers,
        });
        logRankingBatch('fresh feed', filtered);
      }

      // NOW we add the final papers we are going to show to sessionSeenPapers
      filtered.forEach(p => sessionSeenPapers.current.add(p.id));
      saveSeenPaperIds(activeUserId.current, sessionSeenPapers.current);

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
      const arxivIdsToEnrich = nextPapers.map(p => p.id.startsWith('arxiv:') ? p.id.split(':')[1] : p.id);
      enrichPapersBatch(arxivIdsToEnrich).then(openAlexData => {
         if (requestId !== feedRequestId.current) return;
         if (!openAlexData || Object.keys(openAlexData).length === 0) return;
         setPapers(current => {
            return current.map(p => {
               // Extract pure ID to match enrichment cache, removing any version suffix (e.g. v1)
               const rawId = p.id.startsWith('arxiv:') ? p.id.split(':')[1] : p.id;
               const pid = rawId.replace(/v\d+$/, '');
               if (openAlexData[pid]) {
                  return PaperBuilder.merge(p, openAlexData[pid], 'openalex');
               }
               return p;
            });
         });
         reRankFeed();
      }).catch(err => console.error("Lazy enrichment failed", err));
    } catch (err) {
      if (requestId === feedRequestId.current) {
        setError(err.message);
      }
    } finally {
      if (requestId === feedRequestId.current) {
        setLoading(false);
      }
    }
  }, [
    userPreferences, page, papers, loading, feedMode, 
    categoryAffinities, relatedCandidates,
    calculateAndAttachScore, followedEntities, recommendationProfileReady, reRankFeed
  ]);

  const preferencesSignatureRef = useRef(null);

  // A changed set of interests must invalidate the cached feed and replace it.
  useEffect(() => {
    const signature = Array.isArray(userPreferences)
      ? [...userPreferences].sort().join('|')
      : '';

    if (!signature || !recommendationProfileReady) {
      preferencesSignatureRef.current = null;
      return;
    }

    if (preferencesSignatureRef.current === signature) return;

    preferencesSignatureRef.current = signature;
    feedCache.current = {};
    setPapers([]);
    setPage(0);
    setHasMore(true);
    loadPapers(true, null, true);
  }, [userPreferences, recommendationProfileReady, loadPapers]);

  const followingSignatureRef = useRef('');

  useEffect(() => {
    const signature = followedEntities
      .map(entity => `${entity.type}:${entity.canonicalId}`)
      .sort()
      .join('|');
    if (followingSignatureRef.current === signature) return;
    const hadPreviousValue = Boolean(followingSignatureRef.current);
    followingSignatureRef.current = signature;
    reRankFeed();
    if (recommendationProfileReady && (signature || hadPreviousValue)) {
      feedCache.current = {};
      setPapers([]);
      setPage(0);
      setHasMore(true);
      loadPapers(true, null, true);
    }
  }, [followedEntities, loadPapers, recommendationProfileReady, reRankFeed]);

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
        !notInterestedIdsRef.current.has(p.id) && 
        !readPaperIdsRef.current.has(p.id) &&
        !likedPaperIdsRef.current.has(p.id) &&
        !savedPaperIdsRef.current.has(p.id)
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
  useLayoutEffect(() => {
    loadPapersRef.current = loadPapers;
  }, [loadPapers]);

  const refreshFeed = useCallback(async () => {
    setIsRefreshing(true);
    clearCache();
    feedCache.current = {};
    // We intentionally DO NOT clear papers here to prevent a black screen flash.
    // loadPapers will overwrite them once the fresh data arrives.
    
    // Force a minimum visual delay of 800ms so the UI has time to show the spinner
    try {
      await Promise.all([
        loadPapersRef.current?.(true, null, true), // reset=true, mode=null, randomizeStart=true
        new Promise((resolve) => setTimeout(resolve, 800))
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const toggleLike = useCallback(async (paper) => {
    const isCurrentlyLiked = likedPaperIds.has(paper.id);
    const newLiked = new Set(likedPaperIds);

    // ─── BOREDOM RESET & GRAFO EXPANSION: liking = highly engaged ───
    if (!isCurrentlyLiked) {
      boredomLevel.current = 0;
      traverseAndExpandNetwork(paper);
    }
    
    if (isCurrentlyLiked) {
      newLiked.delete(paper.id);
      applyCategoryAffinityDelta(categoryAffinities.current, paper, -5);
    } else {
      newLiked.add(paper.id);
      applyCategoryAffinityDelta(categoryAffinities.current, paper, 5);
      if (paper.openAlex?.concepts) {
        paper.openAlex.concepts.forEach(c => {
           conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + 1;
        });
      }
      
      // Update temporal preference
      const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.1);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.1);
    }
    setLikedPaperIds(newLiked);
    reRankFeed(paper.id);

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
    } else if (user) {
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
  }, [user, likedPaperIds, reRankFeed, traverseAndExpandNetwork]);

  const markNotInterested = useCallback(async (paper) => {
    if (!user) return;
    const newNotInterested = new Set(notInterestedIdsRef.current);
    newNotInterested.add(paper.id);
    setNotInterestedIds(newNotInterested);
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));

    if (paper.primaryCategory) {
       applyCategoryAffinityDelta(categoryAffinities.current, paper, -10);
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
  }, [user, reRankFeed]);

  const markAsRead = useCallback(async (paper) => {
    if (!user) return;
    const newRead = new Set(readPaperIdsRef.current);
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
  }, [user]);

  const trackViewTime = useCallback(async (paper, timeInSeconds) => {
    if (timeInSeconds < 1) return;
    
    // ─── BOREDOM RESET: user is engaging, not bored ───
    if (timeInSeconds >= 5) {
      boredomLevel.current = Math.max(0, boredomLevel.current - 3);
    }
    
    // Instantly update local weights for real-time re-ranking
    applyCategoryAffinityDelta(categoryAffinities.current, paper, Math.min(timeInSeconds, 60) * 0.25);
    if (paper.openAlex?.concepts) {
      paper.openAlex.concepts.forEach(c => {
         conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + (Math.min(timeInSeconds, 60) * 0.05);
      });
    }
    // Update temporal preference and expand graph on high dwell time
    if (timeInSeconds >= 10) {
      const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.05);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.05);
      
      // Expand network via OpenAlex
      traverseAndExpandNetwork(paper);
    }
    if (timeInSeconds >= 3.0) {
      reRankFeed(paper.id);
    }

    if (user && !IS_DEMO) {
      try {
        const ref = doc(db, 'users', user.uid, 'interactions', paper.id);
        await setDoc(ref, {
          viewTime: increment(timeInSeconds),
          paperCategory: paper.primaryCategory,
          timestamp: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        console.error('Error tracking view time:', err);
      }
    }
  }, [user, reRankFeed, traverseAndExpandNetwork]);

  const trackPdfOpened = useCallback(async (paper) => {
    // ─── BOREDOM RESET & GRAFO EXPANSION: opening PDF = highly engaged ───
    boredomLevel.current = 0;
    traverseAndExpandNetwork(paper);
    
    // Instantly update local weights for real-time re-ranking
    applyCategoryAffinityDelta(categoryAffinities.current, paper, 4);
    if (paper.openAlex?.concepts) {
      paper.openAlex.concepts.forEach(c => {
         conceptAffinities.current[c.id] = (conceptAffinities.current[c.id] || 0) + 1;
      });
    }
    reRankFeed(paper.id);

    if (user && !IS_DEMO) {
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
    }
  }, [user, reRankFeed, traverseAndExpandNetwork]);

  const trackSkip = useCallback(async (paper) => {
    // ─── BOREDOM DETECTION: fast skip = +1 boredom ───
    boredomLevel.current = Math.min(20, boredomLevel.current + 1);
    
    // Instantly update local weights for real-time re-ranking
    applyCategoryAffinityDelta(categoryAffinities.current, paper, -1);
    reRankFeed(paper.id);

    if (user && !IS_DEMO) {
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
    }
  }, [user, reRankFeed]);

  const trackPdfBounce = useCallback(async (paper) => {
    // Deduct category affinity for bounce (user opened PDF but closed it instantly)
    applyCategoryAffinityDelta(categoryAffinities.current, paper, -3);
    
    reRankFeed(paper.id);
    
    if (user && !IS_DEMO) {
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
    }
  }, [user, reRankFeed]);

  const markSaved = useCallback(async (paperOrId) => {
    const paperId = typeof paperOrId === 'string' ? paperOrId : paperOrId?.id;
    if (!paperId || savedPaperIdsRef.current.has(paperId)) return;

    const paper = typeof paperOrId === 'object'
      ? paperOrId
      : papers.find(p => p.id === paperId);

    // ─── BOREDOM RESET: saving = highly engaged ───
    boredomLevel.current = 0;
    // Attempt to update temporal preference
    if (paper) {
      applyCategoryAffinityDelta(categoryAffinities.current, paper, 8);
      const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.15);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.15);
      
      // Expand network via OpenAlex
      traverseAndExpandNetwork(paper);
    }

    const nextSaved = new Set(savedPaperIdsRef.current);
    nextSaved.add(paperId);
    savedPaperIdsRef.current = nextSaved;
    setSavedPaperIds(nextSaved);

    if (IS_DEMO) {
      demoSet('savedPaperIds', Array.from(nextSaved));
      return;
    }

    if (user) {
      try {
        const ref = doc(db, 'users', user.uid, 'interactions', paperId);
        const interactionData = {
          saved: true,
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
        };

        if (paper?.title) interactionData.paperTitle = paper.title;
        if (paper?.authors?.length) interactionData.paperAuthors = paper.authors.slice(0, 3);
        if (paper?.primaryCategory) interactionData.paperCategory = paper.primaryCategory;
        if (paper?.summary) interactionData.paperAbstract = paper.summary.substring(0, 500);

        await setDoc(ref, interactionData, { merge: true });
      } catch (err) {
        console.error('Error saving recommendation interaction:', err);
      }
    }
  }, [papers, traverseAndExpandNetwork, user]);

  const unmarkAsRead = useCallback(async (paperId) => {
    if (!user) return;
    const newRead = new Set(readPaperIdsRef.current);
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
  }, [user]);

  const getRecommendationProfileSnapshot = useCallback(() => ({
    userId: user?.uid || null,
    ready: recommendationProfileReady,
    userPreferences: [...(userPreferences || [])],
    followedAuthors: [...(followedAuthors || [])],
    followedEntities: followedEntities.map(entity => ({ ...entity })),
    categoryAffinities: { ...categoryAffinities.current },
    categoryCooldowns: { ...categoryCooldowns.current },
    conceptAffinities: { ...conceptAffinities.current },
    temporalPreference: temporalPreference.current,
    weights: { ...recommendationWeights.current },
    notInterestedIds: Array.from(notInterestedIdsRef.current),
    readPaperIds: Array.from(readPaperIdsRef.current),
  }), [followedAuthors, followedEntities, recommendationProfileReady, user?.uid, userPreferences]);

  const value = {
    papers, loading, error, hasMore, isRefreshing,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds,
    feedMode, setFeedMode: handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
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
