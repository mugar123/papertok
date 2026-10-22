import type { PropsWithChildren } from 'react';
import type { Paper, PaperFollowMatch } from '../models/Paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { CuratedSetName, InteractionDocumentData, InteractionEvent, InteractionProfile, ProfileSignals } from '../utils/interactionProfile.ts';
import type { ProfileLoadResult } from '../utils/interactionProfileLoader.ts';
import type { RecentProperties, RecommendationContext } from '../utils/recommendationEngine.ts';
// `savedAt` is set only on a snapshot read back from storage.
interface FeedSnapshot { papers: Paper[]; page: number; hasMore: boolean; savedAt?: number }
interface PendingReRank { sourcePaperId: string | null; handle: number | null; isTimeout: boolean; requestedAt: number }
export interface LibraryEntry {
  paperId: string; paper: Partial<Paper>; readLater?: boolean; readAt?: string | number | null;
  note?: string; tags?: string[]; updatedAt?: string | number | null;
}
export interface RecommendationProfileSnapshot extends RecommendationContext {
  userId: string | null; ready: boolean; userPreferences: string[]; followedAuthors: string[];
  followedEntities: FollowEntity[]; notInterestedIds: string[]; readPaperIds: string[];
}
export interface FeedContextValue {
  papers: Paper[]; loading: boolean; error: string | null; hasMore: boolean; isRefreshing: boolean;
  /** Shown cards whose abstract a running request may still supply. */
  loadingAbstractIds: ReadonlySet<string>;
  likedPaperIds: Set<string>; notInterestedIds: Set<string>; savedPaperIds: Set<string>; readPaperIds: Set<string>;
  personalLibrary: Record<string, LibraryEntry>; libraryPapers: Record<string, Partial<Paper>>;
  ensurePersonalLibrary: () => Promise<void>;
  interactionIdFor: (paper: Partial<Paper>) => string | undefined;
  libraryCopyFor: (paper: Partial<Paper>) => { id: string; paper: Partial<Paper> } | null;
  feedMode: string; setFeedMode: (mode: string) => void;
  /** `seenFallback`: a page of papers shown before, carried by a load that skipped past it. */
  loadPapers: (reset?: boolean, mode?: string | null, randomizeStart?: boolean, pageOverride?: number, options?: { keepThroughVisible?: boolean; seenFallback?: { page: number; papers: Paper[] } }) => Promise<void>;
  loadMore: () => void; refreshFeed: () => Promise<void>;
  getRecommendationProfileSnapshot: () => RecommendationProfileSnapshot;
  reportVisiblePaper: (id: string | null) => void;
  toggleLike: (paper: Paper) => Promise<void>;
  markNotInterested: (paper: Paper) => Promise<void>;
  undoNotInterested: (paper: Paper, atIndex?: number | null) => Promise<void>;
  markSaved: (paper: Paper | string) => Promise<void>;
  unmarkSaved: (paper: Paper | string) => Promise<void>;
  markAsRead: (paper: Paper) => Promise<void>;
  unmarkAsRead: (id: string) => Promise<void>;
  toggleReadLater: (paper: Paper) => Promise<boolean>;
  saveReadingMetadata: (paper: Paper, metadata: { note?: string; tags?: string[] }) => Promise<void>;
  trackViewTime: (paper: Paper, seconds: number) => Promise<void>;
  trackPdfOpened: (paper: Paper) => Promise<void>;
  trackSkip: (paper: Paper) => Promise<void>;
  trackSkips: (papers: Paper[]) => Promise<void>;
  trackPdfBounce: (paper: Paper) => Promise<void>;
}

/* eslint-disable react-refresh/only-export-components */
import { useContext, useState, useCallback, useEffect, useMemo, useRef, useLayoutEffect, startTransition } from 'react';
import { FeedContext } from './contexts.ts';
import { IS_DEMO, db } from '../services/firebase.ts';
import { getDoc, setDoc, updateDoc, deleteField, increment, writeBatch } from 'firebase/firestore';
import { useAnalyticsConsent } from './AnalyticsContext.tsx';
import { useAuth } from './AuthContext.tsx';
import { auth } from '../services/firebase.ts';
import { useFollowing } from './FollowingContext.tsx';
import { fetchPapers, clearCache } from '../services/arxivService.ts';
import { getDeviceInfo } from '../utils/device.ts';
import { getAllLeafCategories } from '../data/categories.ts';
import { enrichPapersBatch } from '../services/openAlexService.ts';
import {
  applyRecommendationScore,
  diversifiedWeightedShuffle,
  logRankingBatch,
  paperAffinitySignals,
  pickExplorationCategories,
  readRecommendationWeights,
} from '../utils/recommendationEngine.ts';
import { mergeFreshFeedPage, splitFeedForReRank } from '../utils/feedReRankSplit.ts';
import { reRankHoldMs } from '../utils/feedReRankTiming.ts';
import {
  readProfileDriftCheckedAt,
  readSeenPaperIds,
  removeLegacySeenPaperIds,
  saveProfileDriftCheckedAt,
  saveSeenPaperIds,
} from '../utils/userScopedStorage.ts';
import { readStoredClassification, storedClassification } from '../models/Paper.ts';
import { serializeLibraryPaper } from '../utils/readingLibrary.ts';
import { savedPaperDocRef } from '../services/savedPaperStore.ts';
import { buildInteractionAliasIndex, resolveInteractionId } from '../utils/interactionAliases.ts';
import { isPlaceholderPaperTitle } from '../utils/paperDisplayTitle.ts';
import {
  createEmptyInteractionProfile,
  curatedIds,
  isPaperKnown,
  lacksLearnedAffinities,
  readProfileSignals,
  recordInteractionEvent,
  seedLearnedAffinities,
  viewedIds,
} from '../utils/interactionProfile.ts';
import {
  hasInteractionProfile,
  loadInteractionProfile,
  unavailableInteractionProfile,
} from '../utils/interactionProfileLoader.ts';
import {
  createInteractionProfileClient,
  fetchLibraryRecords,
  interactionDocRef,
  flushAllInteractionProfiles,
  flushInteractionProfileNow,
  scheduleInteractionProfileFlush,
} from '../services/interactionProfileStore.ts';
import { fetchCorpusPage, fetchCorpusPapers } from '../services/paperStoreService.ts';
import {
  abstractsInFlight,
  cardsGivenTopic,
  getOpenAlexEnrichmentId,
  mergeFeedAbstracts,
  mergeOpenAlexEnrichment,
  needsOpenAlexEnrichment,
  preserveFeedAbstracts,
  takeFeedPage,
} from '../utils/feedEnrichment.ts';
import { resolveWithin, settleWithin } from '../utils/asyncTiming.ts';
import { applyKnownPublicationTypes, classifyFeedPublications, dropUnreachedPublications } from '../services/feedPublicationService.ts';
import { isFeedPublication } from '../services/feedPublicationRules.ts';
import { dedupeInteractionPapers, definedFields, selectSemanticProfilePositiveIds } from '../utils/feedInteractions.ts';
import { rankPreferences } from '../utils/preferenceRanking.ts';
import { fetchICiteMetrics } from '../services/iCiteService.ts';
import { mergeICiteEnrichment } from '../services/iCiteRecords.ts';
import { enrichPubmedIds } from '../services/europePmcService.ts';
import { mergeEuropePmcEnrichment } from '../services/europePmcRecords.ts';
import { recoverFeedAbstracts } from '../services/feedAbstractService.ts';
import { abstractWaitIds, openAbstractWait, type AbstractWaits } from '../utils/feedAbstractWait.ts';
// topicRetrievalService carries a ~32 KB gzip topic table and only matters
// once a feed load actually ranks followed topics, so it loads on first use
// instead of riding in the boot graph of every route.
const loadTopicRetrieval = () => import('../services/topicRetrievalService.ts');

const PAGE_SIZE = 15;
// How many of the reader's ranked categories a page asks the corpus for.
const MAIN_CATEGORIES = 10;
// A reload starts on a random one of the first pages, for variety.
const RESET_START_PAGES = 5;
// How long exploration and the follows may hold a page: past it, the page is
// shown without them.
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

function feedPreferenceSignature(preferences: string[] | null) {
  return [...(preferences || [])].sort().join('|');
}

function feedSnapshotKey(userId: string | null | undefined, signature: string) {
  return `papertok_feed_snapshot_${encodeURIComponent(userId || 'guest')}_${encodeURIComponent(signature)}`;
}

function readFeedSnapshot(userId: string | null | undefined, signature: string): (FeedSnapshot & { savedAt: number }) | null {
  if (!userId || !signature) return null;
  try {
    const snapshot = JSON.parse(localStorage.getItem(feedSnapshotKey(userId, signature)) || 'null');
    if (!snapshot || snapshot.publicationPolicy !== 3 || Date.now() - snapshot.savedAt > FEED_SNAPSHOT_TTL_MS || !Array.isArray(snapshot.papers)) {
      return null;
    }
    // A card can be saved before Crossref answered, or kept because the reader
    // was on it. Nothing is on screen before a restore, so a book known now leaves.
    return { ...snapshot, papers: applyKnownPublicationTypes(snapshot.papers).filter(isFeedPublication) };
  } catch {
    return null;
  }
}

function writeFeedSnapshot(userId: string | null | undefined, signature: string, snapshot: FeedSnapshot) {
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
      publicationPolicy: 3,
      // A restored page updated by late answers keeps its expiry: the
      // fifteen minutes count from when its page was loaded.
      savedAt: snapshot.savedAt ?? Date.now(),
    }));
  } catch {
    // A full browser storage quota must never block the feed.
  }
}

// ── Demo mode storage helpers ──
function demoGet<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`papertok_${key}`);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function demoSet(key: string, value: unknown) {
  localStorage.setItem(`papertok_${key}`, JSON.stringify(value));
}

// How many papers the followed entities add to a page.
const FOLLOWED_PER_PAGE = 6;

/**
 * Papers of the reader's follows from the paper corpus: the Worker serves an
 * author, institution, OpenAlex topic, project or followed query from the
 * lane it harvests for it, and says which follows each paper matched. A
 * topic follow that is one of the app's categories is asked for as those
 * categories, and matched by the categories a paper was found under.
 */
async function fetchFollowedEntityCandidates(followedEntities: FollowEntity[], { page, order, positiveIds, categoryIdsOf }: {
  page: number; order: string; positiveIds: string[]; categoryIdsOf: (follow: FollowEntity) => string[];
}) {
  const categoryFollows = followedEntities
    .map(follow => ({ follow, categoryIds: follow.type === 'topic' ? categoryIdsOf(follow) : [] }))
    .filter(entry => entry.categoryIds.length > 0);
  const papers = await fetchCorpusPage({
    categories: [...new Set(categoryFollows.flatMap(entry => entry.categoryIds))],
    follows: followedEntities,
    positiveIds,
    page,
    pageSize: FOLLOWED_PER_PAGE,
    order,
  });
  return papers.map(paper => ({
    ...paper,
    _type: 'followed' as const,
    _followedEntityMatches: mergeFollowEntityMatches(
      paper._followedEntityMatches,
      categoryFollows.filter(entry => entry.categoryIds.some(id => paper._fetchedFor?.includes(id))).map(entry => entry.follow),
    ),
  }));
}

function mergeFollowEntityMatches(...groups: Array<Paper['_followedEntityMatches']>) {
  const matches = groups.flat().filter(match => match && typeof match === 'object') as PaperFollowMatch[];
  return matches.filter((match, index) => matches.findIndex(candidate => (
    candidate.type === match.type && candidate.canonicalId === match.canonicalId
  )) === index);
}

// The For You feed's engagement goes out every this many cards: how many were
// skipped, read past the reader's median, liked and saved. Counts only, so
// the event names no paper, topic or account.
const ENGAGEMENT_WINDOW_CARDS = 20;
interface EngagementWindow { cards: number; skips: number; deepReads: number; likes: number; saves: number }
const emptyEngagementWindow = (): EngagementWindow => ({ cards: 0, skips: 0, deepReads: 0, likes: 0, saves: 0 });

// `feedRouteActive` says whether the route that actually renders this feed is
// on screen. The provider wraps every route so its consumers (save modal, PDF
// viewer) exist everywhere, but the multi-source fetch fan-out must not:
// measured in production, a signed-in visit to a public page fired the full
// source cascade for a feed nobody was looking at.
export function FeedProvider({ children, feedRouteActive = true }: PropsWithChildren<{ feedRouteActive?: boolean }>) {
  const { user, userPreferences, followedAuthors } = useAuth();
  const { followedEntities, loading: followingLoading } = useFollowing();
  const [papers, setPapers] = useState<Paper[]>([]);
  const [abstractWaits, setAbstractWaits] = useState<AbstractWaits>([]);
  const loadingAbstractIds = useMemo(() => abstractWaitIds(abstractWaits), [abstractWaits]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [page, setPage] = useState(0);
  const [feedMode, setFeedMode] = useState('top'); // Default to TikTok algorithm
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Per-mode cache: { recent: { papers, page, hasMore }, top: { ... } }
  const feedCache = useRef<Record<string, FeedSnapshot>>({});

  const [likedPaperIds, setLikedPaperIds] = useState(new Set<string>());
  const [notInterestedIds, setNotInterestedIds] = useState(new Set<string>());
  const [savedPaperIds, setSavedPaperIds] = useState(new Set<string>());
  const [readPaperIds, setReadPaperIds] = useState(new Set<string>());
  const [personalLibrary, setPersonalLibrary] = useState<Record<string, LibraryEntry>>({});
  // Paper metadata for everything the library read fetched, by id — including
  // the records `personalLibrary` filters out. See ensurePersonalLibrary.
  const [libraryPapers, setLibraryPapers] = useState<Record<string, Partial<Paper>>>({});
  const [recommendationProfileUserId, setRecommendationProfileUserId] = useState<string | null>(null);
  const recommendationProfileReady = Boolean(user?.uid && recommendationProfileUserId === user.uid);

  // Mirror refs to prevent stale closures in asynchronous recommendation processes
  const likedPaperIdsRef = useRef(likedPaperIds);
  const savedPaperIdsRef = useRef(savedPaperIds);
  const readPaperIdsRef = useRef(readPaperIds);
  const loadPapersRef = useRef<FeedContextValue['loadPapers'] | null>(null);
  const autoRetryUsedRef = useRef(false);
  const notInterestedIdsRef = useRef(notInterestedIds);
  const isTraversingNetwork = useRef(false);
  const feedRequestId = useRef(0);
  // Whether a feed load is running. Set and cleared with `setLoading`, and
  // visible at once: `loading` reaches a callback only after React commits it.
  const feedLoadInFlight = useRef(false);
  // A non-reset load asked of a closure rendered before the last load ended,
  // with the request and session it was asked in. The next committed
  // loadPapers runs it, unless a load starts or the account changes first.
  const loadAfterCommit = useRef<{ args: Parameters<FeedContextValue['loadPapers']>; requestId: number; sessionId: number } | null>(null);
  const feedSessionId = useRef(0);
  const activeUserId = useRef(user?.uid || null);
  // Initial ref values that read storage or allocate go through a lazy
  // useState: the provider re-renders on every feed change, and useRef(value)
  // would evaluate them each time only to discard them.
  const [initialSeenPapers] = useState(() => readSeenPaperIds(user?.uid));
  const sessionSeenPapers = useRef(initialSeenPapers);
  // The derived aggregate that replaced the full interactions scan. Kept in a
  // ref because every interaction mutates it synchronously while the durable
  // write is coalesced behind it.
  const [initialInteractionProfile] = useState(createEmptyInteractionProfile);
  const interactionProfile = useRef(initialInteractionProfile);
  // False until a profile has actually been read back for this account. Writing
  // a half-built aggregate over a good one would silently reset the user's
  // recommendations, which is worse than skipping a session's deltas: the
  // interaction documents are still the source of truth either way.
  const interactionProfileHydrated = useRef(false);
  // The account whose profile is currently reflected in the state above.
  const loadedProfileUserId = useRef<string | null>(null);
  // Bumped every time a profile is applied. Consumers of the reading library
  // depend on it so they retry once the ids they need actually exist.
  const [interactionProfileGeneration, setInteractionProfileGeneration] = useState(0);
  const personalLibraryStatus = useRef<{ userId: string | null; generation: number; state: 'idle' | 'loading' | 'ready' }>({ userId: null, generation: -1, state: 'idle' });

  useEffect(() => { likedPaperIdsRef.current = likedPaperIds; }, [likedPaperIds]);
  useEffect(() => { savedPaperIdsRef.current = savedPaperIds; }, [savedPaperIds]);
  useEffect(() => { readPaperIdsRef.current = readPaperIds; }, [readPaperIds]);
  useEffect(() => { notInterestedIdsRef.current = notInterestedIds; }, [notInterestedIds]);
  // Read by handlers that must keep one identity across re-ranks: a handler
  // that lists `papers` in its deps is handed anew to every mounted card on
  // every `setPapers`, and that alone re-rendered 28 of 30 cards per swipe
  // (measured 2026-09-11, ~200 ms of React work at each card change).
  const papersRef = useRef(papers);
  useEffect(() => { papersRef.current = papers; }, [papers]);
  // What the ranking reads from the interaction profile, read out again after
  // every event. The profile is the one owner; nothing writes these maps.
  const profileSignals = useRef<ProfileSignals>(readProfileSignals(null));
  const temporalPreference = useRef(0); // -1 (classic) to +1 (recent)
  const [initialRecommendationWeights] = useState(() => readRecommendationWeights());
  const recommendationWeights = useRef(initialRecommendationWeights);
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
    (paperId: string) => isPaperKnown(interactionProfile.current, paperId),
    [],
  );

  // A card counts as seen once it was on screen: the dwell and the skip the
  // card reports call this. A card a load only brought in stays in
  // sessionSeenPapers, which dies with the page, so the next load may show it.
  // The list kept across loads is read back before it is written, so a second
  // tab's views are not overwritten. A card that reports after the account
  // changed was viewed by the account that owned it, not by the new one.
  // Signing out sweeps the account's storage before React unmounts the card,
  // whose cleanup then reports while activeUserId is still that account's;
  // Firebase already names nobody, so that report does not write the list back.
  const markPaperViewed = useCallback((paperId: string, viewerId: string | null | undefined) => {
    const userId = activeUserId.current;
    if ((viewerId || null) !== userId) return;
    sessionSeenPapers.current.add(paperId);
    if (auth.currentUser?.uid !== userId) return;
    const viewed = readSeenPaperIds(userId);
    viewed.delete(paperId);
    viewed.add(paperId);
    saveSeenPaperIds(userId, viewed);
  }, []);

  // What this account viewed on any device, as its aggregate has it, is passed
  // over on load like what this browser viewed.
  const carryViewedPapers = useCallback((profile: InteractionProfile) => {
    viewedIds(profile).forEach(paperId => sessionSeenPapers.current.add(paperId));
  }, []);

  const { trackEvent } = useAnalyticsConsent();
  const engagementWindow = useRef(emptyEngagementWindow());
  // Only cards of this feed count: the Following feed reports its views
  // through the same handlers.
  const countEngagement = useCallback((paperId: string, change: Partial<EngagementWindow>) => {
    if (!papersRef.current.some(paper => paper.id === paperId)) return;
    const counts = engagementWindow.current;
    (Object.keys(change) as Array<keyof EngagementWindow>).forEach((key) => {
      counts[key] += change[key] || 0;
    });
    if (counts.cards < ENGAGEMENT_WINDOW_CARDS) return;
    engagementWindow.current = emptyEngagementWindow();
    void trackEvent('feed_engagement', {
      cards: counts.cards,
      skips: counts.skips,
      deep_reads: counts.deepReads,
      likes: counts.likes,
      saves: counts.saves,
    });
  }, [trackEvent]);

  // The paper, when there is one, lends the event its OpenAlex concepts and
  // authors. Called before the re-rank it feeds, so that re-rank sees it.
  const recordProfileEvent = useCallback((event: InteractionEvent, paper?: Partial<Paper> | null) => {
    const userId = user?.uid;
    if (!userId || IS_DEMO) return;
    recordInteractionEvent(interactionProfile.current, paper ? { ...event, ...paperAffinitySignals(paper) } : event);
    profileSignals.current = readProfileSignals(interactionProfile.current);
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
  const pendingSnapshotWritesRef = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; flush: () => void }>());
  const scheduleFeedSnapshotWrite = useCallback((userId: string | null, signature: string, snapshot: FeedSnapshot) => {
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
  // The id a reader's marks for a paper live under. A mark is keyed by the
  // id the feed gave the paper the day it was made — `openalex:W…`, `arxiv:…`,
  // a Semantic Scholar hash — and the same paper comes back under another of
  // those from a shared link hydrated by DOI, or from the feed served by
  // another source. The stored copies the library loads carry the DOI and
  // arXiv id beside the id the mark lives under, so they are the alias table
  // (utils/interactionAliases.js). Every mark written from here goes under
  // the resolved id, so a paper never ends up half-liked under two ids.
  const interactionAliasIndex = useMemo(() => buildInteractionAliasIndex([
    ...Object.entries(libraryPapers),
    ...Object.entries(personalLibrary).map(([id, entry]): [string, Partial<Paper>] => [id, entry?.paper]),
  ]), [libraryPapers, personalLibrary]);
  const interactionIdFor = useCallback((paper: Partial<Paper>) => resolveInteractionId(
    paper,
    interactionAliasIndex,
    (id) => likedPaperIds.has(id) || savedPaperIds.has(id) || readPaperIds.has(id)
      || Boolean(personalLibrary[id]) || Boolean(libraryPapers[id]),
  ), [interactionAliasIndex, likedPaperIds, savedPaperIds, readPaperIds, personalLibrary, libraryPapers]);
  const withInteractionId = useCallback(<T extends Partial<Paper>,>(paper: T): T => {
    if (!paper || typeof paper !== 'object') return paper;
    const id = interactionIdFor(paper);
    return id === paper.id ? paper : { ...paper, id };
  }, [interactionIdFor]);
  // The copy the library holds for this paper, under whichever id, with that id.
  const libraryCopyFor = useCallback((paper: Partial<Paper>) => {
    const id = interactionIdFor(paper);
    if (!id) return null;
    const copy = libraryPapers[id] || personalLibrary[id]?.paper;
    return copy ? { id, paper: copy } : null;
  }, [interactionIdFor, libraryPapers, personalLibrary]);

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

      const library: Record<string, LibraryEntry> = {};
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
      const papers: Record<string, Partial<Paper>> = {};
      records.forEach(({ id, data }) => {
        // A copy's field is decided here, on the document as it was stored,
        // because every screen below reads these copies as they are. A record
        // without a copy kept only the category its card showed, which was
        // often the one the feed asked for, so it has no field (PAP-60).
        const paper = data.paper
          ? { ...data.paper, ...readStoredClassification({ ...data.paper, id }) }
          : serializeLibraryPaper({
            id,
            title: data.paperTitle || '',
            authors: data.paperAuthors || [],
            published: (data.timestamp || '') as string,
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
  const calculateAndAttachScore = useCallback((paper: Paper, recentPropsCount: Partial<RecentProperties> = {}) => {
    const signals = profileSignals.current;
    return applyRecommendationScore(paper, {
      userPreferences,
      followedEntities,
      categoryAffinities: signals.categoryAffinities,
      conceptAffinities: signals.conceptAffinities,
      authorAffinities: signals.authorAffinities,
      sessionAffinities: signals.sessionAffinities,
      interactionCount: signals.interactionCount,
      temporalPreference: temporalPreference.current,
      weights: recommendationWeights.current,
      recentPropsCount
    });
  }, [userPreferences, followedEntities]);

  // The card the reader is on, as FeedContainer reports it (on the restore
  // after a reload and on every scroll), the successor markNotInterested
  // moves it to, or none after a refresh. A ref, not state: it moves on every
  // scroll event and nothing needs to re-render for it — reRankFeed reads it
  // inside its functional setPapers.
  //
  // A preferences-change reset replaces the list without resetting this ref or
  // scrolling to top, so it can name a paper no longer in papers — then
  // reRankFeed and the merge lock only the top few cards, and a late Crossref
  // answer removes no card. Not enforced.
  const visiblePaperIdRef = useRef<string | null>(null);
  // When the feed last moved. FeedContainer reports the visible paper from
  // its scroll handler, so this doubles as the scroll heartbeat the deferred
  // re-rank below waits out: a re-rank landing inside the snap animation is
  // what it exists to avoid.
  const feedScrolledAtRef = useRef(0);
  const reportVisiblePaper = useCallback((paperId: string | null) => {
    visiblePaperIdRef.current = paperId || null;
    feedScrolledAtRef.current = Date.now();
  }, []);

  /**
   * PAP-60, D6. Past the first page, OpenAlex answers after a card is shown,
   * and a card from a source with no classification of its own takes its
   * field from that answer's topic. A like, save, read or Read later before
   * it stored the card without the topic, so the card showed a field and the
   * copy, once reloaded, none. The topic is added to each stored copy that
   * has none, and to the copies the library holds in memory. Nothing else in
   * a copy changes: its categories and classificationVersion are the evidence
   * it was stored with, and the interaction's timestamp dates the reader's
   * action, not this write.
   */
  const keepLateTopics = useCallback((cards: Paper[]) => {
    const userId = user?.uid;
    if (!userId || IS_DEMO) return;
    cards.forEach((card) => {
      const { primaryTopic } = storedClassification(card);
      const paperId = withInteractionId(card).id;
      const saved = savedPaperIdsRef.current.has(paperId);
      if (!primaryTopic || (!saved && !likedPaperIdsRef.current.has(paperId)
        && !readPaperIdsRef.current.has(paperId) && !personalLibrary[paperId])) return;
      setPersonalLibrary((current) => {
        const entry = current[paperId];
        return entry?.paper && !entry.paper.primaryTopic
          ? { ...current, [paperId]: { ...entry, paper: { ...entry.paper, primaryTopic } } }
          : current;
      });
      setLibraryPapers((current) => {
        const copy = current[paperId];
        return copy && !copy.primaryTopic ? { ...current, [paperId]: { ...copy, primaryTopic } } : current;
      });
      void (async () => {
        // A record kept without a copy has no field to complete.
        const interaction = await getDoc(interactionDocRef(userId, paperId));
        const copy = interaction.data()?.paper;
        if (copy && !copy.primaryTopic) await updateDoc(interaction.ref, { 'paper.primaryTopic': primaryTopic });
        if (!saved) return;
        // The save sheet names this document by the card's own id; a paper
        // saved under another of its ids has none here.
        const savedPaper = await getDoc(savedPaperDocRef(userId, card.id));
        if (savedPaper.exists() && !savedPaper.data().primaryTopic) await updateDoc(savedPaper.ref, { primaryTopic });
      })().catch(error => console.error('Error storing a late OpenAlex topic:', error));
    });
  }, [withInteractionId, personalLibrary, user?.uid]);
  // followShownPapers keeps one identity across renders; it reaches the
  // current marks through this.
  const keepLateTopicsRef = useRef(keepLateTopics);
  useEffect(() => { keepLateTopicsRef.current = keepLateTopics; }, [keepLateTopics]);

  // Requests that answer after cards are shown, from a fresh page or a
  // restored snapshot, change those cards in place, and the feed cache and
  // snapshot with them, while the account stays the same. Only the cards in
  // `waiting` say their abstract is loading, so only they can receive one,
  // until their requests settle. A confirmed book leaves only if the reader
  // has not reached it. A null request has nothing left to answer.
  const followShownPapers = useCallback(({ mode, sessionId, signature, waiting, openAlex, iCite, europePmc, recovery, publications }: {
    mode: string; sessionId: number; signature: string; waiting: ReadonlySet<string>;
    openAlex: ReturnType<typeof enrichPapersBatch> | null;
    iCite: ReturnType<typeof fetchICiteMetrics> | null;
    europePmc: ReturnType<typeof enrichPubmedIds> | null;
    recovery: ReturnType<typeof recoverFeedAbstracts> | null;
    publications: ReturnType<typeof classifyFeedPublications>;
  }) => {
    const update = (change: (current: Paper[]) => Paper[]) => {
      if (feedSessionId.current !== sessionId) return;
      setPapers(current => {
        const next = change(current);
        // The merges return a new list even when every card object is
        // unchanged. Such an answer must not re-render or rewrite the snapshot.
        if (next.length === current.length && next.every((paper, index) => paper === current[index])) return current;
        const cachedMode = feedCache.current[mode];
        if (cachedMode) {
          feedCache.current[mode] = { ...cachedMode, papers: next };
          scheduleFeedSnapshotWrite(activeUserId.current, signature, feedCache.current[mode]);
        }
        return next;
      });
    };
    const fillable = openAbstractWait(setAbstractWaits, waiting, [openAlex, europePmc, recovery].filter(request => request !== null));
    openAlex?.then((records) => {
      if (!records || Object.keys(records).length === 0) return;
      const loading = fillable();
      const enrich = (current: Paper[]) => preserveFeedAbstracts(current, mergeOpenAlexEnrichment(current, records), loading);
      update(enrich);
      // Out here, not in the update: React may run a state updater twice.
      if (feedSessionId.current !== sessionId) return;
      const shown = papersRef.current;
      keepLateTopicsRef.current(cardsGivenTopic(shown, enrich(shown)));
    });
    iCite?.then((metrics) => {
      if (!metrics || Object.keys(metrics).length === 0) return;
      update(current => mergeICiteEnrichment(current, metrics));
    });
    europePmc?.then((records) => {
      if (!records || records.size === 0) return;
      const loading = fillable();
      update(current => preserveFeedAbstracts(current, mergeEuropePmcEnrichment(current, records), loading));
    });
    recovery?.then((records) => {
      if (records.length === 0) return;
      const loading = fillable();
      update(current => preserveFeedAbstracts(current, mergeFeedAbstracts(current, records), loading));
    });
    publications.then((classified) => {
      update(current => dropUnreachedPublications(current, classified, visiblePaperIdRef.current));
    });
  }, [scheduleFeedSnapshotWrite]);

  const reRankFeed = useCallback((sourcePaperId: string | null = null) => {
    // A transition: reordering the unseen queue re-renders every card whose
    // position moved, and as a synchronous update that was a 200-250 ms
    // block landing right as the reader arrived on a card. Time-sliced, it
    // yields to the scroll and the wheel between cards.
    startTransition(() => setPapers(prevPapers => {
      if (!prevPapers || prevPapers.length <= 1) return prevPapers;
      // Lock the cards the reader is on or about to reach: the interacted
      // paper when there is one, and the visible one always — a reload puts
      // the reader deep in the list, and the profile load's anchorless
      // re-rank used to shuffle that card away (2026-09-04).
      const { locked, queue } = splitFeedForReRank(prevPapers, {
        anchorPaperIds: [sourcePaperId, visiblePaperIdRef.current],
      });
      if (queue.length === 0) return prevPapers;

      const newQueue = diversifiedWeightedShuffle(queue, {
        scorePaper: calculateAndAttachScore,
        weights: recommendationWeights.current,
        initialPapers: locked,
      });
      logRankingBatch('rerank queue', newQueue);

      return [...locked, ...newQueue];
    }));
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
  //
  // Idle is not enough on its own. The main thread IS idle while the
  // compositor runs the snap to the next card, so an idle callback armed by
  // the card that just left (its view time lands as it crosses the half-way
  // mark) fired ~400 ms later — inside that animation, or on the frame it
  // settled. Measured 2026-09-22 on the production bundle: one reorder per
  // swipe, ~20 snap items re-attached and re-laid out, plus the render of
  // every card whose position moved. The reorder is held while the feed is
  // still moving and released once the scroll report has been quiet for a
  // beat, bounded so a reader who never pauses still gets it
  // (utils/feedReRankTiming.js has the two clocks and why).
  const pendingReRankRef = useRef<PendingReRank | null>(null);
  const scheduleReRank = useCallback((sourcePaperId: string | null) => {
    if (pendingReRankRef.current) {
      pendingReRankRef.current.sourcePaperId = sourcePaperId;
      return;
    }
    const pending: PendingReRank = { sourcePaperId, handle: null, isTimeout: false, requestedAt: Date.now() };
    const run = () => {
      const hold = reRankHoldMs({ now: Date.now(), scrolledAt: feedScrolledAtRef.current, requestedAt: pending.requestedAt });
      if (hold > 0) {
        pending.isTimeout = true;
        pending.handle = setTimeout(run, hold);
        return;
      }
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
    if (pending.isTimeout) clearTimeout(pending.handle as number);
    else window.cancelIdleCallback?.(pending.handle as number);
  }, []);

  const traverseAndExpandNetwork = useCallback(async (paper: Paper) => {
    const sessionId = feedSessionId.current;
    if (!activeUserId.current) return;
    if (isTraversingNetwork.current) {
      console.log("[Recommender] Expansion in progress; request ignored to avoid saturating the API.");
      return;
    }
    
    isTraversingNetwork.current = true;
    try {
      // The corpus papers closest to this one, within the reader's interests
      // and the paper's own category: the corpus ranks by likeness to it alone.
      const categories = [...new Set([paper.primaryCategory, ...(userPreferences || [])].filter(Boolean) as string[])].slice(0, MAIN_CATEGORIES);
      const related = categories.length > 0
        ? await fetchCorpusPage({ categories, positiveIds: [paper.id], page: 0, pageSize: 15 }).catch(() => [])
        : [];
      if (sessionId !== feedSessionId.current) return;

      const newGraphPapers = related.filter(candidate =>
        !likedPaperIdsRef.current.has(candidate.id) &&
          !savedPaperIdsRef.current.has(candidate.id) &&
          !readPaperIdsRef.current.has(candidate.id) &&
          !notInterestedIdsRef.current.has(candidate.id) &&
          !sessionSeenPapers.current.has(candidate.id) &&
          !isKnownPaper(candidate.id)
      ).slice(0, 5);

        if (newGraphPapers.length > 0) {
          newGraphPapers.forEach(p => {
            p._type = 'graph';
            p._isGraphCandidate = true;
            calculateAndAttachScore(p);
            sessionSeenPapers.current.add(p.id); // Mark as seen to avoid duplicate fetches
          });

          // Insert them in the papers queue ahead of the user
          setPapers(current => {
            if (current.findIndex(p => p.id === paper.id) === -1) return current; // paper not found in current feed

            // The corpus fetch above is a network round trip: the reader may
            // have swiped on while it was in flight, so the paper the
            // interaction named is no longer where they are. Anchor on the
            // deeper of the two (final review, 2026-09-04).
            const { locked, queue: rest } = splitFeedForReRank(current, {
              anchorPaperIds: [paper.id, visiblePaperIdRef.current],
            });

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
          
          console.log(`[Recommender] Inserted ${newGraphPapers.length} related papers into the feed.`);
        }
    } catch (err) {
      console.error('[Recommender] Failed to expand the paper network:', err);
    } finally {
      if (sessionId === feedSessionId.current) isTraversingNetwork.current = false;
    }
  }, [calculateAndAttachScore, isKnownPaper, userPreferences]);

  // Load user interactions
  useEffect(() => {
    let cancelled = false;
    let semanticIdleHandle: number | null = null;
    const userId = user?.uid || null;
    const sessionId = ++feedSessionId.current;

    // Before the list is read: on an account's first load it starts from the
    // list this browser kept before.
    removeLegacySeenPaperIds(null, userId);
    activeUserId.current = userId;
    sessionSeenPapers.current = readSeenPaperIds(userId);

    // Switching accounts, or signing out, must clear the previous account's
    // papers immediately. This is the only place allowed to blank the sets: a
    // profile that merely failed to load leaves them alone.
    if (loadedProfileUserId.current && loadedProfileUserId.current !== userId) {
      setLikedPaperIds(new Set<string>());
      setNotInterestedIds(new Set<string>());
      setSavedPaperIds(new Set<string>());
      setReadPaperIds(new Set<string>());
      setPersonalLibrary({});
      interactionProfile.current = createEmptyInteractionProfile();
      profileSignals.current = readProfileSignals(null);
      engagementWindow.current = emptyEngagementWindow();
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
    /**
     * Everything a profile changes once it is in hand, in one place, so the
     * answer that arrives late does exactly what the answer in time does.
     */
    const applyInteractionProfile = (result: Exclude<ProfileLoadResult, { status: 'unavailable' }>) => {
      try {
        const { profile } = result;
        if (result.repairedDrift) {
          console.info(
            `[Recommender] Aggregate repaired: it was missing ${result.drift!.missing} documents `
            + `(${result.drift!.accounted} contabilizados frente a ${result.drift!.actual} reales).`,
          );
        }
        if (result.rebuilt) {
          console.info(
            `[Recommender] Profile rebuilt from ${result.documentsRead} interactions`
            + `${result.truncated ? ' (truncado en el tope duro)' : ''}.`,
          );
        }
        interactionProfile.current = profile;
        carryViewedPapers(profile);
        // A profile that genuinely came back — including a legitimately empty one
        // for a new account — is safe to write back.
        interactionProfileHydrated.current = true;
        loadedProfileUserId.current = userId;

        // getDocs returned these ids ordered by document id, and the lists that
        // render them still expect exactly that order.
        const orderedSet = (name: CuratedSetName) => new Set(curatedIds(profile, name).sort());
        const liked = orderedSet('liked');
        const notInterested = orderedSet('notInterested');
        const saved = orderedSet('saved');
        const read = orderedSet('read');

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
        profileSignals.current = readProfileSignals(profile);
        setRecommendationProfileUserId(userId);

        // The liked and saved papers, as the paper corpus enriched them, seed
        // the concept and author affinities when the profile has none. An
        // overlay, not a gate: the sample is capped and runs after the first
        // page has the network, so a large liked library cannot stall the first
        // cards. The sample comes from the aggregate's own order (newest first):
        // `liked`/`saved` above are Sets sorted by id for the lists, and cutting
        // those to 24 kept the alphabetically-first likes forever (audit
        // 2026-09-02, A3).
        // Decided now, before the reader's first event adds entries of its own.
        const needsLearnedSeed = lacksLearnedAffinities(profile);
        const positiveIds = needsLearnedSeed
          ? selectSemanticProfilePositiveIds(curatedIds(profile, 'liked'), curatedIds(profile, 'saved'))
          : [];
        const scheduleIdle = typeof requestIdleCallback === 'function'
          ? (fn: () => void) => requestIdleCallback(fn, { timeout: 2500 })
          : (fn: () => void) => setTimeout(fn, 0);
        const semanticIdleHandleId = scheduleIdle(() => {
          void (async () => {
            // A profile that arrived late replaces this one, and owns the work.
            const superseded = () => cancelled || interactionProfile.current !== profile;
            if (superseded() || positiveIds.length === 0) return;
            const stored = await fetchCorpusPapers(positiveIds).catch((error) => {
              console.warn('Liked papers unavailable for the affinity seed', error);
              return [];
            });
            if (superseded()) return;
            const seedExamples = stored.map(paper => paperAffinitySignals({ openAlex: { concepts: paper.concepts }, authors: paper.authors }));
            if (seedExamples.length > 0) {
              seedLearnedAffinities(profile, seedExamples);
              profileSignals.current = readProfileSignals(profile);
              scheduleInteractionProfileFlush(userId, profile);
              reRankFeedRef.current();
            }
          })();
        });
        semanticIdleHandle = semanticIdleHandleId;
      } catch (err) {
        if (!cancelled) console.error('Error applying the interaction profile:', err);
      }
    };
    const loadInteractions = async () => {
      interactionProfileHydrated.current = false;
      try {
        const client = createInteractionProfileClient(userId);
        const checkedAt = readProfileDriftCheckedAt(userId);
        const checkDrift = Date.now() - checkedAt > PROFILE_DRIFT_CHECK_INTERVAL_MS;
        // Recorded whatever the outcome: a check that fails must not retry on
        // every single load.
        if (checkDrift) saveProfileDriftCheckedAt(userId, Date.now());

        const profileLoad = loadInteractionProfile({
          readAggregate: client.readAggregate,
          listInteractionPage: client.listInteractionPage,
          writeAggregate: client.writeAggregate,
          countInteractions: client.countInteractions,
          checkDrift,
          userId,
        });
        const settled = await settleWithin(profileLoad, INTERACTIONS_NETWORK_TIMEOUT_MS);
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
            `[Recommender] Profile unavailable (${result.reason}); keeping the current state.`,
          );
          // The budget decides when the feed may start, not whether the
          // profile counts. The read behind it keeps going (patientRead in
          // interactionProfileStore.js: it kicks a dead stream and re-asks),
          // and an answer that lands after the budget used to be dropped on
          // the floor — the account then scrolled without its likes, its
          // saved papers or its affinities until a reload. Now it applies the
          // moment it arrives, exactly as an answer in time would have.
          if (settled.status === 'timed_out') {
            profileLoad.then((lateResult) => {
              if (cancelled || !hasInteractionProfile(lateResult)) return;
              console.info('[Recommender] Profile arrived after the budget; applying it now.');
              applyInteractionProfile(lateResult);
            }).catch(() => {});
          }
          return;
        }

        applyInteractionProfile(result);
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
  }, [carryViewedPapers, isKnownPaper, user?.uid]);

  // --- BOREDOM DETECTION ---
  // Tracks consecutive fast skips in the current session to detect user disengagement.
  // When the user rapidly swipes past papers, boredomLevel rises and triggers exploration.
  // Load papers when preferences are available
  const loadPapers = useCallback(async (reset = false, mode?: string | null, randomizeStart = false, pageOverride?: number, { keepThroughVisible = false, seenFallback }: Parameters<FeedContextValue['loadPapers']>[4] = {}) => {
    if (!userPreferences || userPreferences.length === 0) return;
    if (!recommendationProfileReady) return;
    // The ref, not `loading`: the scroll sentinel can fire before React commits
    // the reset load's `loading`, and the first-page load it started replaced
    // the reset one.
    if (!reset && feedLoadInFlight.current) return;
    // Rendered while a load that has since ended was running: `papers` lack
    // the page it showed, so this load would hold its page for enrichment as
    // a first screen does and rank it as if no card were shown. The
    // short-page continuation's timer usually fires before React commits
    // that page.
    if (!reset && loading) {
      loadAfterCommit.current = {
        args: [reset, mode, randomizeStart, pageOverride, { keepThroughVisible, seenFallback }],
        requestId: feedRequestId.current,
        sessionId: feedSessionId.current,
      };
      return;
    }

    const activeMode = mode || feedMode;
    const requestId = ++feedRequestId.current;
    feedLoadInFlight.current = true;
    const activeSessionId = feedSessionId.current;

    setLoading(true);
    setError(null);
    
    let currentPage = pageOverride ?? (reset ? 0 : page);
    if (randomizeStart) {
      currentPage = Math.floor(Math.random() * RESET_START_PAGES);
    }

    const isAvailablePaper = (paper: Paper) => (
      isFeedPublication(paper)
      && !notInterestedIdsRef.current.has(paper.id)
      && !readPaperIdsRef.current.has(paper.id)
      && !likedPaperIdsRef.current.has(paper.id)
      && !savedPaperIdsRef.current.has(paper.id)
      && !sessionSeenPapers.current.has(paper.id)
      && !isKnownPaper(paper.id)
    );

    try {
      let newPapers: Paper[] = [];
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
        // Ties are spread across areas (preferenceRanking.js): on a flat
        // profile the five slots below used to go to the first five of the
        // first area, whatever else the account had picked.
        const rankedPreferences = rankPreferences([...userPreferences, ...followedTopicIds], profileSignals.current.categoryAffinities);

        // ─── STEP 2: Choose query mode based on temporal preference ───
        // Relevance order is for a reader whose views lean to older papers: the
        // corpus ranks their page by likeness alone, without the recency that
        // separates near ties for everyone else.
        const queryMode = (temporalPreference.current || 0) < -0.3 ? 'relevance' : 'recent';
        const positiveIds = selectSemanticProfilePositiveIds(
          curatedIds(interactionProfile.current, 'liked'),
          curatedIds(interactionProfile.current, 'saved'),
        );

        // ─── STEP 3: The reader's categories and follows, from the paper corpus ───
        // One request stands for every source the feed reads: the Worker
        // harvests, merges and enriches them once a day (worker/paper-store.ts)
        // and ranks the page by the reader's liked and saved papers. It asks for
        // two pages' worth so the ranking below still chooses the fifteen shown.
        // The follows are optional: they join the page if they answer in time.
        const followedCandidatesPromise = followedEntities.length > 0
          ? resolveWithin(
            loadTopicRetrieval().then(module => fetchFollowedEntityCandidates(followedEntities, {
              page: currentPage,
              order: queryMode,
              positiveIds,
              categoryIdsOf: follow => module.getFollowedTopicCategoryIds([follow]),
            })),
            OPTIONAL_SOURCE_RENDER_BUDGET_MS,
            [],
          )
          : Promise.resolve<Paper[]>([]);
        let mainPapers: Paper[] = [];
        let mainFailed = false;
        try {
          mainPapers = await fetchCorpusPage({
            categories: rankedPreferences.slice(0, MAIN_CATEGORIES),
            positiveIds,
            page: currentPage,
            pageSize: PAGE_SIZE * 2,
            order: queryMode,
          });
        } catch (e) {
          console.error('Error fetching main papers:', e);
          mainFailed = true;
        }
        mainPapers.forEach(p => { p._type = 'exploit'; });

        // ─── STEP 4: Followed topics, authors, institutions and projects ───
        const followedPapers = await followedCandidatesPromise;

        // Only give up when the follows cannot bootstrap the feed either, nor
        // the seen papers carried from an earlier page.
        if (mainFailed && followedPapers.length === 0 && !seenFallback?.papers?.length) {
          throw new Error('The paper store returned no usable papers.');
        }

        // ─── STEP 5: ADAPTIVE EXPLORATION (always baseline, more if bored) ───
        const explorationPapers: Paper[] = [];
        const currentBoredom = boredomLevel.current;
        
        const userAreas = new Set<string>();
        userPreferences.forEach(pref => {
          const leaf = allCategories.find(c => c.id === pref);
          if (leaf) userAreas.add(leaf.area);
        });

        // Adjacent categories within the user's parent areas, chosen by what
        // exploring each of them has returned so far.
        const nearbyCats = pickExplorationCategories(
          allCategories
            .filter(c => userAreas.has(c.area))
            .filter(c => !userPreferences.includes(c.id))
            .filter(c => (profileSignals.current.categoryAffinities[c.id] || 0) >= -2)
            .map(c => c.id),
          profileSignals.current.categoryExposure,
        );

        const boredomThreshold = getBoredomThreshold();
        const exploreCount = currentBoredom >= boredomThreshold
          ? Math.min(8, Math.floor((currentBoredom - boredomThreshold) / 2) + 5)
          : 5; // Baseline exploration: cold-start users deserve real serendipity

        // The first screen already has a broad candidate pool. Defer exploration
        // to later pages so initial entry is fast.
        const explore = async (categories: string[], count: number) => {
          const papers = await resolveWithin(fetchCorpusPage({
            categories: categories.slice(0, MAIN_CATEGORIES),
            page: Math.floor(Math.random() * 30 / count),
            pageSize: count * 2,
            order: queryMode,
          }).catch((e) => {
            console.error('Error fetching explore papers:', e);
            return [];
          }), FEED_SOURCE_RENDER_BUDGET_MS, []);
          papers.forEach(p => {
            p._type = 'exploration';
            p._debugScore = { isExploration: true };
          });
          return papers;
        };
        if (!reset && nearbyCats.length > 0) {
          explorationPapers.push(...await explore(nearbyCats, exploreCount));
        }

        // If highly bored, pull from completely random categories outside user areas
        if (!reset && currentBoredom >= boredomThreshold * 1.5) {
          const randomCats = allCategories
            .filter(c => !userPreferences.includes(c.id) && !nearbyCats.includes(c.id))
            .map(c => c.id)
            .sort(() => 0.5 - Math.random())
            .slice(0, 2);
          if (randomCats.length > 0) explorationPapers.push(...(await explore(randomCats, 2)).slice(0, 2));
        }

        // ─── STEP 6: Merge, deduplicate, score, and shuffle ───
        const allFetched = [...mainPapers, ...followedPapers, ...explorationPapers];
        
        const uniqueMap = new Map<string, Paper>();
        allFetched.forEach(p => {
          const existing = uniqueMap.get(p.id);
          if (existing) {
            existing._followedEntityMatches = mergeFollowEntityMatches(
              existing._followedEntityMatches,
              p._followedEntityMatches,
            );
          } else {
            uniqueMap.set(p.id, p);
          }
        });
        
        const corePapers = Array.from(uniqueMap.values());
        newPapers = corePapers;
      } else {
        newPapers = await fetchPapers(userPreferences, currentPage * PAGE_SIZE, PAGE_SIZE, activeMode);
      }
      if (requestId !== feedRequestId.current) return;

      // Keep the raw candidates until here: an entirely excluded page still
      // proves that the provider has results and pagination should continue.
      let filtered = newPapers.filter(isAvailablePaper);

      // No paper on this page can be shown: try a later page before showing
      // seen papers again.
      if (filtered.length === 0) {
        // Shown before, but never liked, saved, read or dismissed.
        const bypassSeen = newPapers.filter((p) => 
          isFeedPublication(p) &&
          !notInterestedIdsRef.current.has(p.id) && 
          !readPaperIdsRef.current.has(p.id) &&
          !likedPaperIdsRef.current.has(p.id) &&
          !savedPaperIdsRef.current.has(p.id) &&
          !isKnownPaper(p.id)
        );
        // The first such page this load reached is shown again when no later
        // page has an unseen paper: the feed is never empty because
        // everything was seen.
        const shownBefore = seenFallback ?? (bypassSeen.length > 0 ? { page: currentPage, papers: bypassSeen } : undefined);
        if (newPapers.length > 0 && currentPage < 10) { // Limit auto-fetch depth to avoid infinite loops
          // A reload starts on one of the first RESET_START_PAGES pages and
          // the reader scrolls on from there, so after a few reloads all of
          // them have been shown (browser check 2026-10-21). A seen page
          // moves the next try RESET_START_PAGES pages on, past every reload
          // start; the ceiling above allows two such moves. A page of papers
          // the reader acted on moves one page.
          const nextPageToFetch = currentPage + (bypassSeen.length > 0 ? RESET_START_PAGES : 1);
          console.log(`Every paper on page ${currentPage} was seen or acted on, fetching page ${nextPageToFetch} automatically...`);
          const loadNextPage = () => {
            if (requestId === feedRequestId.current && feedSessionId.current === activeSessionId) {
              return loadPapersRef.current?.(reset, activeMode, false, nextPageToFetch, { keepThroughVisible, seenFallback: shownBefore });
            }
          };
          // A reset goes on as this same load: the first screen keeps waiting
          // instead of showing an empty feed for a moment, and a refresh still
          // replaces the list rather than extending the old one.
          if (reset) return loadNextPage();
          // This load ends here, so the next page's load is not refused as a second one.
          feedLoadInFlight.current = false;
          setLoading(false);
          setPage(nextPageToFetch);
          setTimeout(loadNextPage, 0);
          return;
        }
        if (shownBefore) {
          console.log('No later page has a paper the reader has not seen; showing seen papers again.');
          filtered = shownBefore.papers;
        }
      }

      // The corpus answers two pages' worth; the reader's ranking chooses the page.
      if (activeMode === 'top' || activeMode === null) {
        filtered = diversifiedWeightedShuffle(filtered, {
          scorePaper: calculateAndAttachScore,
          weights: recommendationWeights.current,
          initialPapers: reset && !keepThroughVisible ? [] : papers,
        });
      }
      filtered = takeFeedPage(filtered, PAGE_SIZE);

      // The corpus enriched these papers when it stored them: the page is
      // shown as it arrived.
      if (activeMode === 'top' || activeMode === null) {
        logRankingBatch('fresh feed', filtered);
      }

      // The papers this load shows are not offered again this session. They are
      // not "viewed" until a card reports it (markPaperViewed), so the next load
      // may show one the reader never reached.
      filtered.forEach(p => sessionSeenPapers.current.add(p.id));

      // The page joins the list as it is now, not `papers` as this load found
      // it: while the page loaded, late answers may have filled or removed
      // cards on screen, and a network expansion may have inserted some.
      // A follow change refreshes the ranking but the reader keeps their
      // place: the cards through the visible one stay, the fresh page lands
      // below them (mergeFreshFeedPage). A plain reset still replaces all.
      const addPage = (shown: Paper[]) => {
        if (reset) {
          return keepThroughVisible
            ? mergeFreshFeedPage(shown, filtered, { anchorPaperIds: [visiblePaperIdRef.current] })
            : filtered;
        }
        const existingIds = new Set(shown.map((p) => p.id));
        return [...shown, ...filtered.filter((p) => !existingIds.has(p.id))];
      };
      // When an empty or failed page left this load showing the seen papers
      // it carried, the feed goes on from the page after theirs: the pages
      // this load skipped past may hold papers the reader has not seen.
      const resumeAfter = newPapers.length === 0 ? seenFallback?.page : undefined;
      const nextPage = (resumeAfter ?? currentPage) + 1;
      const nextHasMore = newPapers.length > 0 || resumeAfter !== undefined;
      const snapshotUserId = activeUserId.current;
      const preferenceSignature = feedPreferenceSignature(userPreferences);

      setPapers(current => {
        const nextPapers = addPage(current);
        // The cache and the snapshot keep the list the reader sees.
        feedCache.current[activeMode] = { papers: nextPapers, page: nextPage, hasMore: nextHasMore };
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
        const snapshotWriteKey = `${snapshotUserId}:${preferenceSignature}`;
        const pendingSnapshotWrite = pendingSnapshotWritesRef.current.get(snapshotWriteKey);
        if (pendingSnapshotWrite) {
          clearTimeout(pendingSnapshotWrite.timer);
          pendingSnapshotWritesRef.current.delete(snapshotWriteKey);
        }
        writeFeedSnapshot(snapshotUserId, preferenceSignature, feedCache.current[activeMode]);
        return nextPapers;
      });
      setPage(nextPage);
      setHasMore(nextHasMore);
      autoRetryUsedRef.current = false; // successful load re-arms the safety retry

      // A short first screen should fill itself even before the reader reaches
      // the scroll sentinel. Use the same bounded pagination as excluded pages;
      // a competing load or reset cancels this scheduled continuation. The
      // joined list exists only inside the update above, so this counts from
      // the list this load found: a card removed since can skip a
      // continuation, which the scroll sentinel then makes up for, and a card
      // inserted since can ask for one page more.
      if (addPage(papers).length < PAGE_SIZE && newPapers.length > 0 && currentPage < 10) {
        setTimeout(() => {
          if (requestId === feedRequestId.current && feedSessionId.current === activeSessionId) {
            loadPapersRef.current?.(false, activeMode, false, nextPage);
          }
        }, 0);
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
              loadPapersRef.current?.(true, activeMode, false, undefined, { keepThroughVisible });
            }
          }, 2500);
        }
      }
    } finally {
      if (requestId === feedRequestId.current) {
        feedLoadInFlight.current = false;
        setLoading(false);
      }
    }
  }, [
    userPreferences, page, papers, loading, feedMode,
    profileSignals, isKnownPaper,
    calculateAndAttachScore, followedEntities, recommendationProfileReady,
  ]);

  // The account and interests whose snapshot is on screen. Both effects below
  // restore on a cold mount; the second must not read the snapshot again once
  // the first has shown it, or it would undo what the requests below applied.
  const restoredFeedKeyRef = useRef('');
  // A snapshot can be saved before its page's requests answered, and nothing
  // restarts them after a reload. The restored cards ask again: Crossref for
  // types still unknown, and the abstract sources for a card one can still fill.
  const restoreFeedSnapshot = useCallback((snapshot: FeedSnapshot, mode: string, signature: string) => {
    const key = `${activeUserId.current}:${signature}`;
    if (restoredFeedKeyRef.current === key) return;
    restoredFeedKeyRef.current = key;
    feedCache.current[mode] = snapshot;
    // The restore shows these cards in this session, as a load would: a refresh
    // must not offer them again. Only a card's own report makes one "viewed".
    snapshot.papers.forEach(paper => sessionSeenPapers.current.add(paper.id));
    setPapers(snapshot.papers);
    setPage(snapshot.page || 0);
    setHasMore(snapshot.hasMore !== false);

    const waiting = abstractsInFlight(snapshot.papers, { openAlex: true, europePmc: true, recovery: true });
    const pending = snapshot.papers.filter(paper => waiting.has(paper.id));
    const enrichmentIds = [...new Set(pending.filter(needsOpenAlexEnrichment).map(getOpenAlexEnrichmentId).filter(Boolean))];
    const pmids = [...new Set(pending.map(paper => paper.pmid).filter(Boolean))] as string[];
    followShownPapers({
      mode, sessionId: feedSessionId.current, signature, waiting,
      openAlex: enrichmentIds.length > 0
        ? enrichPapersBatch(enrichmentIds, { timeoutMs: OPENALEX_FEED_REQUEST_TIMEOUT_MS }).catch((err): Awaited<ReturnType<typeof enrichPapersBatch>> => {
          console.error('OpenAlex feed enrichment failed', err);
          return {};
        })
        : null,
      iCite: null,
      europePmc: pmids.length > 0
        ? enrichPubmedIds(pmids).catch((err) => {
          console.warn('Europe PMC feed enrichment failed', err);
          return new Map();
        })
        : null,
      recovery: pending.length > 0 ? recoverFeedAbstracts(pending) : null,
      publications: classifyFeedPublications(snapshot.papers),
    });
  }, [followShownPapers]);

  const preferencesSignatureRef = useRef<string | null>(null);
  const restoredSnapshotKeyRef = useRef('');

  useEffect(() => {
    const signature = feedPreferenceSignature(userPreferences);
    const restoreKey = user?.uid && signature ? `${user.uid}:${signature}` : '';
    if (restoredSnapshotKeyRef.current === restoreKey) return;
    restoredSnapshotKeyRef.current = restoreKey;

    const snapshot = readFeedSnapshot(user?.uid, signature);
    const restoreTimer = setTimeout(() => {
      if (snapshot?.papers?.length) {
        restoreFeedSnapshot(snapshot, feedMode, signature);
      } else if (restoreKey) {
        restoredFeedKeyRef.current = '';
        setPapers([]);
        setPage(0);
        setHasMore(true);
      }
    }, 0);
    return () => clearTimeout(restoreTimer);
  }, [feedMode, isKnownPaper, restoreFeedSnapshot, user?.uid, userPreferences]);

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
    if (isColdMount && restoredFeedKeyRef.current === `${activeUserId.current}:${signature}`) return;
    feedCache.current = {};
    const snapshot = readFeedSnapshot(user?.uid, signature);
    const refreshTimer = setTimeout(() => {
      if (snapshot?.papers?.length) {
        restoreFeedSnapshot(snapshot, feedMode, signature);
        if (isColdMount) return;
      } else {
        setPapers([]);
        setPage(0);
        setHasMore(true);
      }
      loadPapers(true, null, true);
    }, 0);
    return () => clearTimeout(refreshTimer);
  }, [feedMode, feedRouteActive, isKnownPaper, loadPapers, recommendationProfileReady, restoreFeedSnapshot, user?.uid, userPreferences]);

  // The last following signature the FEED applied, or null while there is no
  // account to have one. Null, not '': the tree no longer remounts when the
  // uid arrives (accountScope.js adopts the first account at the same
  // generation), so with '' recorded while the session was still unknown, the
  // account's real follows landing read as a follow CHANGE — a re-rank and,
  // with the profile ready, a replacing reload — on every signed-in cold load.
  const followingSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    // Warm the topic table as soon as a topic follow is known, off the feed's
    // critical path, so loadPapers meets a resident module.
    if (followedEntities.some(entity => entity?.type === 'topic')) void loadTopicRetrieval();
    if (followingLoading) return;
    const signature = followedEntities
      .map(entity => `${entity.type}:${entity.canonicalId}`)
      .sort()
      .join('|');
    // Off the feed route nothing is compared nor recorded: a follow toggled
    // from an entity page is picked up on the next visit to the feed, against
    // the last signature the feed applied — so following and unfollowing on
    // the way costs nothing, and no source cascade fires for a feed nobody is
    // looking at (reported 2026-09-07, same rule as the preferences effect).
    if (!feedRouteActive) return;
    if (!user?.uid) {
      followingSignatureRef.current = null;
      return;
    }
    if (followingSignatureRef.current === signature) return;
    if (followingSignatureRef.current === null) {
      followingSignatureRef.current = signature;
      return;
    }
    followingSignatureRef.current = signature;
    reRankFeed();
    if (recommendationProfileReady) {
      feedCache.current = {};
      // mergeFreshFeedPage keeps the cards through the visible one and lands
      // the fresh ranking below them. reRankFeed() above changes papers
      // whenever it reorders anything, changing loadPapers' identity — so this
      // effect's cleanup usually clears the timer before it fires. Pre-existing
      // race, documented in STATE.md's 2026-09-07 entry; keepThroughVisible
      // makes both outcomes safe, so it's not dead code.
      const refreshTimer = setTimeout(
        () => loadPapers(true, null, true, undefined, { keepThroughVisible: true }),
        0,
      );
      return () => clearTimeout(refreshTimer);
    }
  }, [feedRouteActive, followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady, user?.uid]);

  // Save current papers to cache before switching, then restore or fetch
  const handleSetFeedMode = useCallback((newMode: string) => {
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
    if (hasMore && !feedLoadInFlight.current) loadPapers(false);
  }, [hasMore, loadPapers]);

  // Keep a ref to the latest loadPapers so refreshFeed never captures a stale closure
  useLayoutEffect(() => {
    loadPapersRef.current = loadPapers;
    const stored = loadAfterCommit.current;
    if (!stored) return;
    loadAfterCommit.current = null;
    // From a timer: a load started inside this effect would add a render
    // before the browser shows the page. Checked when it fires, like the
    // continuation timer's call: after another load or an account change,
    // the stored page no longer follows the cards on screen.
    setTimeout(() => {
      if (stored.requestId === feedRequestId.current && stored.sessionId === feedSessionId.current) {
        loadPapersRef.current?.(...stored.args);
      }
    }, 0);
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
        // reset=true, mode=null, randomizeStart=true. FeedContainer jumps to
        // the top for a refresh, and its scroll event can arrive before the
        // new cards and name an old one: the reader is on the first card.
        loadPapersRef.current?.(true, null, true)?.then(() => { visiblePaperIdRef.current = null; }),
        new Promise((resolve) => setTimeout(resolve, 800))
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const toggleLike = useCallback(async (paperInput: Paper) => {
    const paper = withInteractionId(paperInput);
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
    } else {
      newLiked.add(paper.id);
      countEngagement(paperInput.id, { likes: 1 });

      // Update temporal preference
      const daysOld = (Date.now() - new Date(paper.published!).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.1);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.1);
    }
    recordProfileEvent({
      paperId: paper.id,
      kind: isCurrentlyLiked ? 'unlike' : 'like',
      category: paper.primaryCategory,
    }, paper);
    setLikedPaperIds(newLiked);
    reRankFeed(paper.id);

    if (IS_DEMO) {
      demoSet('likedPaperIds', Array.from(newLiked));
      // Store paper metadata for lists
      const allSaved = demoGet<Record<string, Partial<Paper>>>('savedPapersData', {});
      allSaved[paper.id] = {
        title: paper.title, authors: paper.authors?.slice(0, 3),
        primaryCategory: paper.primaryCategory, published: paper.published,
        arxivId: paper.arxivId, summary: paper.summary?.substring(0, 500),
      };
      demoSet('savedPapersData', allSaved);
    } else if (userId) {
      try {
        const ref = interactionDocRef(userId, paper.id);
        await setDoc(ref, definedFields({
          liked: !isCurrentlyLiked,
          paperTitle: paper.title, paperAuthors: paper.authors?.slice(0, 3),
          paperCategory: paper.primaryCategory,
          paperAbstract: paper.summary?.substring(0, 500),
          // The same copy a save keeps. A like used to store only the title
          // and three authors, so the row on the Liked tab knew no DOI, no
          // arXiv id and no year for the paper — nothing to build a link or a
          // kicker from. Written on like only; an unlike changes the flag.
          paper: isCurrentlyLiked ? undefined : serializeLibraryPaper(paper),
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
        }), { merge: true });
        void trackEvent('like_change', {
          action: isCurrentlyLiked ? 'remove' : 'add', paper_id: paper.id, paper_title: paper.title,
        });
      } catch (err) {
        console.error('Error saving like:', err);
        setLikedPaperIds(likedPaperIds);
      }
    }
  }, [withInteractionId, recordProfileEvent, countEngagement, user?.uid, likedPaperIds, reRankFeed, traverseAndExpandNetwork, trackEvent]);

  const markNotInterested = useCallback(async (paperInput: Paper) => {
    const paper = withInteractionId(paperInput);
    const userId = user?.uid;
    const newNotInterested = new Set(notInterestedIdsRef.current);
    newNotInterested.add(paper.id);
    setNotInterestedIds(newNotInterested);
    // The card being removed is the one the reader is on: its successor slides
    // into the viewport and is where they now are. Without it the re-rank below
    // finds no anchor in the removed id and falls back to the top, reshuffling
    // everything under the reader (final review, 2026-09-04).
    const papers = papersRef.current;
    const removedIndex = papers.findIndex((p) => p.id === paper.id);
    const successorId = removedIndex >= 0
      ? (papers[removedIndex + 1]?.id ?? papers[removedIndex - 1]?.id ?? null)
      : null;
    // The slide fires no scroll event, so FeedContainer does not report the
    // successor. A late Crossref answer reads this ref to keep the reader's card.
    if (visiblePaperIdRef.current === paper.id) visiblePaperIdRef.current = successorId;
    setPapers((prev) => prev.filter((p) => p.id !== paper.id));
    recordProfileEvent({
      paperId: paper.id,
      kind: 'notInterested',
      category: paper.primaryCategory,
    }, paper);
    reRankFeed(successorId || paper.id);

    if (IS_DEMO) {
      demoSet('notInterestedIds', Array.from(newNotInterested));
    } else if (userId) {
      try {
        const ref = interactionDocRef(userId, paper.id);
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
  }, [withInteractionId, reRankFeed, recordProfileEvent, user?.uid]);

  // Takes a "Not interested" back. With `atIndex`, the paper returns to this
  // list there, at the card the reader is on, so it comes back where they let
  // it go. Following renders a list of its own filtered by `notInterestedIds`
  // and passes none: the set alone brings it back there.
  const undoNotInterested = useCallback(async (paperInput: Paper, atIndex: number | null = null) => {
    const paper = withInteractionId(paperInput);
    const userId = user?.uid;
    const newNotInterested = new Set(notInterestedIdsRef.current);
    newNotInterested.delete(paper.id);
    setNotInterestedIds(newNotInterested);
    if (atIndex !== null) {
      setPapers((prev) => {
        if (prev.some((p) => p.id === paperInput.id)) return prev;
        const at = Math.min(Math.max(atIndex, 0), prev.length);
        return [...prev.slice(0, at), paperInput, ...prev.slice(at)];
      });
      // As in markNotInterested: the swap fires no scroll event.
      visiblePaperIdRef.current = paperInput.id;
    }
    recordProfileEvent({
      paperId: paper.id,
      kind: 'undoNotInterested',
      category: paper.primaryCategory,
    }, paper);

    if (IS_DEMO) {
      demoSet('notInterestedIds', Array.from(newNotInterested));
    } else if (userId) {
      try {
        await updateDoc(interactionDocRef(userId, paper.id), { notInterested: deleteField() });
      } catch (err) {
        console.error('Error undoing not interested:', err);
      }
    }
  }, [withInteractionId, recordProfileEvent, user?.uid]);

  const markAsRead = useCallback(async (paperInput: Paper) => {
    const paper = withInteractionId(paperInput);
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

    // The card stays where it is: the reader marked it read, they did not ask
    // for it to vanish. `readPaperIdsRef` keeps it out of the next load.

    if (IS_DEMO) {
      demoSet('readPaperIds', Array.from(newRead));
      // Save metadata for the list
      const allSaved = demoGet<Record<string, Partial<Paper>>>('savedPapersData', {});
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
        const ref = interactionDocRef(userId, paper.id);
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
  }, [withInteractionId, recordProfileEvent, user?.uid]);

  const trackViewTime = useCallback(async (paper: Paper, timeInSeconds: number) => {
    const userId = user?.uid;
    if (timeInSeconds < 1) return;
    markPaperViewed(paper.id, userId);
    
    // ─── BOREDOM RESET: user is engaging, not bored ───
    if (timeInSeconds >= 5) {
      boredomLevel.current = Math.max(0, boredomLevel.current - 3);
    }
    
    // Against the median as it stood before this view moves it.
    countEngagement(paper.id, {
      cards: 1,
      deepReads: timeInSeconds >= profileSignals.current.dwellMedianSeconds ? 1 : 0,
    });
    recordProfileEvent({
      paperId: paper.id,
      kind: 'viewTime',
      category: paper.primaryCategory,
      viewTime: timeInSeconds,
    }, paper);
    // A long read moves the temporal preference. It no longer walks the
    // citation network: that was an OpenAlex call for a reader who did nothing,
    // and in the PAP-86 audit's model of a signed-in session those walks were
    // about a tenth of its OpenAlex units (modelled, not measured). A like, a
    // save or an opened PDF still expands the graph.
    if (timeInSeconds >= 10) {
      const daysOld = (Date.now() - new Date(paper.published!).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.05);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.05);
    }
    if (timeInSeconds >= 3.0) {
      // Off the snap path: the reader is settled on this card, not watching
      // the rest of the queue reorder underneath it.
      scheduleReRank(paper.id);
    }

    if (userId && !IS_DEMO) {
      try {
        const ref = interactionDocRef(userId, paper.id);
        await setDoc(ref, definedFields({
          viewTime: increment(timeInSeconds),
          paperCategory: paper.primaryCategory,
          timestamp: new Date().toISOString(),
        }), { merge: true });
      } catch (err) {
        console.error('Error tracking view time:', err);
      }
    }
  }, [markPaperViewed, scheduleReRank, recordProfileEvent, countEngagement, user?.uid]);

  const trackPdfOpened = useCallback(async (paper: Paper) => {
    const userId = user?.uid;
    // ─── BOREDOM RESET & GRAFO EXPANSION: opening PDF = highly engaged ───
    boredomLevel.current = 0;
    traverseAndExpandNetwork(paper);

    recordProfileEvent({
      paperId: paper.id,
      kind: 'openedPdf',
      category: paper.primaryCategory,
    }, paper);
    reRankFeed(paper.id);

    if (userId && !IS_DEMO) {
      try {
        const ref = interactionDocRef(userId, paper.id);
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

  const trackSkips = useCallback(async (papersToSkip: Paper[]) => {
    const userId = user?.uid;
    const skippedPapers = dedupeInteractionPapers(papersToSkip);
    if (skippedPapers.length === 0) return;

    // A fast gesture may cross several cards. Keep every recommendation signal,
    // but score and re-rank the remaining queue only once after the gesture.
    boredomLevel.current = Math.min(20, boredomLevel.current + skippedPapers.length);
    const timestamp = new Date().toISOString();
    skippedPapers.forEach((paper) => {
      markPaperViewed(paper.id, userId);
      countEngagement(paper.id, { cards: 1, skips: 1 });
      recordProfileEvent({
        paperId: paper.id,
        kind: 'skip',
        category: paper.primaryCategory,
        timestamp,
      }, paper);
    });
    // Off the snap path, same as trackViewTime: a fling across several cards
    // must not pay a synchronous re-rank per card it crosses.
    scheduleReRank(skippedPapers[skippedPapers.length - 1].id);

    if (userId && !IS_DEMO) {
      try {
        const batch = writeBatch(db);
        const deviceType = getDeviceInfo().type;

        skippedPapers.forEach((paper) => {
          const ref = interactionDocRef(userId, paper.id);
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
  }, [markPaperViewed, scheduleReRank, recordProfileEvent, countEngagement, user?.uid]);

  const trackSkip = useCallback((paper: Paper) => trackSkips([paper]), [trackSkips]);

  const trackPdfBounce = useCallback(async (paper: Paper) => {
    const userId = user?.uid;
    // The PDF was opened and closed at once.
    recordProfileEvent({
      paperId: paper.id,
      kind: 'pdfBounce',
      category: paper.primaryCategory,
    }, paper);
    reRankFeed(paper.id);

    if (userId && !IS_DEMO) {
      try {
        const ref = interactionDocRef(userId, paper.id);
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

  const markSaved = useCallback(async (paperOrIdInput: Paper | string) => {
    const paperOrId = paperOrIdInput && typeof paperOrIdInput === 'object' ? withInteractionId(paperOrIdInput) : paperOrIdInput;
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
      const daysOld = (Date.now() - new Date(paper.published!).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld <= 7) temporalPreference.current = Math.min(1, temporalPreference.current + 0.15);
      else if (daysOld >= 365) temporalPreference.current = Math.max(-1, temporalPreference.current - 0.15);
      
      // Expand network via OpenAlex
      traverseAndExpandNetwork(paper);
    }

    const nextSaved = new Set(savedPaperIdsRef.current);
    nextSaved.add(paperId);
    savedPaperIdsRef.current = nextSaved;
    setSavedPaperIds(nextSaved);
    countEngagement(typeof paperOrIdInput === 'string' ? paperOrIdInput : paperOrIdInput.id, { saves: 1 });
    recordProfileEvent({
      paperId,
      kind: 'save',
      category: paper?.primaryCategory,
    }, paper);
    // Saving is the strongest positive signal; react immediately like the rest.
    reRankFeed(paperId);

    if (IS_DEMO) {
      demoSet('savedPaperIds', Array.from(nextSaved));
      return;
    }

    if (userId) {
      try {
        const ref = interactionDocRef(userId, paperId);
        const interactionData: InteractionDocumentData & { deviceType: string } = {
          saved: true,
          timestamp: new Date().toISOString(),
          deviceType: getDeviceInfo().type,
        };

        if (paper?.title) interactionData.paperTitle = paper.title;
        if (paper?.authors?.length) interactionData.paperAuthors = paper.authors.slice(0, 3);
        if (paper?.primaryCategory) interactionData.paperCategory = paper.primaryCategory;
        if (paper?.summary) interactionData.paperAbstract = paper.summary.substring(0, 500);
        // The same copy a like keeps. The library reads this record before any
        // savedPapers document, and without a copy a saved paper had no field
        // to show (PAP-60).
        if (paper) interactionData.paper = serializeLibraryPaper(paper);

        await setDoc(ref, interactionData, { merge: true });
      } catch (err) {
        console.error('Error saving recommendation interaction:', err);
      }
      // PAP-60, D6. The Save button and the save sheet write the savedPapers
      // document, and the button writes Read later, before this mark. A late
      // OpenAlex answer in that time found the paper unmarked and left its
      // copies without the topic the feed's card now carries.
      const written = typeof paperOrIdInput === 'object' ? paperOrIdInput : paper;
      const shown = written && papersRef.current.find(card => card.id === written.id);
      if (written && shown) keepLateTopicsRef.current(cardsGivenTopic([written], [shown]));
    }
  }, [withInteractionId, papers, reRankFeed, recordProfileEvent, countEngagement, traverseAndExpandNetwork, user?.uid]);

  /**
   * The way back from markSaved: the paper has left every list and Read later,
   * so the Save button must go dark again. The saved-paper document stays —
   * it is the metadata copy the lists hydrate from, and a later save simply
   * merges over it. The interaction keeps `saved: false` rather than losing
   * the field, the same flag a rebuild of the aggregate reads.
   */
  const unmarkSaved = useCallback(async (paperOrIdInput: Paper | string) => {
    const paperOrId = paperOrIdInput && typeof paperOrIdInput === 'object' ? withInteractionId(paperOrIdInput) : paperOrIdInput;
    const userId = user?.uid;
    const paperId = typeof paperOrId === 'string' ? paperOrId : paperOrId?.id;
    if (!paperId || !savedPaperIdsRef.current.has(paperId)) return;

    const paper = typeof paperOrId === 'object'
      ? paperOrId
      : papers.find(p => p.id === paperId);
    const nextSaved = new Set(savedPaperIdsRef.current);
    nextSaved.delete(paperId);
    savedPaperIdsRef.current = nextSaved;
    setSavedPaperIds(nextSaved);
    // Gives back exactly what markSaved lent.
    recordProfileEvent({
      paperId,
      kind: 'unsave',
      category: paper?.primaryCategory,
    }, paper);
    reRankFeed(paperId);

    if (IS_DEMO) {
      demoSet('savedPaperIds', Array.from(nextSaved));
      return;
    }

    if (userId) {
      try {
        await setDoc(interactionDocRef(userId, paperId), {
          saved: false,
          timestamp: new Date().toISOString(),
        }, { merge: true });
      } catch (err) {
        console.error('Error removing the saved mark:', err);
      }
    }
  }, [withInteractionId, papers, reRankFeed, recordProfileEvent, user?.uid]);

  const unmarkAsRead = useCallback(async (paperId: string) => {
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
        const ref = interactionDocRef(userId, paperId);
        await updateDoc(ref, {
          read: deleteField(),
          readAt: deleteField(),
        });
      } catch (err) {
        console.error('Error unmarking read status:', err);
      }
    }
  }, [recordProfileEvent, user?.uid]);

  const toggleReadLater = useCallback(async (paperInput: Paper) => {
    const paper = withInteractionId(paperInput);
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
        await setDoc(interactionDocRef(userId, paper.id), definedFields({
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
  }, [withInteractionId, personalLibrary, recordProfileEvent, user?.uid]);

  const saveReadingMetadata = useCallback(async (paperInput: Paper, { note = '', tags = [] }: { note?: string; tags?: string[] }) => {
    const paper = withInteractionId(paperInput);
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
        await setDoc(interactionDocRef(userId, paper.id), definedFields({
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
  }, [withInteractionId, recordProfileEvent, user?.uid]);

  const getRecommendationProfileSnapshot = useCallback(() => ({
    userId: user?.uid || null,
    ready: recommendationProfileReady,
    userPreferences: [...(userPreferences || [])],
    followedAuthors: [...(followedAuthors || [])],
    followedEntities: followedEntities.map(entity => ({ ...entity })),
    categoryAffinities: { ...profileSignals.current.categoryAffinities },
    conceptAffinities: { ...profileSignals.current.conceptAffinities },
    authorAffinities: { ...profileSignals.current.authorAffinities },
    sessionAffinities: { ...profileSignals.current.sessionAffinities },
    interactionCount: profileSignals.current.interactionCount,
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
    papers, loading, error, hasMore, isRefreshing, loadingAbstractIds,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds, personalLibrary,
    libraryPapers,
    ensurePersonalLibrary,
    interactionIdFor, libraryCopyFor,
    feedMode, setFeedMode: handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
    reportVisiblePaper,
    toggleLike, markNotInterested, undoNotInterested, markSaved, unmarkSaved, markAsRead, unmarkAsRead,
    toggleReadLater, saveReadingMetadata,
    trackViewTime, trackPdfOpened, trackSkip, trackSkips, trackPdfBounce
  }), [
    papers, loading, error, hasMore, isRefreshing, loadingAbstractIds,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds, personalLibrary,
    libraryPapers,
    ensurePersonalLibrary,
    interactionIdFor, libraryCopyFor,
    feedMode, handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
    reportVisiblePaper,
    toggleLike, markNotInterested, undoNotInterested, markSaved, unmarkSaved, markAsRead, unmarkAsRead,
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
