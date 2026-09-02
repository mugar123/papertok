/* eslint-disable react-refresh/only-export-components */
import { useContext, useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect } from 'react';
import { FeedContext } from './contexts';
import { IS_DEMO, db } from '../services/firebase';
import { doc, setDoc, updateDoc, deleteField, increment, writeBatch } from 'firebase/firestore';
import { useAuth } from './AuthContext';
import { useFollowing } from './FollowingContext';
import { fetchPapers, clearCache, fetchPapersByIds, getAuthorPapers } from '../services/arxivService';
import { getDeviceInfo } from '../utils/device';
import { CATEGORIES, getAllLeafCategories } from '../data/categories';
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
  readProfileDriftCheckedAt,
  readSeenPaperIds,
  removeLegacySeenPaperIds,
  saveProfileDriftCheckedAt,
  saveSeenPaperIds,
} from '../utils/userScopedStorage';
import { serializeLibraryPaper } from '../utils/readingLibrary';
import { isPlaceholderPaperTitle } from '../utils/paperDisplayTitle.js';
import {
  createEmptyInteractionProfile,
  curatedIds,
  isPaperKnown,
  readCategorySignals,
  recordInteractionEvent,
} from '../utils/interactionProfile';
import {
  hasInteractionProfile,
  loadInteractionProfile,
  unavailableInteractionProfile,
} from '../utils/interactionProfileLoader';
import {
  createInteractionProfileClient,
  fetchLibraryRecords,
  flushAllInteractionProfiles,
  flushInteractionProfileNow,
  scheduleInteractionProfileFlush,
} from '../services/interactionProfileStore';
import { fetchDomainPapers } from '../services/domainSourceService';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
  needsOpenAlexEnrichment,
  takeFeedPage,
} from '../utils/feedEnrichment';
import { resolveWithin, settleWithin, settleSourcesForFirstPaint, fulfilledPaperLists } from '../utils/asyncTiming';
import { shouldAbortFeedLoad } from '../utils/feedLoadGuard';
import { lateSourceCandidates } from '../utils/feedLateCandidates';
import { dedupeInteractionPapers, definedFields, selectSemanticProfilePositiveIds } from '../utils/feedInteractions';
import { fetchICiteMetrics, mergeICiteEnrichment } from '../services/iCiteService';
import { enrichPubmedIds, mergeEuropePmcEnrichment } from '../services/europePmcService';
// topicRetrievalService carries a ~32 KB gzip topic table and only matters
// once a feed load actually ranks followed topics, so it loads on first use
// instead of riding in the boot graph of every route.
const loadTopicRetrieval = () => import('../services/topicRetrievalService.js');

const PAGE_SIZE = 15;
// Per-source cap on the first-render fetch. The slowest healthy source
// measured 2.4 s in production (OpenAlex, cold edge; PubMed's serial chain
// 2.05 s); the only upstream ever seen above 4 s is OpenReview's cold 5.2 s,
// which the previous 5 s budget lost anyway after waiting the full 5 s for it.
const FEED_SOURCE_RENDER_BUDGET_MS = 4000;
const OPTIONAL_SOURCE_RENDER_BUDGET_MS = 3500;
// How long the main query may wait for the followed-topic category ids. The
// topic module is prewarmed the moment a topic follow is known (see the
// following effect), so this is normally 0 ms and the budget only ever covers
// a cold chunk on a slow connection.
const FOLLOWED_TOPIC_RANK_BUDGET_MS = 300;
const OPENALEX_FEED_REQUEST_TIMEOUT_MS = 6500;
const INTERACTIONS_NETWORK_TIMEOUT_MS = 5000;
// Upper bound on the reading-library records fetched on demand by the library
// screens. How many queries that costs depends on the `in` operator's cap,
// which is stated once in `utils/firestoreLimits.js` and nowhere else — this
// comment used to do the arithmetic itself and was still quoting a cap
// Firestore had already raised. It is reached only by an account with hundreds
// of deliberately kept papers.
const PERSONAL_LIBRARY_MAX_RECORDS = 600;
// How often a device re-checks the aggregate against its subcollection. The
// check costs a count aggregation, so it must stay off the normal feed load: at
// this cadence it is a rounding error, and drift only appears after a session
// that could not write the aggregate at all.
const PROFILE_DRIFT_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const FEED_SNAPSHOT_MAX_PAPERS = PAGE_SIZE * 2;

function feedPreferenceSignature(preferences) {
  return [...(preferences || [])].sort().join('|');
}

function feedSnapshotKey(userId, signature) {
  return `papertok_feed_snapshot_${encodeURIComponent(userId || 'guest')}_${encodeURIComponent(signature)}`;
}

function readFeedSnapshot(userId, signature) {
  if (!userId || !signature) return null;
  try {
    const snapshot = JSON.parse(localStorage.getItem(feedSnapshotKey(userId, signature)) || 'null');
    if (!snapshot || Date.now() - snapshot.savedAt > FEED_SNAPSHOT_TTL_MS || !Array.isArray(snapshot.papers)) {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function writeFeedSnapshot(userId, signature, snapshot) {
  if (!userId || !signature || !snapshot?.papers?.length) return;
  try {
    const papers = snapshot.papers.slice(0, FEED_SNAPSHOT_MAX_PAPERS).map(paper => {
      const snapshotPaper = { ...paper };
      delete snapshotPaper.raw;
      return snapshotPaper;
    });
    localStorage.setItem(feedSnapshotKey(userId, signature), JSON.stringify({
      ...snapshot,
      papers,
      savedAt: Date.now(),
    }));
  } catch {
    // A full browser storage quota must never block the feed.
  }
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

async function fetchFollowedEntityCandidates(followedEntities, queryMode) {
  const selected = [...(followedEntities || [])]
    .sort(() => 0.5 - Math.random())
    .slice(0, 4);

  const results = await Promise.allSettled(selected.map(async (follow) => {
    let candidates = [];
    if (follow.type === 'topic') {
      const { fetchTopicPapers } = await loadTopicRetrieval();
      const result = await fetchTopicPapers(follow, {
        allowLegacyDisplayName: true,
        maxPapers: 3,
        mode: queryMode,
        page: Math.floor(Math.random() * 5) + 1,
        pageSize: 5,
        timeoutMs: OPTIONAL_SOURCE_RENDER_BUDGET_MS,
      });
      candidates = result.papers;
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
      _followedEntityMatches: mergeFollowEntityMatches(paper._followedEntityMatches, [follow]),
    }));
  }));

  return PaperBuilder.deduplicate(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))
    .slice(0, 6);
}

function mergeFollowEntityMatches(...groups) {
  const matches = groups.flat().filter(match => match && typeof match === 'object');
  return matches.filter((match, index) => matches.findIndex(candidate => (
    candidate.type === match.type && candidate.canonicalId === match.canonicalId
  )) === index);
}

// Same clamp range as category affinities: without it, concept affinities grow
// unbounded and the semantic component (x20 multiplier) drowns every other signal.
const CONCEPT_AFFINITY_MIN = -10;
const CONCEPT_AFFINITY_MAX = 100;

function bumpConceptAffinities(conceptMap, paper, delta) {
  (paper?.openAlex?.concepts || []).forEach((concept) => {
    conceptMap[concept.id] = Math.max(
      CONCEPT_AFFINITY_MIN,
      Math.min(CONCEPT_AFFINITY_MAX, (conceptMap[concept.id] || 0) + delta),
    );
  });
}

// `feedRouteActive` says whether the route that actually renders this feed is
// on screen. The provider wraps every route so its consumers (save modal,
// comments, PDF viewer) exist everywhere, but the multi-source fetch fan-out
// must not: measured in production, a signed-in visit to a public profile
// fired the full source cascade for a feed nobody was looking at.
export function FeedProvider({ children, feedRouteActive = true }) {
  const { user, userPreferences, followedAuthors } = useAuth();
  const { followedEntities, loading: followingLoading } = useFollowing();
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
  const [personalLibrary, setPersonalLibrary] = useState({});
  // Paper metadata for everything the library read fetched, by id — including
  // the records `personalLibrary` filters out. See ensurePersonalLibrary.
  const [libraryPapers, setLibraryPapers] = useState({});
  const [recommendationProfileUserId, setRecommendationProfileUserId] = useState(null);
  const recommendationProfileReady = Boolean(user?.uid && recommendationProfileUserId === user.uid);

  // Mirror refs to prevent stale closures in asynchronous recommendation processes
  const likedPaperIdsRef = useRef(likedPaperIds);
  const savedPaperIdsRef = useRef(savedPaperIds);
  const readPaperIdsRef = useRef(readPaperIds);
  const loadPapersRef = useRef(null);
  const autoRetryUsedRef = useRef(false);
  const notInterestedIdsRef = useRef(notInterestedIds);
  const isTraversingNetwork = useRef(false);
  const feedRequestId = useRef(0);
  const feedSessionId = useRef(0);
  const openAlexEnrichmentAttempts = useRef(new Set());
  // Papers the slower sources returned after the page painted (see
  // utils/feedLateCandidates.js). Offered to the next page's pool, once.
  const lateSourceCandidatesRef = useRef([]);
  const openAlexEnrichmentRequests = useRef(new Map());
  const activeUserId = useRef(user?.uid || null);
  const sessionSeenPapers = useRef(readSeenPaperIds(user?.uid));
  // The derived aggregate that replaced the full interactions scan. Kept in a
  // ref because every interaction mutates it synchronously while the durable
  // write is coalesced behind it.
  const interactionProfile = useRef(createEmptyInteractionProfile());
  // False until a profile has actually been read back for this account. Writing
  // a half-built aggregate over a good one would silently reset the user's
  // recommendations, which is worse than skipping a session's deltas: the
  // interaction documents are still the source of truth either way.
  const interactionProfileHydrated = useRef(false);
  // The account whose profile is currently reflected in the state above.
  const loadedProfileUserId = useRef(null);
  // Bumped every time a profile is applied. Consumers of the reading library
  // depend on it so they retry once the ids they need actually exist.
  const [interactionProfileGeneration, setInteractionProfileGeneration] = useState(0);
  const personalLibraryStatus = useRef({ userId: null, generation: -1, state: 'idle' });

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
  // Cold users get more patience before the algorithm assumes boredom; returning
  // users have a formed profile, so their bubble deserves earlier puncturing.
  const COLD_BOREDOM_THRESHOLD = 5;
  const RETURNING_BOREDOM_THRESHOLD = 3;
  const getBoredomThreshold = () => {
    const interactionCount = likedPaperIdsRef.current.size
      + savedPaperIdsRef.current.size
      + readPaperIdsRef.current.size;
    return interactionCount > 0 ? RETURNING_BOREDOM_THRESHOLD : COLD_BOREDOM_THRESHOLD;
  };

  // Every interaction folds into the aggregate synchronously and the durable
  // write is coalesced behind a short debounce, so a burst of skips costs one
  // write rather than one per card.
  // The curated id sets are exact up to their caps. Anything evicted past a cap
  // lives on in the profile's Bloom filter, which keeps the feed's never-repeat
  // guarantee intact for accounts old enough to overflow them.
  const isKnownPaper = useCallback(
    (paperId) => isPaperKnown(interactionProfile.current, paperId),
    [],
  );

  const recordProfileEvent = useCallback((event) => {
    const userId = user?.uid;
    if (!userId || IS_DEMO) return;
    recordInteractionEvent(interactionProfile.current, event);
    if (!interactionProfileHydrated.current) return;
    scheduleInteractionProfileFlush(userId, interactionProfile.current);
  }, [user?.uid]);

  // The late-enrichment merges each call this once more (OpenAlex, then
  // iCite) after the feed has already rendered, just to persist the enriched
  // papers into the same snapshot key. Debounced: a 500ms setTimeout that a
  // second call for the SAME (userId, signature) within the window replaces,
  // so back-to-back merges from the same load pay for one serialisation of up
  // to 30 papers instead of two. Keyed by a map rather than one slot: a mode
  // switch or a preference edit can leave a previous load's late-enrichment
  // still in flight when a new one starts, and those two target different
  // storage keys — collapsing them into a single pending write would silently
  // drop whichever one lost.
  const pendingSnapshotWritesRef = useRef(new Map());
  const scheduleFeedSnapshotWrite = useCallback((userId, signature, snapshot) => {
    const writeKey = `${userId}:${signature}`;
    const pending = pendingSnapshotWritesRef.current.get(writeKey);
    if (pending) clearTimeout(pending.timer);
    const flush = () => {
      pendingSnapshotWritesRef.current.delete(writeKey);
      writeFeedSnapshot(userId, signature, snapshot);
    };
    pendingSnapshotWritesRef.current.set(writeKey, { timer: setTimeout(flush, 500), flush });
  }, []);

  useEffect(() => {
    const flush = () => {
      void flushAllInteractionProfiles();
      // Every snapshot debounced behind a 500ms timer must land before a tab
      // closing inside that window loses it — the feed relies on it to
      // restore on the next visit. Same guarantee as the interaction-profile
      // flush above, and on the same two events.
      pendingSnapshotWritesRef.current.forEach((pending) => {
        clearTimeout(pending.timer);
        pending.flush();
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // The reading library used to arrive with the feed's profile load because both
  // came out of the same full scan. It holds a serialised paper per record, so
  // it is now fetched only by the screens that render it, from the ids the
  // aggregate already knows, in bounded `in` batches.
  const ensurePersonalLibrary = useCallback(async () => {
    const userId = user?.uid;
    if (!userId || IS_DEMO) return;
    const status = personalLibraryStatus.current;
    // Keyed by generation as well as account: an attempt made before the profile
    // arrived saw no ids, and must not latch the library shut for the session.
    if (status.userId === userId
      && status.generation === interactionProfileGeneration
      && status.state !== 'idle') return;
    personalLibraryStatus.current = {
      userId, generation: interactionProfileGeneration, state: 'loading',
    };

    try {
      const profile = interactionProfile.current;
      // `liked` joins the three curated sets, and joins them LAST so the cap
      // below still favours the reading library proper.
      //
      // It is here because of what the lists screen had to do without it.
      // Favorites is assembled from the liked ids, and no read on this path
      // ever fetched them — so opening it went out for every paper one card
      // click at a time, on a connection the mount was already using. Liked ids
      // are already in the aggregate, and the fan-out that fetches them is this
      // one; asking for them here costs one larger bounded read instead of a
      // second round trip per list.
      const paperIds = [...new Set([
        ...curatedIds(profile, 'read'),
        ...curatedIds(profile, 'readLater'),
        ...curatedIds(profile, 'saved'),
        ...curatedIds(profile, 'liked'),
      ])].slice(0, PERSONAL_LIBRARY_MAX_RECORDS);

      const { records, fromCache } = await fetchLibraryRecords(userId, paperIds);
      if (activeUserId.current !== userId) {
        // Abandoned, not finished. Leaving the status on 'loading' would make
        // every later call short-circuit on a library that was never filled,
        // and the guard below is what a page reads to decide it can stop
        // showing a skeleton.
        personalLibraryStatus.current = { userId, generation: -1, state: 'idle' };
        return;
      }

      const library = {};
      /**
       * Every paper this read paid for, whatever the record turned out to be.
       *
       * `personalLibrary` means something specific — the papers the owner has
       * READ, kept for later, annotated or tagged — and the filter below is
       * what enforces it. But the filter used to be the end of the story: a
       * paper that was merely liked or merely saved was fetched, decoded and
       * thrown away, and then fetched a second time the moment a list holding
       * it was opened. Same documents, same collection, same connection.
       *
       * So the meaning stays, and the metadata is kept beside it.
       */
      const papers = {};
      records.forEach(({ id, data }) => {
        const paper = data.paper || serializeLibraryPaper({
          id,
          title: data.paperTitle || '',
          authors: data.paperAuthors || [],
          primaryCategory: data.paperCategory || '',
          published: data.timestamp || '',
        });
        // Only a real title: standing the id in for one used to paint
        // `openalex:W…` on Liked. An empty title stays empty so a later
        // fetch can fill it.
        if (paper.title && !isPlaceholderPaperTitle(paper.title, id)) papers[id] = paper;

        if (!(data.read || data.readLater || data.note || data.tags?.length)) return;
        library[id] = {
          paperId: id,
          paper,
          readLater: Boolean(data.readLater),
          readAt: data.readAt || (data.read ? data.timestamp : null),
          note: data.note || '',
          tags: Array.isArray(data.tags) ? data.tags : [],
          updatedAt: data.libraryUpdatedAt || data.timestamp || null,
        };
      });

      setPersonalLibrary(current => ({ ...library, ...current }));
      // Existing entries win, exactly as above: a paper already in hand came
      // from a screen that fetched it deliberately and may be richer.
      setLibraryPapers(current => ({ ...papers, ...current }));
      // Existing entries win, exactly as above: a paper already in hand came
      // from a screen that fetched it deliberately.
      setLibraryPapers(current => ({ ...papers, ...current }));
      // A cache-served answer is worth showing but not worth latching: with
      // the backend unreachable, getDocs resolves against the in-memory cache
      // (empty on a fresh page) instead of rejecting. Marking that 'ready'
      // froze an empty library for the session; 'idle' lets the next caller
      // ask again once the network is back.
      personalLibraryStatus.current = {
        userId,
        generation: fromCache ? -1 : interactionProfileGeneration,
        state: fromCache ? 'idle' : 'ready',
      };
    } catch (error) {
      console.error('Error loading reading library:', error);
      personalLibraryStatus.current = { userId, generation: -1, state: 'idle' };
    }
  }, [interactionProfileGeneration, user?.uid]);

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

  // Re-ranking used to run synchronously on the card-snap path (58-151ms
  // longtasks measured in production, right when the just-settled card should
  // be responsive). Deferring it to idle takes it off that path entirely: the
  // snap observer returns immediately, and the reorder — which only affects
  // cards further down the queue — lands whenever the main thread next has
  // spare time.
  //
  // `requestIdleCallback` alone is not enough: Safari only shipped it in 16.4,
  // and a permanently busy tab could starve it forever. So every scheduling
  // call carries a `timeout`, which forces the browser to run it anyway, and
  // the `setTimeout` fallback (unconditionally scheduled, no idle gating to
  // starve) covers browsers with no `requestIdleCallback` at all.
  //
  // Only one re-rank is ever pending: a later call while one is already
  // queued just updates which paper it should split around, rather than
  // resetting the timer — a stream of calls inside the timeout window must
  // not be able to push the deadline out indefinitely.
  const pendingReRankRef = useRef(null);
  const scheduleReRank = useCallback((sourcePaperId) => {
    if (pendingReRankRef.current) {
      pendingReRankRef.current.sourcePaperId = sourcePaperId;
      return;
    }
    const pending = { sourcePaperId, handle: null, isTimeout: false };
    const run = () => {
      pendingReRankRef.current = null;
      reRankFeedRef.current(pending.sourcePaperId);
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      pending.handle = window.requestIdleCallback(run, { timeout: 800 });
    } else {
      pending.isTimeout = true;
      pending.handle = setTimeout(run, 120);
    }
    pendingReRankRef.current = pending;
  }, []);

  // A deferred re-rank that fires after this provider unmounts would be a
  // `setState` on a dead component — React 19 swallows it silently, so it
  // would never surface as a warning or a test failure, only as a re-rank
  // that quietly never happened.
  useEffect(() => () => {
    const pending = pendingReRankRef.current;
    if (!pending) return;
    pendingReRankRef.current = null;
    if (pending.isTimeout) clearTimeout(pending.handle);
    else window.cancelIdleCallback?.(pending.handle);
  }, []);

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
        const pid = getOpenAlexEnrichmentId(paper);
        let enrichmentRequest = openAlexEnrichmentRequests.current.get(pid);

        if (!enrichmentRequest && !openAlexEnrichmentAttempts.current.has(pid)) {
          openAlexEnrichmentAttempts.current.add(pid);
          enrichmentRequest = enrichPapersBatch([pid]).catch((error) => {
            console.error('OpenAlex interaction enrichment failed', error);
            return {};
          });
          openAlexEnrichmentRequests.current.set(pid, enrichmentRequest);
          enrichmentRequest.finally(() => {
            if (openAlexEnrichmentRequests.current.get(pid) === enrichmentRequest) {
              openAlexEnrichmentRequests.current.delete(pid);
            }
          });
        }

        const res = enrichmentRequest ? await enrichmentRequest : {};
        if (sessionId !== feedSessionId.current) return;
        enriched = res[pid];
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
          !sessionSeenPapers.current.has(id) &&
          !isKnownPaper(id)
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
  }, [calculateAndAttachScore, isKnownPaper]);

  // Load user interactions
  useEffect(() => {
    let cancelled = false;
    let semanticIdleHandle = null;
    const userId = user?.uid || null;
    const sessionId = ++feedSessionId.current;

    activeUserId.current = userId;
    sessionSeenPapers.current = readSeenPaperIds(userId);
    removeLegacySeenPaperIds();

    // Switching accounts, or signing out, must clear the previous account's
    // papers immediately. This is the only place allowed to blank the sets: a
    // profile that merely failed to load leaves them alone.
    if (loadedProfileUserId.current && loadedProfileUserId.current !== userId) {
      setLikedPaperIds(new Set());
      setNotInterestedIds(new Set());
      setSavedPaperIds(new Set());
      setReadPaperIds(new Set());
      setPersonalLibrary({});
      interactionProfile.current = createEmptyInteractionProfile();
      interactionProfileHydrated.current = false;
      loadedProfileUserId.current = null;
      personalLibraryStatus.current = { userId: null, generation: -1, state: 'idle' };
    }
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
        setPersonalLibrary(demoGet(`readingLibrary_${userId}`, {}));
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
    //
    // This used to read the whole `interactions` subcollection, one Firestore
    // read per paper the account had ever scrolled past. It now reads a single
    // aggregate document that is maintained incrementally on every interaction.
    // The old two-phase getDocsFromCache/getDocs dance is gone with it: offline
    // persistence is deliberately off, so that cache is memory-only and empty on
    // a cold load, and it only ever paid off on a remount inside one session.
    // A single document read is a single round trip, so the timeout guard below
    // is all the protection the feed still needs against a slow Firestore.
    const loadInteractions = async () => {
      interactionProfileHydrated.current = false;
      try {
        const client = createInteractionProfileClient(userId);
        const checkedAt = readProfileDriftCheckedAt(userId);
        const checkDrift = Date.now() - checkedAt > PROFILE_DRIFT_CHECK_INTERVAL_MS;
        // Recorded whatever the outcome: a check that fails must not retry on
        // every single load.
        if (checkDrift) saveProfileDriftCheckedAt(userId, Date.now());

        const settled = await settleWithin(
          loadInteractionProfile({
            readAggregate: client.readAggregate,
            listInteractionPage: client.listInteractionPage,
            writeAggregate: client.writeAggregate,
            countInteractions: client.countInteractions,
            checkDrift,
            userId,
          }),
          INTERACTIONS_NETWORK_TIMEOUT_MS,
        );
        if (cancelled) return;

        const result = settled.status === 'fulfilled'
          ? settled.value
          : unavailableInteractionProfile({ reason: 'timeout' });

        // UNAVAILABLE means the profile could not be determined, not that it is
        // empty. Overwriting the sets here is what made a user with 39 likes see
        // none, so this path touches nothing: whatever is already on screen for
        // this account stays, and the aggregate stays unwritten.
        if (!hasInteractionProfile(result)) {
          console.warn(
            `[Recomendador] Perfil no disponible (${result.reason}); se mantiene el estado actual.`,
          );
          return;
        }

        const { profile } = result;
        if (result.repairedDrift) {
          console.info(
            `[Recomendador] Agregado reparado: le faltaban ${result.drift.missing} documentos `
            + `(${result.drift.accounted} contabilizados frente a ${result.drift.actual} reales).`,
          );
        }
        if (result.rebuilt) {
          console.info(
            `[Recomendador] Perfil reconstruido desde ${result.documentsRead} interacciones`
            + `${result.truncated ? ' (truncado en el tope duro)' : ''}.`,
          );
        }
        interactionProfile.current = profile;
        // A profile that genuinely came back — including a legitimately empty one
        // for a new account — is safe to write back.
        interactionProfileHydrated.current = true;
        loadedProfileUserId.current = userId;

        // getDocs returned these ids ordered by document id, and the lists that
        // render them still expect exactly that order.
        const orderedSet = name => new Set(curatedIds(profile, name).sort());
        const liked = orderedSet('liked');
        const notInterested = orderedSet('notInterested');
        const saved = orderedSet('saved');
        const read = orderedSet('read');
        const { affinities, cooldowns } = readCategorySignals(profile);

        setLikedPaperIds(liked);
        setNotInterestedIds(notInterested);
        setSavedPaperIds(saved);
        setReadPaperIds(read);
        // The reading library is no longer a side effect of the feed's profile
        // load. It carries a serialised paper per record, which is exactly the
        // payload that must not ride along on every feed load, so the screens
        // that render it call ensurePersonalLibrary() instead.
        setPersonalLibrary({});
        // Bumping the generation gives ensurePersonalLibrary a new identity, so
        // the screens that already asked for the library while the profile was
        // still loading ask again now that it has ids to work with.
        setInteractionProfileGeneration(generation => generation + 1);
        categoryAffinities.current = affinities;
        categoryCooldowns.current = cooldowns;
        conceptAffinities.current = {};
        relatedCandidates.current = [];
        setRecommendationProfileUserId(userId);

        // OpenAlex concept weights are a ranking overlay, not a gate. Cap the
        // sample and run it after the first source wave has the network, so a
        // large liked library cannot stall the first cards. The sample comes
        // from the aggregate's own order (newest first): `liked`/`saved` above
        // are Sets sorted by id for the lists, and cutting those to 24 kept
        // the alphabetically-first likes forever (audit 2026-09-02, A3).
        const positiveIds = selectSemanticProfilePositiveIds(
          curatedIds(profile, 'liked'),
          curatedIds(profile, 'saved'),
        );
        const scheduleIdle = typeof requestIdleCallback === 'function'
          ? (fn) => requestIdleCallback(fn, { timeout: 2500 })
          : (fn) => setTimeout(fn, 0);
        const semanticIdleHandleId = scheduleIdle(() => {
          void (async () => {
            if (cancelled) return;
            let conceptWeights = {};
            let relatedWorksPool = [];
            if (positiveIds.length > 0) {
              const openAlexData = await enrichPapersBatch(positiveIds);
              if (cancelled) return;
              positiveIds.forEach((id) => {
                const pid = id.startsWith('arxiv:') ? id.split(':')[1].replace(/v\d+$/, '') : id.replace(/v\d+$/, '');
                const data = openAlexData[pid];
                if (!data) return;
                data.concepts.forEach((c) => {
                  if (!conceptWeights[c.id]) conceptWeights[c.id] = 0;
                  conceptWeights[c.id] += c.score;
                });
                if (data.related_works) {
                  relatedWorksPool.push(...data.related_works);
                }
              });
            }
            const relatedArxivIds = await getArxivIdsForOpenAlexWorks(relatedWorksPool);
            if (cancelled) return;
            Object.keys(conceptWeights).forEach((id) => {
              conceptWeights[id] = Math.max(CONCEPT_AFFINITY_MIN, Math.min(CONCEPT_AFFINITY_MAX, conceptWeights[id]));
            });
            conceptAffinities.current = conceptWeights;
            relatedCandidates.current = relatedArxivIds;
            reRankFeedRef.current();
          })();
        });
        semanticIdleHandle = semanticIdleHandleId;
      } catch (err) {
        if (!cancelled) console.error('Error loading interactions:', err);
      } finally {
        if (!cancelled) setRecommendationProfileUserId(userId);
      }
    };
    loadInteractions();

    return () => {
      cancelled = true;
      if (semanticIdleHandle != null) {
        if (typeof cancelIdleCallback === 'function') {
          try { cancelIdleCallback(semanticIdleHandle); }
          catch { clearTimeout(semanticIdleHandle); }
        } else {
          clearTimeout(semanticIdleHandle);
        }
      }
      // Anything still sitting in the write debounce belongs to the account we
      // are leaving, so it has to land before the profile ref is reused.
      if (userId && interactionProfileHydrated.current) void flushInteractionProfileNow(userId);
      if (feedSessionId.current === sessionId) feedSessionId.current += 1;
      feedRequestId.current += 1;
      activeUserId.current = null;
    };
  }, [isKnownPaper, user?.uid]);

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
    const activeSessionId = feedSessionId.current;

    if (reset) {
      openAlexEnrichmentAttempts.current.clear();
      openAlexEnrichmentRequests.current.clear();
      lateSourceCandidatesRef.current = [];
    }

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
        
        // Followed topics widen the main query. The lookup used to be an
        // unbounded `await loadTopicRetrieval()` in front of every source;
        // dropping it altogether left a followed topic worth at most six
        // papers (audit 2026-09-02, A4). It is budgeted now, and normally
        // served from the module the following effect already warmed.
        const followedTopicIds = followedEntities.some(entity => entity?.type === 'topic')
          ? await resolveWithin(
            loadTopicRetrieval().then(module => module.getFollowedTopicCategoryIds(followedEntities)),
            FOLLOWED_TOPIC_RANK_BUDGET_MS,
            [],
          )
          : [];
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

        // Optional recommendation signals run alongside the primary sources.
        // They enrich the mix when available without extending first paint.
        const graphCandidatesPromise = relatedCandidates.current?.length > 0
          ? resolveWithin(
              fetchPapersByIds([...relatedCandidates.current].sort(() => 0.5 - Math.random()).slice(0, 5)),
              OPTIONAL_SOURCE_RENDER_BUDGET_MS,
              [],
            )
          : Promise.resolve([]);
        const followedCandidatesPromise = followedEntities.length > 0
          ? resolveWithin(
              fetchFollowedEntityCandidates(followedEntities, queryMode),
              OPTIONAL_SOURCE_RENDER_BUDGET_MS,
              [],
            )
          : Promise.resolve([]);

        // ─── STEP 3: Fetch from USER'S CATEGORIES ONLY ───
        let mainPapers = [];
        let mainSourceResults = [];
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
          
          const domainProm = fetchDomainPapers(
            rankedPreferences.slice(0, 5),
            currentPage + 1,
            8,
            queryMode,
          );

          const { first, all } = settleSourcesForFirstPaint(
            [arxivProm, pubmedProm, openAlexProm, domainProm],
            FEED_SOURCE_RENDER_BUDGET_MS,
            (papers) => PaperBuilder.deduplicate(papers).length >= PAGE_SIZE,
          );
          let sourceResults = await first;
          mainPapers = PaperBuilder.deduplicate(fulfilledPaperLists(sourceResults));
          if (mainPapers.length === 0) {
            sourceResults = await all;
            mainPapers = PaperBuilder.deduplicate(fulfilledPaperLists(sourceResults));
          } else {
            // The sources still running answer into the next page's pool.
            // Guarded by session, not request: a later page of the same
            // session is exactly who should receive them.
            const painted = mainPapers;
            all.then((settled) => {
              if (feedSessionId.current !== activeSessionId) return;
              lateSourceCandidatesRef.current = lateSourceCandidates(painted, settled);
            });
          }
          mainSourceResults = sourceResults;
        } catch (e) {
          console.error("Error fetching main papers:", e);
          throw e;
        }

        mainPapers.forEach(p => { p._type = 'exploit'; });

        // ─── STEP 4: Graph/Related papers (semantically similar to liked) ───
        const graphPapers = await graphCandidatesPromise;
        graphPapers.forEach(p => { p._type = 'graph'; p._isGraphCandidate = true; });

        // ─── STEP 5: Followed topics, authors, institutions and projects ───
        const followedPapers = await followedCandidatesPromise;

        // Only give up when the OPTIONAL candidates cannot bootstrap the feed
        // either: a dead arXiv must not blank a feed that graph/followed papers
        // could populate on their own.
        if (shouldAbortFeedLoad(mainSourceResults, mainPapers, graphPapers, followedPapers)) {
          throw new Error('No scientific provider returned usable papers.');
        }

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

        const boredomThreshold = getBoredomThreshold();
        const exploreCount = currentBoredom >= boredomThreshold
          ? Math.min(8, Math.floor((currentBoredom - boredomThreshold) / 2) + 5)
          : 5; // Baseline exploration: cold-start users deserve real serendipity

        // The first screen already has a broad multi-source candidate pool. Defer
        // extra exploration network calls to prefetched pages so initial entry is fast.
        if (!reset && nearbyCats.length > 0) {
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
            
            const domainProm = fetchDomainPapers(
              nearbyCats.slice(0, 3),
              Math.floor(randomStart / 25) + 1,
              exploreCount,
              queryMode,
            ).catch(() => []);

            const [arx, pub, oa, domain] = await Promise.all(
              [arxivProm, pubmedProm, openAlexProm, domainProm]
                .map(sourcePromise => resolveWithin(sourcePromise, FEED_SOURCE_RENDER_BUDGET_MS, []))
            );
            // Limit to exploreCount
            fetchedExplore = PaperBuilder.deduplicate([...arx, ...pub, ...oa, ...domain]).slice(0, exploreCount * 2);
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
        if (!reset && currentBoredom >= boredomThreshold * 1.5) {
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
                const domainProm = fetchDomainPapers(
                  randomCats,
                  Math.floor(randomStart / 25) + 1,
                  2,
                  queryMode,
                ).catch(() => []);
                const [arx, pub, oa, domain] = await Promise.all(
                  [arxivProm, pubmedProm, openAlexProm, domainProm]
                    .map(sourcePromise => resolveWithin(sourcePromise, FEED_SOURCE_RENDER_BUDGET_MS, []))
                );
                randomPapers = PaperBuilder.deduplicate([...arx, ...pub, ...oa, ...domain]).slice(0, 2);
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
        const lateMain = lateSourceCandidatesRef.current.splice(0);
        lateMain.forEach(p => { p._type = 'exploit'; });
        const allFetched = [...mainPapers, ...lateMain, ...graphPapers, ...followedPapers, ...explorationPapers];
        
        const uniqueMap = new Map();
        allFetched.forEach(p => {
          const existing = uniqueMap.get(p.id);
          if (existing) {
            existing._followedEntityMatches = mergeFollowEntityMatches(
              existing._followedEntityMatches,
              p._followedEntityMatches,
            );
          } else if (!likedPaperIdsRef.current.has(p.id) &&
              !savedPaperIdsRef.current.has(p.id) &&
              !readPaperIdsRef.current.has(p.id) &&
              !notInterestedIdsRef.current.has(p.id) &&
              !isKnownPaper(p.id)) {
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
        !sessionSeenPapers.current.has(p.id) &&
        !isKnownPaper(p.id)
      );

      // If everything was filtered out but we actually fetched papers, it means the user has seen them all.
      // We must fetch the NEXT page automatically.
      if (filtered.length === 0 && newPapers.length > 0) {
        // First try bypassing sessionSeenPapers to avoid empty feed
        const bypassSeen = newPapers.filter((p) => 
          !notInterestedIdsRef.current.has(p.id) && 
          !readPaperIdsRef.current.has(p.id) &&
          !likedPaperIdsRef.current.has(p.id) &&
          !savedPaperIdsRef.current.has(p.id) &&
          !isKnownPaper(p.id)
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

      // Source adapters intentionally return a wider candidate pool. Select the
      // visible page before enrichment so every page fits in one OpenAlex batch.
      // Otherwise later pages could exceed the wait budget and lose all metadata,
      // even when the first chunk had already succeeded.
      if (activeMode === 'top' || activeMode === null) {
        filtered = diversifiedWeightedShuffle(filtered, {
          scorePaper: calculateAndAttachScore,
          weights: recommendationWeights.current,
          initialPapers: reset ? [] : papers,
        });
      }
      filtered = takeFeedPage(filtered, PAGE_SIZE);

      const enrichmentIds = [...new Set(
        filtered
          .filter(needsOpenAlexEnrichment)
          .map(getOpenAlexEnrichmentId)
          .filter(Boolean)
      )];
      const enrichmentPromise = enrichPapersBatch(enrichmentIds, {
        timeoutMs: OPENALEX_FEED_REQUEST_TIMEOUT_MS,
      }).catch((err) => {
        console.error('OpenAlex feed enrichment failed', err);
        return {};
      });

      enrichmentIds.forEach((id) => {
        openAlexEnrichmentAttempts.current.add(id);
        openAlexEnrichmentRequests.current.set(id, enrichmentPromise);
      });
      enrichmentPromise.then((enrichmentById) => {
        enrichmentIds.forEach((id) => {
          if (!enrichmentById[id]) openAlexEnrichmentAttempts.current.delete(id);
        });
      });
      enrichmentPromise.finally(() => {
        enrichmentIds.forEach((id) => {
          if (openAlexEnrichmentRequests.current.get(id) === enrichmentPromise) {
            openAlexEnrichmentRequests.current.delete(id);
          }
        });
      });

      const iCitePmids = [...new Set(filtered.map(paper => paper?.pmid).filter(Boolean))];
      const iCitePromise = fetchICiteMetrics(iCitePmids);
      // Same pmids, same moment: after the page is on screen. ade641a took
      // this out of PubmedAdapter to win the first-page race and nothing
      // picked it up again (audit 2026-09-02, A2). A failure here is a page
      // without Europe PMC data, never a page that fails to paint.
      const europePmcPromise = enrichPubmedIds(iCitePmids).catch((err) => {
        console.warn('Europe PMC feed enrichment failed', err);
        return new Map();
      });
      if (requestId !== feedRequestId.current) return;

      // Paint now. A second shuffle after enrichment used to reorder the
      // cards the reader had just started looking at; late merge keeps order
      // and identity (paperFieldsEqual) so citations appear in place.
      if (activeMode === 'top' || activeMode === null) {
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
      autoRetryUsedRef.current = false; // successful load re-arms the safety retry

      // Save to cache
      feedCache.current[activeMode] = { papers: nextPapers, page: nextPage, hasMore: nextHasMore };
      const preferenceSignature = feedPreferenceSignature(userPreferences);
      // This write is synchronous and bypasses the debounce map on purpose —
      // it's the primary persist, not a merge, so it should land immediately.
      // But it shares its localStorage key (userId, preferenceSignature) with
      // whatever an in-flight enrichment's `scheduleFeedSnapshotWrite` may
      // already have pending from an earlier `loadPapers` call (feedSessionId
      // does not guard this key — only `traverseAndExpandNetwork` bumps it):
      // an enrichment can schedule against a smaller, older cache object,
      // and if this fresher write lands before that timer fires, the stale
      // one would overwrite it 500ms later and regress the snapshot. Cancel
      // any pending write for this exact key first so this fresher write is
      // always the one left standing.
      const snapshotWriteKey = `${activeUserId.current}:${preferenceSignature}`;
      const pendingSnapshotWrite = pendingSnapshotWritesRef.current.get(snapshotWriteKey);
      if (pendingSnapshotWrite) {
        clearTimeout(pendingSnapshotWrite.timer);
        pendingSnapshotWritesRef.current.delete(snapshotWriteKey);
      }
      writeFeedSnapshot(activeUserId.current, preferenceSignature, feedCache.current[activeMode]);

      if (enrichmentIds.length > 0) {
        enrichmentPromise.then((lateEnrichment) => {
          if (feedSessionId.current !== activeSessionId || !lateEnrichment || Object.keys(lateEnrichment).length === 0) return;
          setPapers(current => {
            const enriched = mergeOpenAlexEnrichment(current, lateEnrichment);
            const cachedMode = feedCache.current[activeMode];
            if (cachedMode) {
              feedCache.current[activeMode] = { ...cachedMode, papers: enriched };
              scheduleFeedSnapshotWrite(activeUserId.current, preferenceSignature, feedCache.current[activeMode]);
            }
            return enriched;
          });
        });
      }

      if (iCitePmids.length > 0) {
        iCitePromise.then((lateMetrics) => {
          if (feedSessionId.current !== activeSessionId || !lateMetrics || Object.keys(lateMetrics).length === 0) return;
          setPapers(current => {
            const enriched = mergeICiteEnrichment(current, lateMetrics);
            const cachedMode = feedCache.current[activeMode];
            if (cachedMode) {
              feedCache.current[activeMode] = { ...cachedMode, papers: enriched };
              scheduleFeedSnapshotWrite(activeUserId.current, preferenceSignature, feedCache.current[activeMode]);
            }
            return enriched;
          });
        });

        europePmcPromise.then((lateRecords) => {
          if (feedSessionId.current !== activeSessionId || !lateRecords || lateRecords.size === 0) return;
          setPapers(current => {
            const enriched = mergeEuropePmcEnrichment(current, lateRecords);
            const cachedMode = feedCache.current[activeMode];
            if (cachedMode) {
              feedCache.current[activeMode] = { ...cachedMode, papers: enriched };
              scheduleFeedSnapshotWrite(activeUserId.current, preferenceSignature, feedCache.current[activeMode]);
            }
            return enriched;
          });
        });
      }

    } catch {
      if (requestId === feedRequestId.current) {
        setError('FEED_LOAD_FAILED');
        // A transient multi-source failure used to require a manual reload.
        // Retry ONCE per session automatically; further failures keep the
        // error state with its manual "Reintentar" so there is no cascade.
        if (reset && !autoRetryUsedRef.current) {
          autoRetryUsedRef.current = true;
          setTimeout(() => {
            if (requestId === feedRequestId.current && feedSessionId.current === activeSessionId) {
              loadPapersRef.current?.(true, activeMode);
            }
          }, 2500);
        }
      }
    } finally {
      if (requestId === feedRequestId.current) {
        setLoading(false);
      }
    }
  }, [
    userPreferences, page, papers, loading, feedMode,
    categoryAffinities, relatedCandidates, isKnownPaper,
    calculateAndAttachScore, followedEntities, recommendationProfileReady,
    scheduleFeedSnapshotWrite,
  ]);

  const preferencesSignatureRef = useRef(null);
  const restoredSnapshotKeyRef = useRef('');

  useEffect(() => {
    const signature = feedPreferenceSignature(userPreferences);
    const restoreKey = user?.uid && signature ? `${user.uid}:${signature}` : '';
    if (restoredSnapshotKeyRef.current === restoreKey) return;
    restoredSnapshotKeyRef.current = restoreKey;

    const snapshot = readFeedSnapshot(user?.uid, signature);
    const restoreTimer = setTimeout(() => {
      if (snapshot?.papers?.length) {
        feedCache.current[feedMode] = snapshot;
        setPapers(snapshot.papers);
        setPage(snapshot.page || 0);
        setHasMore(snapshot.hasMore !== false);
      } else if (restoreKey) {
        setPapers([]);
        setPage(0);
        setHasMore(true);
      }
    }, 0);
    return () => clearTimeout(restoreTimer);
  }, [feedMode, isKnownPaper, user?.uid, userPreferences]);

  // A changed set of interests must invalidate the cached feed and replace it.
  // A plain cold mount must not: restoring the snapshot and then firing a
  // replacing refresh swapped the cards out from under the reader 1–8.6 s in
  // (measured 2026-08-22), and chased already-seen pages through up to three
  // extra source waves. On cold mount the snapshot stands on its own and the
  // infinite-scroll sentinel fetches the next page when the reader nears the
  // end — fresh content arrives below the current card instead of on top of it.
  useEffect(() => {
    const signature = feedPreferenceSignature(userPreferences);

    if (!signature || !recommendationProfileReady) {
      preferencesSignatureRef.current = null;
      return;
    }

    // Off the feed route nothing is recorded, so preference edits made from
    // settings or onboarding are picked up as a change on the next visit to
    // the feed — and no source cascade fires for a feed nobody is looking at.
    if (!feedRouteActive) return;

    if (preferencesSignatureRef.current === signature) return;

    const isColdMount = preferencesSignatureRef.current === null;
    preferencesSignatureRef.current = signature;
    feedCache.current = {};
    const snapshot = readFeedSnapshot(user?.uid, signature);
    const refreshTimer = setTimeout(() => {
      if (snapshot?.papers?.length) {
        feedCache.current[feedMode] = snapshot;
        setPapers(snapshot.papers);
        setPage(snapshot.page || 0);
        setHasMore(snapshot.hasMore !== false);
        if (isColdMount) return;
      } else {
        setPapers([]);
        setPage(0);
        setHasMore(true);
      }
      loadPapers(true, null, true);
    }, 0);
    return () => clearTimeout(refreshTimer);
  }, [feedMode, feedRouteActive, isKnownPaper, loadPapers, recommendationProfileReady, user?.uid, userPreferences]);

  const followingSignatureRef = useRef(null);

  useEffect(() => {
    // Warm the topic table as soon as a topic follow is known, off the feed's
    // critical path, so loadPapers meets a resident module.
    if (followedEntities.some(entity => entity?.type === 'topic')) void loadTopicRetrieval();
    if (followingLoading) return;
    const signature = followedEntities
      .map(entity => `${entity.type}:${entity.canonicalId}`)
      .sort()
      .join('|');
    if (followingSignatureRef.current === signature) return;
    if (followingSignatureRef.current === null) {
      followingSignatureRef.current = signature;
      return;
    }
    followingSignatureRef.current = signature;
    reRankFeed();
    if (recommendationProfileReady) {
      feedCache.current = {};
      // Keep the existing cards visible while a follow change refreshes ranking.
      const refreshTimer = setTimeout(() => loadPapers(true, null, true), 0);
      return () => clearTimeout(refreshTimer);
    }
  }, [followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady]);

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
        !savedPaperIdsRef.current.has(p.id) &&
        !isKnownPaper(p.id)
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
  }, [feedMode, hasMore, isKnownPaper, loadPapers, page, papers]);

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
    const userId = user?.uid;
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
      bumpConceptAffinities(conceptAffinities.current, paper, 1);
      
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
    } else if (userId) {
      recordProfileEvent({
        paperId: paper.id,
        kind: isCurrentlyLiked ? 'unlike' : 'like',
        category: paper.primaryCategory,
      });
      try {
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          liked: !isCurrentlyLiked,
          paperTitle: paper.title, paperAuthors: paper.authors?.slice(0, 3),
          paperCategory: paper.primaryCategory,
          paperAbstract: paper.summary?.substring(0, 500),
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
        }), { merge: true });
      } catch (err) {
        console.error('Error saving like:', err);
        setLikedPaperIds(likedPaperIds);
      }
    }
  }, [recordProfileEvent, user?.uid, likedPaperIds, reRankFeed, traverseAndExpandNetwork]);

  const markNotInterested = useCallback(async (paper) => {
    const userId = user?.uid;
    if (!userId) return;
    const newNotInterested = new Set(notInterestedIdsRef.current);
    newNotInterested.add(paper.id);
    setNotInterestedIds(newNotInterested);
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));

    if (paper.primaryCategory) {
       applyCategoryAffinityDelta(categoryAffinities.current, paper, -10);
       categoryCooldowns.current[paper.primaryCategory] = Date.now();
    }
    bumpConceptAffinities(conceptAffinities.current, paper, -2);
    reRankFeed(paper.id);

    if (IS_DEMO) {
      demoSet('notInterestedIds', Array.from(newNotInterested));
    } else {
      try {
        
        recordProfileEvent({
          paperId: paper.id,
          kind: 'notInterested',
          category: paper.primaryCategory,
        });
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          notInterested: true, paperCategory: paper.primaryCategory,
          paperAbstract: paper.summary?.substring(0, 500),
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
        }), { merge: true });
      } catch (err) {
        console.error('Error saving not interested:', err);
      }
    }
  }, [reRankFeed, recordProfileEvent, user?.uid]);

  const markAsRead = useCallback(async (paper) => {
    const userId = user?.uid;
    if (!userId) return;
    const newRead = new Set(readPaperIdsRef.current);
    newRead.add(paper.id);
    setReadPaperIds(newRead);
    const readAt = new Date().toISOString();
    const storedPaper = serializeLibraryPaper(paper);
    setPersonalLibrary((current) => {
      const next = {
        ...current,
        [paper.id]: { ...current[paper.id], paperId: paper.id, paper: storedPaper, readAt },
      };
      if (IS_DEMO) demoSet(`readingLibrary_${userId}`, next);
      return next;
    });
    
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
        
        recordProfileEvent({
          paperId: paper.id,
          kind: 'read',
          category: paper.primaryCategory,
          timestamp: readAt,
        });
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          read: true,
          paperTitle: paper.title, paperAuthors: paper.authors?.slice(0, 3),
          paperCategory: paper.primaryCategory,
          timestamp: readAt,
          readAt,
          paper: storedPaper,
          deviceType: getDeviceInfo().type,
        }), { merge: true });
      } catch (err) {
        console.error('Error saving read status:', err);
      }
    }
  }, [recordProfileEvent, user?.uid]);

  const trackViewTime = useCallback(async (paper, timeInSeconds) => {
    const userId = user?.uid;
    if (timeInSeconds < 1) return;
    
    // ─── BOREDOM RESET: user is engaging, not bored ───
    if (timeInSeconds >= 5) {
      boredomLevel.current = Math.max(0, boredomLevel.current - 3);
    }
    
    // Instantly update local weights for real-time re-ranking
    applyCategoryAffinityDelta(categoryAffinities.current, paper, Math.min(timeInSeconds, 60) * 0.25);
    bumpConceptAffinities(conceptAffinities.current, paper, Math.min(timeInSeconds, 60) * 0.05);
    // Update temporal preference and expand graph on high dwell time
    if (timeInSeconds >= 10) {
      const daysOld = (Date.now() - new Date(paper.published).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.05);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.05);
      
      // Expand network via OpenAlex
      traverseAndExpandNetwork(paper);
    }
    if (timeInSeconds >= 3.0) {
      // Off the snap path: the reader is settled on this card, not watching
      // the rest of the queue reorder underneath it.
      scheduleReRank(paper.id);
    }

    if (userId && !IS_DEMO) {
      try {
        recordProfileEvent({
          paperId: paper.id,
          kind: 'viewTime',
          category: paper.primaryCategory,
          viewTime: timeInSeconds,
        });
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          viewTime: increment(timeInSeconds),
          paperCategory: paper.primaryCategory,
          timestamp: new Date().toISOString(),
        }), { merge: true });
      } catch (err) {
        console.error('Error tracking view time:', err);
      }
    }
  }, [scheduleReRank, recordProfileEvent, traverseAndExpandNetwork, user?.uid]);

  const trackPdfOpened = useCallback(async (paper) => {
    const userId = user?.uid;
    // ─── BOREDOM RESET & GRAFO EXPANSION: opening PDF = highly engaged ───
    boredomLevel.current = 0;
    traverseAndExpandNetwork(paper);

    // Instantly update local weights for real-time re-ranking
    applyCategoryAffinityDelta(categoryAffinities.current, paper, 4);
    bumpConceptAffinities(conceptAffinities.current, paper, 1);
    reRankFeed(paper.id);

    if (userId && !IS_DEMO) {
      try {
        recordProfileEvent({
          paperId: paper.id,
          kind: 'openedPdf',
          category: paper.primaryCategory,
        });
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          openedPdf: true,
          paperCategory: paper.primaryCategory,
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
          context: 'feed',
        }), { merge: true });
      } catch (err) {
        console.error('Error tracking PDF open:', err);
      }
    }
  }, [reRankFeed, recordProfileEvent, traverseAndExpandNetwork, user?.uid]);

  const trackSkips = useCallback(async (papersToSkip) => {
    const userId = user?.uid;
    const skippedPapers = dedupeInteractionPapers(papersToSkip);
    if (skippedPapers.length === 0) return;

    // A fast gesture may cross several cards. Keep every recommendation signal,
    // but score and re-rank the remaining queue only once after the gesture.
    boredomLevel.current = Math.min(20, boredomLevel.current + skippedPapers.length);
    skippedPapers.forEach((paper) => {
      applyCategoryAffinityDelta(categoryAffinities.current, paper, -1);
    });
    // Off the snap path, same as trackViewTime: a fling across several cards
    // must not pay a synchronous re-rank per card it crosses.
    scheduleReRank(skippedPapers[skippedPapers.length - 1].id);

    if (userId && !IS_DEMO) {
      try {
        const batch = writeBatch(db);
        const timestamp = new Date().toISOString();
        const deviceType = getDeviceInfo().type;

        skippedPapers.forEach((paper) => {
          recordProfileEvent({
            paperId: paper.id,
            kind: 'skip',
            category: paper.primaryCategory,
            timestamp,
          });
          const ref = doc(db, 'users', userId, 'interactions', paper.id);
          batch.set(ref, definedFields({
            skip: increment(1),
            paperCategory: paper.primaryCategory,
            timestamp,
            deviceType,
            context: 'feed',
          }), { merge: true });
        });

        await batch.commit();
      } catch (err) {
        console.error('Error tracking skips:', err);
      }
    }
  }, [scheduleReRank, recordProfileEvent, user?.uid]);

  const trackSkip = useCallback((paper) => trackSkips([paper]), [trackSkips]);

  const trackPdfBounce = useCallback(async (paper) => {
    const userId = user?.uid;
    // Deduct category affinity for bounce (user opened PDF but closed it instantly)
    applyCategoryAffinityDelta(categoryAffinities.current, paper, -3);
    
    reRankFeed(paper.id);
    
    if (userId && !IS_DEMO) {
      try {
        recordProfileEvent({
          paperId: paper.id,
          kind: 'pdfBounce',
          category: paper.primaryCategory,
        });
        const ref = doc(db, 'users', userId, 'interactions', paper.id);
        await setDoc(ref, definedFields({
          pdfBounce: increment(1),
          paperCategory: paper.primaryCategory,
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
          context: 'feed',
        }), { merge: true });
      } catch (err) {
        console.error('Error tracking PDF bounce:', err);
      }
    }
  }, [reRankFeed, recordProfileEvent, user?.uid]);

  const markSaved = useCallback(async (paperOrId) => {
    const userId = user?.uid;
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
    // Saving is the strongest positive signal; react immediately like the rest.
    reRankFeed(paperId);

    if (IS_DEMO) {
      demoSet('savedPaperIds', Array.from(nextSaved));
      return;
    }

    if (userId) {
      try {
        recordProfileEvent({
          paperId,
          kind: 'save',
          category: paper?.primaryCategory,
        });
        const ref = doc(db, 'users', userId, 'interactions', paperId);
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
  }, [papers, reRankFeed, recordProfileEvent, traverseAndExpandNetwork, user?.uid]);

  const unmarkAsRead = useCallback(async (paperId) => {
    const userId = user?.uid;
    if (!userId) return;
    const newRead = new Set(readPaperIdsRef.current);
    newRead.delete(paperId);
    setReadPaperIds(newRead);
    setPersonalLibrary((current) => {
      if (!current[paperId]) return current;
      const next = { ...current, [paperId]: { ...current[paperId], readAt: null } };
      if (IS_DEMO) demoSet(`readingLibrary_${userId}`, next);
      return next;
    });

    if (IS_DEMO) {
      demoSet('readPaperIds', Array.from(newRead));
    } else {
      try {
        recordProfileEvent({ paperId, kind: 'unread' });
        const ref = doc(db, 'users', userId, 'interactions', paperId);
        await updateDoc(ref, {
          read: deleteField(),
          readAt: deleteField(),
        });
      } catch (err) {
        console.error('Error unmarking read status:', err);
      }
    }
  }, [recordProfileEvent, user?.uid]);

  const toggleReadLater = useCallback(async (paper) => {
    const userId = user?.uid;
    if (!userId || !paper?.id) return false;
    const nextValue = !personalLibrary[paper.id]?.readLater;
    const updatedAt = new Date().toISOString();
    const storedPaper = serializeLibraryPaper(paper);

    setPersonalLibrary((current) => {
      const next = {
        ...current,
        [paper.id]: {
          ...current[paper.id],
          paperId: paper.id,
          paper: storedPaper,
          readLater: nextValue,
          updatedAt,
        },
      };
      if (IS_DEMO) demoSet(`readingLibrary_${userId}`, next);
      return next;
    });

    if (!IS_DEMO) {
      try {
        recordProfileEvent({
          paperId: paper.id,
          kind: 'readLater',
          value: nextValue,
          category: paper.primaryCategory,
          timestamp: updatedAt,
        });
        await setDoc(doc(db, 'users', userId, 'interactions', paper.id), definedFields({
          readLater: nextValue,
          paper: storedPaper,
          paperTitle: paper.title,
          paperAuthors: paper.authors?.slice(0, 3) || [],
          paperCategory: paper.primaryCategory || '',
          libraryUpdatedAt: updatedAt,
        }), { merge: true });
      } catch (err) {
        console.error('Error updating read later:', err);
      }
    }
    return nextValue;
  }, [personalLibrary, recordProfileEvent, user?.uid]);

  const saveReadingMetadata = useCallback(async (paper, { note = '', tags = [] }) => {
    const userId = user?.uid;
    if (!userId || !paper?.id) return;
    const normalizedTags = [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
    const updatedAt = new Date().toISOString();
    const storedPaper = serializeLibraryPaper(paper);

    setPersonalLibrary((current) => {
      const next = {
        ...current,
        [paper.id]: {
          ...current[paper.id],
          paperId: paper.id,
          paper: storedPaper,
          note: note.trim(),
          tags: normalizedTags,
          updatedAt,
        },
      };
      if (IS_DEMO) demoSet(`readingLibrary_${userId}`, next);
      return next;
    });

    if (!IS_DEMO) {
      try {
        recordProfileEvent({
          paperId: paper.id,
          kind: 'metadata',
          category: paper.primaryCategory,
          timestamp: updatedAt,
        });
        await setDoc(doc(db, 'users', userId, 'interactions', paper.id), definedFields({
          note: note.trim(),
          tags: normalizedTags,
          paper: storedPaper,
          paperTitle: paper.title,
          paperAuthors: paper.authors?.slice(0, 3) || [],
          paperCategory: paper.primaryCategory || '',
          libraryUpdatedAt: updatedAt,
        }), { merge: true });
      } catch (err) {
        console.error('Error saving reading metadata:', err);
      }
    }
  }, [recordProfileEvent, user?.uid]);

  // The curated interaction ids, most recent first, exactly as the aggregate
  // holds them. `likedPaperIds` and friends are the same ids re-sorted for the
  // screens that predate the aggregate; the profile page wants recency. Pure
  // in-memory access — never a Firestore read.
  const getCuratedInteractionIds = useCallback(
    (name) => curatedIds(interactionProfile.current, name),
    [],
  );

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

  // Every function key below is already `useCallback`-wrapped (or, for
  // `setFeedMode`/`loadPapers`, deliberately re-created when the state its own
  // logic needs — papers/page/feedMode/hasMore — actually changes; see the
  // per-key audit in the Task 11 report). Wrapping only this object and not
  // those would be a `useMemo` that never hits: it recomputes whenever any
  // dependency below gets a new identity, and an unwrapped function has a new
  // identity on every render regardless of what it reads.
  //
  // Every one of those functions that touches the signed-in user depends on
  // `user?.uid`, never on bare `user` — deliberately, and it matters for all
  // twelve of them at once, not just individually. Firebase re-emits
  // `currentUser` with the same uid but a new object identity on every token
  // refresh; `user` itself is therefore not stable across that refresh, only
  // `user.uid` is. Because this whole object is a single `useMemo`, a single
  // function anywhere in this dependency list still keying off bare `user`
  // would invalidate the entire memo — and therefore re-render every
  // consumer of this context — on every token refresh, even though every
  // other function narrowed for nothing. Narrowing eleven of twelve buys
  // nothing; it has to be all of them or none. If a new action is added here
  // and it touches the signed-in user, read `user?.uid` into a local
  // `userId` as its first statement (see `toggleLike` for the pattern) and
  // depend on `user?.uid`, not `user` — unless it genuinely needs a field of
  // `user` beyond the id, which none of the current ones do.
  const value = useMemo(() => ({
    papers, loading, error, hasMore, isRefreshing,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds, personalLibrary,
    libraryPapers,
    ensurePersonalLibrary, getCuratedInteractionIds,
    feedMode, setFeedMode: handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
    toggleLike, markNotInterested, markSaved, markAsRead, unmarkAsRead,
    toggleReadLater, saveReadingMetadata,
    trackViewTime, trackPdfOpened, trackSkip, trackSkips, trackPdfBounce
  }), [
    papers, loading, error, hasMore, isRefreshing,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds, personalLibrary,
    libraryPapers,
    ensurePersonalLibrary, getCuratedInteractionIds,
    feedMode, handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
    toggleLike, markNotInterested, markSaved, markAsRead, unmarkAsRead,
    toggleReadLater, saveReadingMetadata,
    trackViewTime, trackPdfOpened, trackSkip, trackSkips, trackPdfBounce,
  ]);

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (!context) throw new Error('useFeed must be used within a FeedProvider');
  return context;
}
