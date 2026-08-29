import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, BadgeCheck, Bookmark, FolderOpen, Globe2, Heart, Lock, RefreshCw, Rss,
  Settings2, UserCheck, UserPlus, UserX,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useFeed } from '../../context/FeedContext.jsx';
import { useFollowing } from '../../context/FollowingContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import {
  mergeShowcaseCards,
  needsVisibilityChoice,
  profileIsPublic,
  readOwnLists,
  readOwnUserProfile,
  readProfileLists,
  readUserProfileByHandle,
} from '../../services/userProfileService.js';
import VisibilityPrompt from '../Profile/VisibilityPrompt.jsx';
import {
  countFollowedUsers,
  countFollowers,
  followUser,
  isFollowing as readIsFollowing,
  unfollowUser,
} from '../../services/followUserService.js';
import { fetchLibraryRecords } from '../../services/interactionProfileStore.js';
import { IS_DEMO } from '../../services/firebase.js';
import { getPublicListPath, getPublicPaperPath } from '../../utils/publicNavigation.js';
import { resolveProfileView } from '../../utils/profileAccess.js';
import { resolveListColor } from '../../utils/listColors.js';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import {
  createPendingIdRequests,
  requestMissingRecords,
} from '../../utils/pendingIdRequests.js';
import {
  followStatsCache,
  handleProfileKey,
  likedExtraCache,
  ownListsCache,
  ownProfileCache,
  ownProfileKey,
  rememberFollowStats,
  rememberOwnProfile,
  showcaseCache,
} from '../../utils/profileSessionCaches.js';
import { readStoredFollowStats, saveStoredFollowStats } from '../../utils/userScopedStorage.js';
import { cleanPaperText, displayAuthorName } from '../../utils/paperText.js';
import { getIcon } from '../../utils/icons.js';
import { normalizeHandle } from '../../utils/userHandle.js';
import ScientificText from '../ScientificText.js';
import FollowSheet from './FollowSheet.jsx';
import './PublicProfilePage.css';

/**
 * The profile page — one page for everyone, with what it shows decided by who
 * is looking (`resolveProfileView`). Two routes render it:
 *
 *   /public/user/{handle}  the shareable URL; works signed out. Two public
 *                          reads: the handle reservation, then the profile.
 *   /profile               the signed-in user's own profile, behind
 *                          ProtectedRoute. One read for the own profile doc,
 *                          which may not exist yet — the page still renders
 *                          from the account identity and offers to create it.
 *
 * A visitor gets the header plus the pinned public lists denormalized into the
 * profile document — nothing else is fetched, so nothing else can leak. The
 * owner additionally gets the Saved/Liked tabs, fed from data the app already
 * holds in memory plus two bounded reads.
 *
 * The header counters both count *users*: Following and Followers come from
 * the public `follows` edges (one capped aggregation each — public data, so a
 * visitor sees real numbers too, with no dashes standing in for privacy). The
 * *entities* the owner follows for their feed — authors, topics, institutions,
 * private under `users/{uid}/following` — are deliberately a separate chip
 * ("Followed content"), because one word meaning two different graphs was a
 * standing source of confusion. Likes stay owner-only: the visitor header just
 * has one stat fewer, rather than a dash pretending data is missing.
 */

// One page of rows per tab. Anything past it stays reachable in Mis listas;
// the point here is a profile, not an infinite archive.
const PROFILE_TAB_ROW_LIMIT = 60;
// The first retry lands fast enough that a blip stays invisible; every miss
// after that doubles the wait, so an outage costs one cheap request per
// ceiling instead of a page stuck on fallback titles — and heals on its own
// the moment the backend answers again.
const LIKED_RETRY_BASE_MS = 600;
const LIKED_RETRY_MAX_MS = 60_000;

function authorLine(authors) {
  const names = (Array.isArray(authors) ? authors : [])
    .map(author => displayAuthorName(typeof author === 'string' ? author : author?.name || ''))
    .filter(Boolean);
  if (names.length === 0) return '';
  return names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(', ');
}

// Entry of one row or card in a panel. The delay is capped so the fortieth
// row does not make the page feel slower than the fourth.
const rowMotion = (prefersReducedMotion, index) => ({
  initial: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 7 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      delay: prefersReducedMotion ? 0 : Math.min(index * 0.022, 0.22),
      duration: prefersReducedMotion ? 0.08 : 0.2,
      ease: 'easeOut',
    },
  },
});

function PaperRow({ row, isEnglish, libraryReady }) {
  /**
   * A row with no title is a row we have not heard about, and it must not say
   * otherwise. It used to print "Untitled paper" — fifty of them at once on a
   * cold Liked tab, each stating as a fact something no read had established.
   *
   * While the library read is still out, the row is a shimmer. Once it has
   * answered and this id still has nothing, the row shows the id in mono, which
   * is what it actually is and matches how the lists screen says the same thing.
   */
  if (row.unresolved) {
    return (
      <div className={`profile-row profile-row--unresolved${libraryReady ? '' : ' profile-row--waiting'}`}>
        {libraryReady
          ? <span className="profile-row-title profile-row-title--placeholder">{row.id}</span>
          : <span className="public-profile-skeleton public-profile-skeleton--row" aria-hidden="true" />}
      </div>
    );
  }

  // Titles arrive with source dirt (literal <sub> tags, $LaTeX$): HTML is
  // cleaned here at paint time — the stored documents keep the debt visible —
  // and the math is rendered by the same component the feed cards use.
  const title = cleanPaperText(row.title);
  // The row carries its paper's research field, the same gesture the Explorer's
  // rows and the feed's cards make: a 3px rule of `--area-accent` down the
  // inner edge and a kicker in that same ink. A row whose seed never arrived
  // simply has no kicker and no colour — nothing is guessed.
  const paper = row.seed;
  const field = paper ? areaLabelForPaper(paper, { english: isEnglish }) : null;
  const kicker = [field, paper?.year].filter(Boolean).join(' · ');
  const style = paper ? { '--area-accent': areaAccentForPaper(paper) } : undefined;
  const body = (
    <>
      {kicker && <span className="profile-row-kicker">{kicker}</span>}
      <span className="profile-row-title"><ScientificText>{title}</ScientificText></span>
      {row.subtitle && <span className="profile-row-meta">{row.subtitle}</span>}
    </>
  );
  // Interaction ids that predate the canonical paper key (raw OpenAlex ids and
  // friends) do not map to a public paper page; those rows are labels, not
  // links. The rows that do link hand over whatever copy of the paper is
  // already in memory, so the paper page can render without waiting on — or
  // being rate-limited by — arXiv.
  return row.path
    ? (
      <Link
        className="profile-row"
        style={style}
        to={row.path}
        state={row.seed ? { paper: row.seed } : undefined}
      >
        {body}
      </Link>
    )
    : <div className="profile-row profile-row--static" style={style}>{body}</div>;
}

/**
 * "Member since March 2026", or nothing at all.
 *
 * `createdAt` is written in the same batch that reserves the handle, so a
 * profile that exists carries one — but it arrives as whatever Firestore
 * stored, and a shape this cannot read (a legacy document, a Timestamp that
 * never resolved) leaves the line out rather than printing a date nobody can
 * vouch for. Month and year only: the day is noise on a profile.
 */
function joinedLabel(createdAt, isEnglish) {
  const millis = createdAt?.toMillis?.()
    ?? (typeof createdAt?.seconds === 'number' ? createdAt.seconds * 1000 : Date.parse(createdAt));
  if (!Number.isFinite(millis)) return '';
  return new Date(millis).toLocaleDateString(isEnglish ? 'en' : 'es', {
    month: 'short',
    year: 'numeric',
  });
}

function EmptyState({ Icon, title, hint, action }) {
  return (
    <div className="profile-empty-state">
      <span className="profile-empty-icon" aria-hidden="true"><Icon size={20} /></span>
      <p className="profile-empty-title">{title}</p>
      {hint && <p className="profile-empty-hint">{hint}</p>}
      {action}
    </div>
  );
}

/**
 * The copy of the paper this row can hand to the paper page. A serialized
 * library record travels as is; a like that only stored title metadata
 * becomes a stub — but only for arXiv-shaped ids, because the legacy paper
 * adapter derives arXiv links from `id` and would fabricate broken ones for
 * anything else. The seed keeps the stored title untouched: cleanup is a
 * display concern, and the paper page does its own.
 */
function seedPaperFor(id, storedPaper, title, authors, category) {
  if (storedPaper) return storedPaper;
  if (!title) return null;
  const raw = String(id);
  if (!/^(arxiv:)?(\d{4}\.\d{4,5}|[a-z-]+(\.[a-z]{2})?\/\d{7})(v\d+)?$/i.test(raw)) return null;
  return {
    id: raw.replace(/^arxiv:/i, ''),
    title,
    authors: Array.isArray(authors) ? authors : [],
    primaryCategory: category || '',
  };
}

/**
 * The counters this page can paint before asking anybody.
 *
 * The session cache first — this tab has almost certainly had them already —
 * and then, for your own profile only, what this device remembered from a
 * previous session. Other people's counters are deliberately not carried across
 * a reload: you re-enter your own profile constantly and somebody else's once,
 * so the staleness would buy nothing.
 */
function readSeededFollowStats(uid, selfMode) {
  if (!uid) return null;
  return followStatsCache.get(uid) || (selfMode ? readStoredFollowStats(uid) : null);
}

export default function PublicProfilePage({ handle: handleProp, selfMode = false, onAuthRequired }) {
  const params = useParams();
  const handle = selfMode ? '' : normalizeHandle(handleProp || params.handle);
  const { isEnglish } = useLanguage();
  const prefersReducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const {
    user, profilePhoto, onboardingComplete, profileLoadError,
  } = useAuth();
  const {
    likedPaperIds, personalLibrary, libraryPapers, ensurePersonalLibrary, getCuratedInteractionIds,
  } = useFeed();
  const { followedEntities, loading: followingLoading } = useFollowing();

  // `{ profile }` wrappers, because "this account has no public profile yet"
  // (a null) is itself a cacheable answer on one's own page.
  const profileCacheKey = selfMode ? ownProfileKey(user?.uid) : handleProfileKey(handle);
  const seededProfile = profileCacheKey ? ownProfileCache.get(profileCacheKey) : undefined;
  const [profile, setProfile] = useState(seededProfile ? seededProfile.profile : null);
  const [status, setStatus] = useState(seededProfile ? 'ready' : 'loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [requestedTab, setRequestedTab] = useState('lists');
  const [ownLists, setOwnLists] = useState(
    () => (user?.uid ? ownListsCache.get(user.uid) ?? null : null),
  );
  const [ownListsFailed, setOwnListsFailed] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [likedExtra, setLikedExtra] = useState(
    () => (user?.uid && likedExtraCache.get(user.uid)) || {},
  );
  const likedRequests = useRef(null);
  if (likedRequests.current === null) likedRequests.current = createPendingIdRequests();
  // Releasing a claim mutates a ref, which schedules no render. This token is
  // what turns "these ids are askable again" into an effect that actually runs.
  const [likedRetry, setLikedRetry] = useState(0);
  // Follows (F2). `null` still means "not asked yet" — what keeps the header
  // from flashing a zero before the real number lands — but starting there on a
  // page you were looking at two seconds ago announces a wait that need not
  // happen. These two were the last state here with no seed, and the only ones
  // that cannot borrow one from Firestore: a `count()` aggregation is
  // server-only, so a warm channel buys them nothing.
  // Lazy, like the seeds above it: the device read costs a JSON.parse, and a
  // seed is a thing you need once per mount, not once per render.
  const seedStatsUid = selfMode ? (user?.uid || '') : (seededProfile?.profile?.uid || '');
  const [followerStats, setFollowerStats] = useState(
    () => readSeededFollowStats(seedStatsUid, selfMode)?.followers ?? null,
  );
  const [followedStats, setFollowedStats] = useState(
    () => readSeededFollowStats(seedStatsUid, selfMode)?.followed ?? null,
  );
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState(false);
  const [followHover, setFollowHover] = useState(false);
  const [followSheet, setFollowSheet] = useState(null);
  const [promptDismissed, setPromptDismissed] = useState(false);
  // The showcase (F12): the visitor's Listas tab reads `profileLists/{uid}`,
  // one document. `null` is "not answered yet" — while it is null the tab
  // paints the legacy pinned cards embedded in the profile, which cost
  // nothing, and the merged view fills in when the read lands.
  const [showcase, setShowcase] = useState(
    () => (profile?.uid ? showcaseCache.get(profile.uid) ?? null : null),
  );

  const view = resolveProfileView({
    viewerUid: user?.uid,
    profileUid: profile?.uid,
    selfMode,
  });
  const activeTab = view.tabs.includes(requestedTab) ? requestedTab : 'lists';
  // Signed in, the app Navbar stays on this page (App.jsx shows it for
  // /public/user/* too); signed out it is the standalone shared-link page,
  // with its own brand line and breathing room instead.
  const hasAppChrome = selfMode
    || (Boolean(user) && Boolean(onboardingComplete) && !profileLoadError);

  useEffect(() => {
    let active = true;
    const request = selfMode ? readOwnUserProfile() : readUserProfileByHandle(handle);
    request
      .then(result => {
        if (profileCacheKey) {
          // A visitor's not-found is not cached: the profile could be created
          // a moment later, and 'not-found' must stay a fresh answer.
          if (selfMode) rememberOwnProfile(user?.uid, result);
          else if (result) ownProfileCache.set(profileCacheKey, { profile: result });
          else ownProfileCache.delete(profileCacheKey);
        }
        if (!active) return;
        setProfile(result);
        // Having no public profile yet is a normal state of one's own page,
        // not a missing page.
        setStatus(result || selfMode ? 'ready' : 'not-found');
      })
      .catch(error => {
        console.error('Error loading public profile:', error);
        if (!active) return;
        // A failed revalidation must not replace a perfectly good cached view
        // with an error page; the page keeps what it is showing and the next
        // mount tries again.
        if (profileCacheKey && ownProfileCache.get(profileCacheKey)) return;
        setStatus(error?.code === 'USER_PROFILES_UNSUPPORTED_IN_DEMO' ? 'unsupported' : 'error');
      });
    return () => { active = false; };
  }, [handle, selfMode, reloadToken, profileCacheKey, user?.uid]);

  // The showcase read, for the visitor tab only: the owner tab renders the
  // account's own lists. Seeded from the session cache, revalidated behind
  // the painted view; a failure keeps whatever is showing (worst case, the
  // legacy pins) rather than replacing it with an error.
  useEffect(() => {
    const uid = profile?.uid;
    if (!uid || view.isOwner) return undefined;
    let active = true;
    readProfileLists(uid)
      .then(cards => {
        const settled = cards ?? [];
        showcaseCache.set(uid, settled);
        if (active) setShowcase(settled);
      })
      .catch(error => {
        console.warn('The showcase could not be read:', error);
      });
    return () => { active = false; };
  }, [profile?.uid, view.isOwner, reloadToken]);

  // Owner data. Each effect is gated on `view.isOwner`, which is the privacy
  // boundary: a visitor's render never even asks for these.
  useEffect(() => {
    if (!view.isOwner || status !== 'ready' || IS_DEMO) return undefined;
    let active = true;
    const uid = user?.uid;
    readOwnLists()
      .then(lists => {
        if (uid) ownListsCache.set(uid, lists);
        if (!active) return;
        setOwnLists(lists);
        setOwnListsFailed(false);
      })
      .catch(error => {
        console.error('Error loading own lists:', error);
        if (!active) return;
        // Lists already on screen (from the session cache) beat an error row.
        if (uid && ownListsCache.get(uid)) return;
        setOwnLists([]);
        setOwnListsFailed(true);
      });
    return () => { active = false; };
  }, [view.isOwner, status, reloadToken, user?.uid]);

  useEffect(() => {
    if (!view.isOwner) return undefined;
    let active = true;
    Promise.resolve(ensurePersonalLibrary()).finally(() => {
      if (active) setLibraryReady(true);
    });
    return () => { active = false; };
  }, [view.isOwner, ensurePersonalLibrary]);

  /**
   * The follow numbers of the profile on screen.
   *
   * Three reads at most: two capped `count()` aggregations (one billed read
   * each, whatever the size of the graph) plus, for a signed-in visitor, the
   * single `get` that answers "do I already follow this person" — the owner
   * skips that one. On one's own page the uid works even before a public
   * profile exists: follows are keyed by uid, not by handle.
   *
   * Deliberately not one `Promise.all` any more. Three answers the header uses
   * separately have no business waiting for each other: each counter paints the
   * moment its own aggregation lands, and a visitor's Follow button stops being
   * held hostage by two numbers it does not need.
   */
  const statsUid = profile?.uid || (selfMode ? user?.uid || '' : '');
  useEffect(() => {
    if (!statsUid || IS_DEMO) return undefined;
    let active = true;

    // A failed revalidation must not replace a good cached number with a dash —
    // the same rule the profile and lists reads above follow. `null` here means
    // "this read failed"; the setter below decides whether there is anything
    // worth keeping instead.
    const settle = (read, apply) => {
      read
        .then(value => { if (active) apply(value); })
        .catch(error => {
          console.error('Error loading follow counters:', error);
          if (active) apply(null);
        });
    };

    settle(countFollowers(statsUid), value => {
      if (value) rememberFollowStats(statsUid, { followers: value });
      setFollowerStats(current => value ?? current ?? { count: null, capped: false });
    });
    settle(countFollowedUsers(statsUid), value => {
      if (value) rememberFollowStats(statsUid, { followed: value });
      setFollowedStats(current => value ?? current ?? { count: null, capped: false });
    });
    if (!view.isOwner) {
      readIsFollowing(statsUid)
        .then(viewerFollows => { if (active) setFollowing(viewerFollows); })
        .catch(error => console.error('Error reading the follow edge:', error));
    }

    return () => { active = false; };
  }, [statsUid, user?.uid, view.isOwner, reloadToken]);

  /**
   * What the counters look like right now, cache included.
   *
   * A visitor jumping from one profile to the next gets `statsUid` only when the
   * new profile document lands — after this component's state was initialised —
   * so the seed above cannot have caught it. Consulting the cache at render time
   * covers that case, exactly as `showcaseView` does further down.
   */
  const cachedStats = statsUid ? followStatsCache.get(statsUid) : undefined;
  const followersView = followerStats ?? cachedStats?.followers ?? null;
  const followedView = followedStats ?? cachedStats?.followed ?? null;

  // Write-through to the device, own profile only: the next cold start opens on
  // these numbers instead of on an ellipsis. Nothing else is persisted.
  useEffect(() => {
    if (!selfMode || !user?.uid || IS_DEMO) return;
    saveStoredFollowStats(user.uid, { followers: followersView, followed: followedView });
  }, [selfMode, user?.uid, followersView, followedView]);

  /**
   * Follow / unfollow. The service is idempotent — the composite edge id makes
   * a duplicate impossible and the rules refuse the second write — so the only
   * thing to guard here is the counter, which moves optimistically and rolls
   * back if the write really failed.
   */
  const toggleFollow = async () => {
    if (!user) { onAuthRequired?.(); return; }
    if (!statsUid || followBusy) return;
    const wasFollowing = following;
    setFollowBusy(true);
    setFollowError(false);
    setFollowing(!wasFollowing);
    // The label must land on its resting state ("Following", quiet), not on
    // the hover state ("Unfollow", danger) the pointer happens to be over.
    setFollowHover(false);
    // The ±1 is written through to the cache as well, so leaving the page and
    // coming back shows the number you just changed rather than the one before.
    const shift = (stats, delta) => (stats
      ? { ...stats, count: Math.max(0, stats.count + delta) }
      : null);
    const applyCount = (stats) => {
      if (!stats) return;
      setFollowerStats(stats);
      rememberFollowStats(statsUid, { followers: stats });
    };
    applyCount(shift(followersView, wasFollowing ? -1 : 1));
    try {
      const result = wasFollowing
        ? await unfollowUser(statsUid)
        : await followUser(statsUid);
      // `changed: false` means the edge was already in the requested state, so
      // the optimistic ±1 counted something that had already been counted.
      if (!result.changed) {
        applyCount(await countFollowers(statsUid));
      }
    } catch (error) {
      console.error('Error updating follow:', error);
      setFollowing(wasFollowing);
      applyCount(shift(followersView, wasFollowing ? 1 : -1));
      setFollowError(true);
    } finally {
      setFollowBusy(false);
    }
  };

  // Recency order from the aggregate; the sets in context are sorted by id.
  // The fallback covers demo mode, where only the sets exist.
  const likedOrder = useMemo(() => {
    if (!view.isOwner) return [];
    const curated = getCuratedInteractionIds('liked');
    return (curated.length > 0 ? curated : [...likedPaperIds]).slice(0, PROFILE_TAB_ROW_LIMIT);
  }, [view.isOwner, getCuratedInteractionIds, likedPaperIds]);

  useEffect(() => {
    if (!view.isOwner || activeTab !== 'liked' || IS_DEMO || !user?.uid) return undefined;
    // `libraryPapers` is the mount's own read, which now KEEPS what it fetches.
    // Every liked paper is in its id set, so in the ordinary case this filter
    // empties and the second fan-out over the same collection never happens.
    const wanted = likedOrder.filter(
      id => !personalLibrary[id]?.paper && !libraryPapers[id] && !likedExtra[id],
    );
    if (wanted.length === 0) return undefined;
    let abandoned = false;
    let retryTimer = null;

    // An id counts as asked-for only once its response lands (`pendingIdRequests`
    // holds the claim until then), so a read that fails or never arrives leaves
    // the id askable instead of leaving its row on the fallback title for the
    // life of the page.
    requestMissingRecords({
      ids: wanted,
      requests: likedRequests.current,
      fetchRecords: ids => fetchLibraryRecords(user.uid, ids),
    }).then(({ records, retryable, attempt, error }) => {
      // The merge is deliberately not cancelled: `likedExtra` is a cache keyed
      // by id, so a response arriving after a tab switch is idempotent and
      // still fills the rows, and after unmount setState is a no-op.
      if (records.length > 0) {
        setLikedExtra(current => {
          const next = { ...current };
          records.forEach(({ id, data }) => { next[id] = data; });
          return next;
        });
      }
      if (error) console.error('Error loading liked paper titles:', error);
      // The retry, on the other hand, only makes sense while this effect is
      // still the live one. `retryable` covers both a rejected read and the
      // quieter failure: a "successful" answer served from the local cache
      // with the backend unreachable, which must never be allowed to settle
      // as "these papers have no titles". Each attempt doubles the wait so
      // the retries outlast the blip instead of all landing inside it.
      if (retryable && !abandoned) {
        const delay = Math.min(
          LIKED_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
          LIKED_RETRY_MAX_MS,
        );
        retryTimer = setTimeout(() => setLikedRetry(count => count + 1), delay);
      }
    });

    return () => {
      abandoned = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    view.isOwner, activeTab, likedOrder, personalLibrary, libraryPapers, likedExtra,
    user?.uid, likedRetry,
  ]);

  // Write-through: every title that lands survives the next unmount, so
  // re-entering the profile paints the Liked tab from memory instead of
  // re-reading forty documents.
  useEffect(() => {
    if (!user?.uid || Object.keys(likedExtra).length === 0) return;
    likedExtraCache.set(user.uid, likedExtra);
  }, [likedExtra, user?.uid]);

  const likedRows = useMemo(() => likedOrder.map(id => {
    const library = personalLibrary[id]?.paper;
    const extra = likedExtra[id];
    const paper = library || libraryPapers[id] || extra?.paper;
    const title = paper?.title || extra?.paperTitle || '';
    const authors = paper?.authors || extra?.paperAuthors || [];
    return {
      id,
      title,
      // No title is never "this paper has no title" — a paper always has one.
      // It means the read has not answered for this id, and the row has to say
      // that rather than print a definite-sounding "Untitled paper".
      unresolved: !title,
      subtitle: authorLine(authors),
      path: paper ? getPublicPaperPath(paper) || getPublicPaperPath(id) : getPublicPaperPath(id),
      seed: seedPaperFor(id, paper, title, authors, extra?.paperCategory),
    };
  }), [likedOrder, personalLibrary, libraryPapers, likedExtra]);

  // Same source and ordering as the "Leer después" pseudo-list in Mis listas.
  const savedRows = useMemo(() => {
    if (!view.isOwner) return [];
    return Object.values(personalLibrary)
      .filter(record => record.readLater)
      .sort((first, second) => new Date(second.updatedAt || 0) - new Date(first.updatedAt || 0))
      .slice(0, PROFILE_TAB_ROW_LIMIT)
      .map(record => ({
        id: record.paperId,
        title: record.paper?.title || '',
        subtitle: authorLine(record.paper?.authors),
        path: getPublicPaperPath(record.paper) || getPublicPaperPath(record.paperId),
        seed: record.paper || null,
      }));
  }, [view.isOwner, personalLibrary]);

  const metadata = useMemo(() => {
    const fallbackDescription = {
      en: 'A public researcher profile on PaperTok.',
      es: 'Un perfil público de investigación en PaperTok.',
    };
    if (selfMode) {
      return {
        route: '/profile',
        title: { en: 'My profile | PaperTok', es: 'Mi perfil | PaperTok' },
        description: fallbackDescription,
        imageAlt: {
          en: 'A researcher profile on PaperTok',
          es: 'Un perfil de investigación en PaperTok',
        },
        noIndex: true,
      };
    }
    return {
      route: `/public/user/${handle}`,
      title: profile ? {
        en: `${profile.displayName} (@${profile.handle}) | PaperTok`,
        es: `${profile.displayName} (@${profile.handle}) | PaperTok`,
      } : {
        en: 'Public profile | PaperTok',
        es: 'Perfil público | PaperTok',
      },
      description: profile?.bio || fallbackDescription,
      imageAlt: {
        en: 'A public researcher profile on PaperTok',
        es: 'Un perfil público de investigación en PaperTok',
      },
      noIndex: status !== 'ready',
    };
  }, [handle, profile, selfMode, status]);
  usePublicPageMetadata(metadata);

  const copy = isEnglish ? {
    brand: 'PaperTok',
    publicProfile: 'Public profile',
    loading: 'Opening profile...',
    notFoundTitle: 'This profile is not available',
    notFoundBody: 'The handle may have changed or the link may be incomplete.',
    errorTitle: 'The profile could not be loaded',
    errorBody: 'Check your connection and try again.',
    unsupportedTitle: 'Profiles are unavailable in demo mode',
    unsupportedBody: 'Open this link in the full PaperTok app.',
    retry: 'Try again',
    verified: 'Verified researcher',
    kicker: 'Profile',
    joined: label => `Member since ${label}`,
    publicLists: count => `${count} public ${count === 1 ? 'list' : 'lists'}`,
    settings: 'Profile settings',
    editProfile: 'Edit profile',
    createProfile: 'Create your public profile',
    privateBadge: 'Private',
    privateNotice: 'Only you can see this profile. Its page does not open for anyone else.',
    privateManage: 'Change this',
    tabsLabel: 'Profile sections',
    tabs: { lists: 'Lists', saved: 'Saved', liked: 'Liked' },
    stats: { following: 'Following', followers: 'Followers', likes: 'Likes' },
    followedContent: 'Followed content',
    openFollowing: 'See followed users',
    openFollowers: 'See followers',
    openLiked: 'Open your liked papers',
    follow: 'Follow',
    unfollow: 'Unfollow',
    followingState: 'Following',
    followFailed: 'That did not go through. Try again.',
    pinnedHeading: 'Lists',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Open ${title}`,
    manageLists: 'Manage in My lists',
    publicBadge: 'Public',
    ownListsNote: 'Unpublished lists are only visible to you.',
    ownListsError: 'Your lists could not be loaded. Open My lists to retry.',
    emptyPinnedTitle: 'No lists yet',
    emptyPinnedHint: 'This profile has not published any reading lists.',
    emptyOwnListsTitle: 'No lists yet',
    emptyOwnListsHint: 'Save a paper to a list and it will show up here.',
    emptySavedTitle: 'Nothing saved yet',
    emptySavedHint: 'Papers you save to read later will show up here.',
    emptyLikedTitle: 'No liked papers yet',
    emptyLikedHint: 'Papers you like will show up here.',
    truncated: count => `Showing the ${count} most recent.`,
    loadingRows: 'Loading...',
    authCta: 'Sign in to build your own',
  } : {
    brand: 'PaperTok',
    publicProfile: 'Perfil público',
    loading: 'Abriendo perfil...',
    notFoundTitle: 'Este perfil no está disponible',
    notFoundBody: 'Puede que el handle haya cambiado o que el enlace esté incompleto.',
    errorTitle: 'No se pudo cargar el perfil',
    errorBody: 'Comprueba tu conexión e inténtalo de nuevo.',
    unsupportedTitle: 'Los perfiles no están disponibles en el modo demo',
    unsupportedBody: 'Abre este enlace en la aplicación completa de PaperTok.',
    retry: 'Reintentar',
    verified: 'Investigador verificado',
    kicker: 'Perfil',
    joined: label => `Miembro desde ${label}`,
    publicLists: count => `${count} ${count === 1 ? 'pública' : 'públicas'}`,
    settings: 'Ajustes del perfil',
    editProfile: 'Editar perfil',
    createProfile: 'Crea tu perfil público',
    privateBadge: 'Privado',
    privateNotice: 'Solo tú ves este perfil. Su página no se abre para nadie más.',
    privateManage: 'Cambiar esto',
    tabsLabel: 'Secciones del perfil',
    tabs: { lists: 'Listas', saved: 'Guardados', liked: 'Me gusta' },
    stats: { following: 'Siguiendo', followers: 'Seguidores', likes: 'Me gusta' },
    followedContent: 'Contenido seguido',
    openFollowing: 'Ver usuarios seguidos',
    openFollowers: 'Ver seguidores',
    openLiked: 'Abrir tus me gusta',
    follow: 'Seguir',
    unfollow: 'Dejar de seguir',
    followingState: 'Siguiendo',
    followFailed: 'No se pudo completar. Inténtalo de nuevo.',
    pinnedHeading: 'Listas',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Abrir ${title}`,
    manageLists: 'Gestionar en Mis listas',
    publicBadge: 'Pública',
    ownListsNote: 'Las listas no publicadas solo las ves tú.',
    ownListsError: 'No se pudieron cargar tus listas. Ábrelas en Mis listas para reintentar.',
    emptyPinnedTitle: 'Sin listas',
    emptyPinnedHint: 'Este perfil todavía no ha publicado ninguna lista de lectura.',
    emptyOwnListsTitle: 'Todavía no hay listas',
    emptyOwnListsHint: 'Guarda un paper en una lista y aparecerá aquí.',
    emptySavedTitle: 'Nada guardado todavía',
    emptySavedHint: 'Los papers que guardes para leer más tarde aparecerán aquí.',
    emptyLikedTitle: 'Todavía no hay me gusta',
    emptyLikedHint: 'Los papers que te gusten aparecerán aquí.',
    truncated: count => `Se muestran los ${count} más recientes.`,
    loadingRows: 'Cargando...',
    authCta: 'Inicia sesión para crear el tuyo',
  };

  const pageClass = `public-profile-page${hasAppChrome ? ' public-profile-page--app' : ''}`;

  if (status !== 'ready') {
    // <Routes> sits inside an AnimatePresence with mode="wait", so the previous
    // page finishes exiting before this one mounts — and only then does the
    // profile read start. The skeleton holds the whole finished layout (header,
    // stats, tab bar, first rows), so nothing jumps when the content lands.
    if (status === 'loading') {
      return (
        <main className={pageClass} aria-busy="true" aria-label={copy.loading}>
          <div className="public-profile-shell">
            <header className="public-profile-header">
              <div className="profile-masthead-top">
                <p className="profile-kicker">{copy.kicker}</p>
              </div>
              <div className="profile-masthead">
                <div className="public-profile-avatar public-profile-skeleton" />
                <div className="public-profile-identity">
                  <div className="public-profile-skeleton public-profile-skeleton--title" />
                  <div className="public-profile-skeleton public-profile-skeleton--line" />
                </div>
                <div className="profile-skeleton-stats">
                  <div className="public-profile-skeleton public-profile-skeleton--stat" />
                  <div className="public-profile-skeleton public-profile-skeleton--stat" />
                  <div className="public-profile-skeleton public-profile-skeleton--stat" />
                </div>
              </div>
            </header>
            <div className="public-profile-skeleton public-profile-skeleton--tabs" />
            <div className="profile-skeleton-rows">
              <div className="public-profile-skeleton public-profile-skeleton--row" />
              <div className="public-profile-skeleton public-profile-skeleton--row" />
              <div className="public-profile-skeleton public-profile-skeleton--row" />
            </div>
          </div>
        </main>
      );
    }

    const state = {
      'not-found': { title: copy.notFoundTitle, body: copy.notFoundBody },
      error: { title: copy.errorTitle, body: copy.errorBody },
      unsupported: { title: copy.unsupportedTitle, body: copy.unsupportedBody },
    }[status];

    return (
      <main className={`${pageClass} public-profile-page--state`}>
        <div className="public-profile-shell">
          <p className="profile-kicker">{copy.brand}</p>
          <h1>{state.title}</h1>
          {state.body && <p className="public-profile-state-body">{state.body}</p>}
          {status === 'error' && (
            <button
              type="button"
              className="public-profile-retry"
              onClick={() => setReloadToken(token => token + 1)}
            >
              <RefreshCw size={16} /> {copy.retry}
            </button>
          )}
        </div>
      </main>
    );
  }

  // Identity: the public document when there is one; on one's own page it may
  // not exist yet, and then the account identity fills in. The email never
  // does — the display-name initial is the only fallback the avatar gets.
  const displayName = profile?.displayName
    || user?.displayName
    || (selfMode ? (user?.email || '').split('@')[0] : '')
    || 'PaperTok';
  const avatar = profile?.photo || (view.isOwner ? (profilePhoto || user?.photoURL || '') : '');
  const followedContentCount = followedEntities?.length ?? 0;
  const likesCount = likedPaperIds?.size ?? 0;

  const joined = joinedLabel(profile?.createdAt, isEnglish);
  const statValue = value => (typeof value === 'number' ? value.toLocaleString() : value);
  // A dangling "0" reads as something broken, and a count that has not been
  // read yet is not zero — both render as no number at all, the same way the
  // followed-content door already withholds its own.
  const tabCount = (tab) => {
    const value = {
      lists: ownLists?.length ?? null,
      saved: libraryReady ? savedRows.length : null,
      liked: likesCount,
    }[tab];
    return typeof value === 'number' && value > 0 ? statValue(value) : null;
  };
  // Held back 320ms in CSS, so an aggregation that answers quickly never flashes
  // a placeholder for a wait that did not happen. The slot keeps its space
  // either way, so nothing jumps when the number lands.
  const pendingCount = <span className="profile-stat-pending" aria-hidden="true">…</span>;
  // Past the aggregation cap the counter says "1000+" rather than a number it
  // did not actually count. See FOLLOW_COUNT_CAP.
  const followCount = (stats) => {
    if (stats.count == null) return '—';
    return stats.capped ? `${statValue(stats.count)}+` : statValue(stats.count);
  };
  const savedTruncated = view.isOwner
    && Object.values(personalLibrary).filter(record => record.readLater).length > PROFILE_TAB_ROW_LIMIT;
  const likedTruncated = likesCount > PROFILE_TAB_ROW_LIMIT;

  // While following, hovering (or focusing) the button is the unfollow
  // affordance — it says so, instead of turning red under an unchanged label.
  const followButtonLabel = following
    ? (followHover && !followBusy ? copy.unfollow : copy.followingState)
    : copy.follow;
  const FollowButtonIcon = following
    ? (followHover && !followBusy ? UserX : UserCheck)
    : UserPlus;

  // What the visitor tab paints (F12): the Worker-written showcase merged
  // with any legacy pinned cards still embedded in an unmigrated profile,
  // pins floated first. One extra read per profile visit, paid above; the
  // session cache is consulted at render time so a remount repaints without
  // waiting on the revalidation.
  const showcaseView = showcase
    ?? (profile?.uid ? showcaseCache.get(profile.uid) ?? null : null);
  const visitorLists = mergeShowcaseCards({
    showcase: showcaseView ?? [],
    legacyPins: profile?.pinnedLists,
    pinnedShareIds: profile?.pinnedShareIds,
  });

  const listCards = (lists, own) => (
    <ul className="public-profile-list-grid">
      {lists.map((list, index) => {
        // `emoji` holds a lucide icon name, not a literal emoji.
        const Icon = getIcon(list.emoji);
        // The owner's colour, resolved the same way the lists page resolves
        // it, so one list is one object wherever it is shown. A showcase card
        // a visitor sees carries no list document, and therefore no colour:
        // the tile falls back to a neutral rule rather than inventing one.
        const accent = own ? resolveListColor(list) : null;
        const inner = (
          <>
            <span className="public-profile-list-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="public-profile-list-title">{list.title}</span>
            <span className="public-profile-list-meta">
              <span className="public-profile-list-count">
                {copy.papers(list.paperCount ?? 0)}
              </span>
              {own && list.isPublished && (
                <span className="profile-badge-public">
                  <Globe2 size={11} aria-hidden="true" /> {copy.publicBadge}
                </span>
              )}
            </span>
          </>
        );
        return (
          <motion.li key={own ? list.id : list.shareId} {...rowMotion(prefersReducedMotion, index)}>
            {own ? (
              <button
                type="button"
                className="public-profile-list-card profile-list-card--own"
                style={accent ? { '--list-accent': accent } : undefined}
                onClick={() => navigate('/lists', { state: { openListId: list.id } })}
                aria-label={copy.open(list.title)}
              >
                {inner}
              </button>
            ) : (
              <Link
                className="public-profile-list-card"
                to={getPublicListPath(list.shareId)}
                aria-label={copy.open(list.title)}
              >
                {inner}
              </Link>
            )}
          </motion.li>
        );
      })}
    </ul>
  );

  const paperRows = rows => (
    <div className="profile-row-list">
      {rows.map((row, index) => (
        <motion.div key={row.id} {...rowMotion(prefersReducedMotion, index)}>
          <PaperRow row={row} isEnglish={isEnglish} libraryReady={libraryReady} />
        </motion.div>
      ))}
    </div>
  );

  const loadingRows = (
    <div className="profile-skeleton-rows" aria-label={copy.loadingRows} aria-busy="true">
      <div className="public-profile-skeleton public-profile-skeleton--row" />
      <div className="public-profile-skeleton public-profile-skeleton--row" />
      <div className="public-profile-skeleton public-profile-skeleton--row" />
    </div>
  );

  return (
    <main className={pageClass}>
      <motion.div
        className="public-profile-shell"
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={prefersReducedMotion
          ? { duration: 0.12 }
          : { duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
      >
        {view.isOwner && profile && !profileIsPublic(profile) && (
          <div className="profile-private-notice">
            <Lock size={14} aria-hidden="true" />
            <span>{copy.privateNotice}</span>
            <button type="button" onClick={() => navigate('/settings/profile')}>
              {copy.privateManage}
            </button>
          </div>
        )}

        <header className="public-profile-header">
          {/* The kicker names the page and the gear closes the row — a utility
              icon behind a hairline, the way rule 6 groups them everywhere
              else. It is part of the masthead's composition, not a float. */}
          <div className="profile-masthead-top">
            <p className="profile-kicker">
              {hasAppChrome ? copy.kicker : `${copy.brand} · ${copy.publicProfile}`}
            </p>
            {view.isOwner && (
              <button
                type="button"
                className="profile-gear"
                // Straight to the screen that edits what this page shows.
                // General settings are the navbar's job (the preferences
                // menu's link); a gear ON the profile that landed on the
                // whole hub made the reader hunt for the profile section
                // (asked for on 2026-08-29).
                onClick={() => navigate('/settings/profile')}
                aria-label={copy.settings}
                title={copy.settings}
              >
                <Settings2 size={18} />
              </button>
            )}
          </div>

          <div className="profile-masthead">
          <div className="public-profile-avatar">
            {avatar
              ? (
                <img
                  src={avatar}
                  alt=""
                  referrerPolicy="no-referrer"
                  // The page's own masthead avatar, visible on load -- not
                  // lazy. `.public-profile-avatar img` renders at 96x96
                  // (56x56 on the narrow layout).
                  decoding="async"
                  width="96"
                  height="96"
                />
              )
              : (
                // The initial comes from the display name, which is public.
                // The app's other avatars fall back to the email initial, and
                // the email must never reach this page.
                <span className="public-profile-avatar-fallback" aria-hidden="true">
                  {displayName.trim().charAt(0).toUpperCase()}
                </span>
              )}
          </div>
          <div className="public-profile-identity">
            <h1>
              {displayName}
              {profile?.verified && (
                <span className="public-profile-verified" title={copy.verified}>
                  <BadgeCheck size={20} aria-label={copy.verified} />
                </span>
              )}
            </h1>
            {profile
              ? (
                <p className="public-profile-handle">
                  <span>@{profile.handle}</span>
                  {joined && <span className="profile-joined">{copy.joined(joined)}</span>}
                  {/* Only the owner ever renders this: for anyone else the
                      document is unreadable, so there is no page to badge. */}
                  {view.isOwner && !profileIsPublic(profile) && (
                    <span className="profile-private-badge">
                      <Lock size={11} aria-hidden="true" /> {copy.privateBadge}
                    </span>
                  )}
                </p>
              )
              : (view.isOwner && (
                <button
                  type="button"
                  className="profile-handle-cta"
                  onClick={() => navigate('/settings/profile')}
                >
                  {copy.createProfile} →
                </button>
              ))}
            {profile?.bio && <p className="public-profile-bio">{profile.bio}</p>}

            <div className="profile-owner-actions">
              {view.isOwner ? (
                <>
                  <button
                    type="button"
                    className="profile-edit-button"
                    onClick={() => navigate('/settings/profile')}
                  >
                    {copy.editProfile}
                  </button>
                  {/* The entities the feed follows (authors, topics,
                      institutions) are a different graph from followed users,
                      and private. They get their own labeled door instead of
                      sharing the word "Following" with the user counter. */}
                  <button
                    type="button"
                    className="profile-content-chip"
                    onClick={() => navigate('/settings/following')}
                  >
                    <Rss size={13} aria-hidden="true" />
                    {copy.followedContent}
                    {/* A dangling "0" reads as something broken; the door works
                        the same without the number until there is one. */}
                    {(followingLoading || followedContentCount > 0) && (
                      <strong>{followingLoading ? '…' : statValue(followedContentCount)}</strong>
                    )}
                  </button>
                </>
              ) : profile && (
                <button
                  type="button"
                  className={`profile-follow-button${following ? ' profile-follow-button--following' : ''}${following && followHover && !followBusy ? ' is-unfollow-intent' : ''}`}
                  onClick={toggleFollow}
                  onMouseEnter={() => setFollowHover(true)}
                  onMouseLeave={() => setFollowHover(false)}
                  onFocus={() => setFollowHover(true)}
                  onBlur={() => setFollowHover(false)}
                  disabled={followBusy}
                  aria-pressed={following}
                >
                  <FollowButtonIcon size={16} />
                  {followButtonLabel}
                </button>
              )}
            </div>
            {followError && <p className="profile-follow-error">{copy.followFailed}</p>}
          </div>

          {/* A count is machine data, so it sits in the ruled grid the
              Explorer's entity header uses rather than in a row of pills. The
              grid takes its column count from its children: three for the
              owner, two for a visitor, who has no Likes counter at all. */}
          <ul className="profile-stats">
            <li>
              <button
                type="button"
                className="profile-stat"
                onClick={() => setFollowSheet('following')}
                disabled={!statsUid}
                title={copy.openFollowing}
              >
                <span className="profile-stat-value">
                  {followedView ? followCount(followedView) : pendingCount}
                </span>
                <span className="profile-stat-label">{copy.stats.following}</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="profile-stat"
                onClick={() => setFollowSheet('followers')}
                disabled={!statsUid}
                title={copy.openFollowers}
              >
                <span className="profile-stat-value">
                  {followersView ? followCount(followersView) : pendingCount}
                </span>
                <span className="profile-stat-label">{copy.stats.followers}</span>
              </button>
            </li>
            {view.isOwner && (
              <li>
                <button
                  type="button"
                  className="profile-stat"
                  onClick={() => setRequestedTab('liked')}
                  title={copy.openLiked}
                >
                  <span className="profile-stat-value">{statValue(likesCount)}</span>
                  <span className="profile-stat-label">{copy.stats.likes}</span>
                </button>
              </li>
            )}
          </ul>
          </div>
        </header>

        {view.isOwner ? (
          <>
            <div className="profile-tabs" role="tablist" aria-label={copy.tabsLabel}>
              {view.tabs.map(tab => {
                const count = tabCount(tab);
                return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`profile-tab-${tab}`}
                  aria-selected={activeTab === tab}
                  aria-controls={`profile-panel-${tab}`}
                  className={`profile-tab${activeTab === tab ? ' is-active' : ''}`}
                  onClick={() => setRequestedTab(tab)}
                >
                  {copy.tabs[tab]}
                  {count && <span className="profile-tab-count">{count}</span>}
                  {activeTab === tab && (
                    <motion.span
                      className="profile-tab-indicator"
                      layoutId="profile-tab-indicator"
                      aria-hidden="true"
                      transition={prefersReducedMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 500, damping: 40 }}
                    />
                  )}
                </button>
                );
              })}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.section
                key={activeTab}
                id={`profile-panel-${activeTab}`}
                role="tabpanel"
                aria-labelledby={`profile-tab-${activeTab}`}
                className="profile-panel"
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
                transition={{ duration: prefersReducedMotion ? 0.08 : 0.16, ease: 'easeOut' }}
              >
                {activeTab === 'lists' && (
                  <>
                    <div className="profile-panel-header">
                      <p className="profile-panel-note">{copy.ownListsNote}</p>
                      <Link className="profile-manage-link" to="/lists">
                        {copy.manageLists}
                        <ArrowRight size={13} aria-hidden="true" />
                      </Link>
                    </div>
                    {ownListsFailed && (
                      <EmptyState
                        Icon={FolderOpen}
                        title={copy.emptyOwnListsTitle}
                        hint={copy.ownListsError}
                      />
                    )}
                    {!ownListsFailed && ownLists === null && loadingRows}
                    {!ownListsFailed && ownLists !== null && (ownLists.length === 0 ? (
                      <EmptyState
                        Icon={FolderOpen}
                        title={copy.emptyOwnListsTitle}
                        hint={copy.emptyOwnListsHint}
                      />
                    ) : listCards(ownLists, true))}
                  </>
                )}

                {activeTab === 'saved' && (!libraryReady ? loadingRows
                  : savedRows.length === 0 ? (
                    <EmptyState
                      Icon={Bookmark}
                      title={copy.emptySavedTitle}
                      hint={copy.emptySavedHint}
                    />
                  ) : (
                    <>
                      {paperRows(savedRows)}
                      {savedTruncated && (
                        <p className="profile-panel-note">{copy.truncated(PROFILE_TAB_ROW_LIMIT)}</p>
                      )}
                    </>
                  ))}

                {activeTab === 'liked' && (likedRows.length === 0 ? (
                  !libraryReady ? loadingRows : (
                    <EmptyState
                      Icon={Heart}
                      title={copy.emptyLikedTitle}
                      hint={copy.emptyLikedHint}
                    />
                  )
                ) : (
                  <>
                    {paperRows(likedRows)}
                    {likedTruncated && (
                      <p className="profile-panel-note">{copy.truncated(PROFILE_TAB_ROW_LIMIT)}</p>
                    )}
                  </>
                ))}
              </motion.section>
            </AnimatePresence>
          </>
        ) : (
          <section aria-label={copy.pinnedHeading}>
            <div className="profile-visitor-lists">
              <h2 className="profile-visitor-heading">{copy.pinnedHeading}</h2>
              {visitorLists.length > 0 && (
                <span className="profile-visitor-count">
                  {copy.publicLists(visitorLists.length)}
                </span>
              )}
            </div>
            {visitorLists.length === 0 ? (
              // The empty state waits for the showcase to answer: claiming
              // "no lists" while the read is in flight would be a guess.
              showcaseView !== null && (
                <EmptyState
                  Icon={FolderOpen}
                  title={copy.emptyPinnedTitle}
                  hint={copy.emptyPinnedHint}
                />
              )
            ) : listCards(visitorLists, false)}
          </section>
        )}

        {!view.isOwner && !user && (
          <footer className="public-profile-footer">
            <button
              type="button"
              className="public-profile-auth-cta"
              onClick={onAuthRequired}
            >
              {copy.authCta}
            </button>
          </footer>
        )}
      </motion.div>

      <AnimatePresence>
        {/* The one-time question for a profile written before this phase. It
            renders here because this page has already read the profile, so
            asking costs no extra read. */}
        {view.isOwner && needsVisibilityChoice(profile) && !promptDismissed && (
          <VisibilityPrompt
            isEnglish={isEnglish}
            onResolved={visibility => setProfile(current => ({ ...current, visibility }))}
            onDismiss={() => setPromptDismissed(true)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {followSheet && statsUid && (
          <FollowSheet
            uid={statsUid}
            mode={followSheet}
            counts={{
              followers: followersView ? followCount(followersView) : null,
              following: followedView ? followCount(followedView) : null,
            }}
            isEnglish={isEnglish}
            onModeChange={setFollowSheet}
            onClose={() => setFollowSheet(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
