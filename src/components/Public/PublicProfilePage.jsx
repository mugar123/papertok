import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  BadgeCheck, Bookmark, FolderOpen, Globe2, Heart, RefreshCw, Rss, Settings2,
  UserCheck, UserPlus, UserX,
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useFeed } from '../../context/FeedContext.jsx';
import { useFollowing } from '../../context/FollowingContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import {
  readOwnLists,
  readOwnUserProfile,
  readUserProfileByHandle,
} from '../../services/userProfileService.js';
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

function PaperRow({ row, fallbackTitle }) {
  // Titles arrive with source dirt (literal <sub> tags, $LaTeX$): HTML is
  // cleaned here at paint time — the stored documents keep the debt visible —
  // and the math is rendered by the same component the feed cards use.
  const title = cleanPaperText(row.title) || fallbackTitle;
  const body = (
    <>
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
        to={row.path}
        state={row.seed ? { paper: row.seed } : undefined}
      >
        {body}
      </Link>
    )
    : <div className="profile-row profile-row--static">{body}</div>;
}

function EmptyState({ Icon, title, hint, action }) {
  return (
    <div className="profile-empty-state">
      <span className="profile-empty-icon" aria-hidden="true"><Icon size={22} /></span>
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
    likedPaperIds, personalLibrary, ensurePersonalLibrary, getCuratedInteractionIds,
  } = useFeed();
  const { followedEntities, loading: followingLoading } = useFollowing();

  const [profile, setProfile] = useState(null);
  const [status, setStatus] = useState('loading');
  const [reloadToken, setReloadToken] = useState(0);
  const [requestedTab, setRequestedTab] = useState('lists');
  const [ownLists, setOwnLists] = useState(null);
  const [ownListsFailed, setOwnListsFailed] = useState(false);
  const [libraryReady, setLibraryReady] = useState(false);
  const [likedExtra, setLikedExtra] = useState({});
  const requestedLikedIds = useRef(new Set());
  // Follows (F2). `null` means "not asked yet", which is what keeps the header
  // from flashing a zero before the real number lands.
  const [followerStats, setFollowerStats] = useState(null);
  const [followedStats, setFollowedStats] = useState(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followError, setFollowError] = useState(false);
  const [followHover, setFollowHover] = useState(false);
  const [followSheet, setFollowSheet] = useState(null);

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
        if (!active) return;
        setProfile(result);
        // Having no public profile yet is a normal state of one's own page,
        // not a missing page.
        setStatus(result || selfMode ? 'ready' : 'not-found');
      })
      .catch(error => {
        console.error('Error loading public profile:', error);
        if (!active) return;
        setStatus(error?.code === 'USER_PROFILES_UNSUPPORTED_IN_DEMO' ? 'unsupported' : 'error');
      });
    return () => { active = false; };
  }, [handle, selfMode, reloadToken]);

  // Owner data. Each effect is gated on `view.isOwner`, which is the privacy
  // boundary: a visitor's render never even asks for these.
  useEffect(() => {
    if (!view.isOwner || status !== 'ready' || IS_DEMO) return undefined;
    let active = true;
    readOwnLists()
      .then(lists => {
        if (!active) return;
        setOwnLists(lists);
        setOwnListsFailed(false);
      })
      .catch(error => {
        console.error('Error loading own lists:', error);
        if (!active) return;
        setOwnLists([]);
        setOwnListsFailed(true);
      });
    return () => { active = false; };
  }, [view.isOwner, status, reloadToken]);

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
   */
  const statsUid = profile?.uid || (selfMode ? user?.uid || '' : '');
  useEffect(() => {
    if (!statsUid || IS_DEMO) return undefined;
    let active = true;
    Promise.all([
      countFollowers(statsUid),
      countFollowedUsers(statsUid),
      view.isOwner ? Promise.resolve(false) : readIsFollowing(statsUid),
    ])
      .then(([followers, followed, viewerFollows]) => {
        if (!active) return;
        setFollowerStats(followers);
        setFollowedStats(followed);
        setFollowing(viewerFollows);
      })
      .catch(error => {
        // Rules not deployed yet, offline, or a genuine denial: the header must
        // say "unknown", not sit on a spinner forever or claim zero followers.
        console.error('Error loading follow counters:', error);
        if (!active) return;
        setFollowerStats({ count: null, capped: false });
        setFollowedStats({ count: null, capped: false });
      });
    return () => { active = false; };
  }, [statsUid, user?.uid, view.isOwner, reloadToken]);

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
    setFollowerStats(current => (current
      ? { ...current, count: Math.max(0, current.count + (wasFollowing ? -1 : 1)) }
      : current));
    try {
      const result = wasFollowing
        ? await unfollowUser(statsUid)
        : await followUser(statsUid);
      // `changed: false` means the edge was already in the requested state, so
      // the optimistic ±1 counted something that had already been counted.
      if (!result.changed) {
        setFollowerStats(await countFollowers(statsUid));
      }
    } catch (error) {
      console.error('Error updating follow:', error);
      setFollowing(wasFollowing);
      setFollowerStats(current => (current
        ? { ...current, count: Math.max(0, current.count + (wasFollowing ? 1 : -1)) }
        : current));
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
    const missing = likedOrder.filter(id => (
      !personalLibrary[id]?.paper && !likedExtra[id] && !requestedLikedIds.current.has(id)
    ));
    if (missing.length === 0) return undefined;
    missing.forEach(id => requestedLikedIds.current.add(id));
    // `requestedLikedIds` never forgets an id, so a response has to land in
    // state no matter what tab is active by then — a cancel-on-cleanup here
    // turns "switched tabs during the fetch" into rows that stay untitled for
    // the life of the page, with no retry. `likedExtra` is a cache keyed by
    // id, so a late merge is idempotent and unmount makes setState a no-op.
    fetchLibraryRecords(user.uid, missing)
      .then(records => {
        if (records.length === 0) return;
        setLikedExtra(current => {
          const next = { ...current };
          records.forEach(({ id, data }) => { next[id] = data; });
          return next;
        });
      })
      .catch(error => {
        // A failed batch must become retryable, or a transient error leaves
        // the same permanent blanks the cancel did.
        missing.forEach(id => requestedLikedIds.current.delete(id));
        console.error('Error loading liked paper titles:', error);
      });
    return undefined;
  }, [view.isOwner, activeTab, likedOrder, personalLibrary, likedExtra, user?.uid]);

  const likedRows = useMemo(() => likedOrder.map(id => {
    const library = personalLibrary[id]?.paper;
    const extra = likedExtra[id];
    const paper = library || extra?.paper;
    const title = paper?.title || extra?.paperTitle || '';
    const authors = paper?.authors || extra?.paperAuthors || [];
    return {
      id,
      title,
      subtitle: authorLine(authors),
      path: paper ? getPublicPaperPath(paper) || getPublicPaperPath(id) : getPublicPaperPath(id),
      seed: seedPaperFor(id, paper, title, authors, extra?.paperCategory),
    };
  }), [likedOrder, personalLibrary, likedExtra]);

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
    settings: 'Settings',
    editProfile: 'Edit profile',
    createProfile: 'Create your public profile',
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
    pinnedHeading: 'Pinned lists',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Open ${title}`,
    manageLists: 'Manage in My lists',
    publicBadge: 'Public',
    ownListsNote: 'Unpublished lists are only visible to you.',
    ownListsError: 'Your lists could not be loaded. Open My lists to retry.',
    emptyPinnedTitle: 'No pinned lists yet',
    emptyPinnedHint: 'This profile has not pinned any reading lists.',
    emptyOwnListsTitle: 'No lists yet',
    emptyOwnListsHint: 'Save a paper to a list and it will show up here.',
    emptySavedTitle: 'Nothing saved yet',
    emptySavedHint: 'Papers you save to read later will show up here.',
    emptyLikedTitle: 'No liked papers yet',
    emptyLikedHint: 'Papers you like will show up here.',
    truncated: count => `Showing the ${count} most recent.`,
    loadingRows: 'Loading...',
    untitled: 'Untitled paper',
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
    settings: 'Ajustes',
    editProfile: 'Editar perfil',
    createProfile: 'Crea tu perfil público',
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
    pinnedHeading: 'Listas fijadas',
    papers: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    open: title => `Abrir ${title}`,
    manageLists: 'Gestionar en Mis listas',
    publicBadge: 'Pública',
    ownListsNote: 'Las listas no publicadas solo las ves tú.',
    ownListsError: 'No se pudieron cargar tus listas. Ábrelas en Mis listas para reintentar.',
    emptyPinnedTitle: 'Sin listas fijadas',
    emptyPinnedHint: 'Este perfil todavía no ha fijado ninguna lista de lectura.',
    emptyOwnListsTitle: 'Todavía no hay listas',
    emptyOwnListsHint: 'Guarda un paper en una lista y aparecerá aquí.',
    emptySavedTitle: 'Nada guardado todavía',
    emptySavedHint: 'Los papers que guardes para leer más tarde aparecerán aquí.',
    emptyLikedTitle: 'Todavía no hay me gusta',
    emptyLikedHint: 'Los papers que te gusten aparecerán aquí.',
    truncated: count => `Se muestran los ${count} más recientes.`,
    loadingRows: 'Cargando...',
    untitled: 'Paper sin título',
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
            {!hasAppChrome && <p className="public-profile-brand">{copy.brand} · {copy.publicProfile}</p>}
            <header className="public-profile-header">
              <div className="public-profile-avatar public-profile-skeleton" />
              <div className="public-profile-identity">
                <div className="public-profile-skeleton public-profile-skeleton--title" />
                <div className="public-profile-skeleton public-profile-skeleton--line" />
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
          <p className="public-profile-brand">{copy.brand}</p>
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

  const statValue = value => (typeof value === 'number' ? value.toLocaleString() : value);
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

  const pinnedLists = profile?.pinnedLists || [];

  const listCards = (lists, own) => (
    <ul className="public-profile-list-grid">
      {lists.map((list, index) => {
        // `emoji` holds a lucide icon name, not a literal emoji.
        const Icon = getIcon(list.emoji);
        const inner = (
          <>
            <span className="public-profile-list-emoji" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span className="public-profile-list-copy">
              <span className="public-profile-list-title">{list.title}</span>
              <span className="public-profile-list-count">
                {copy.papers(list.paperCount ?? 0)}
              </span>
            </span>
            {own && list.isPublished && (
              <span className="profile-badge-public">
                <Globe2 size={12} aria-hidden="true" /> {copy.publicBadge}
              </span>
            )}
          </>
        );
        return (
          <motion.li key={own ? list.id : list.shareId} {...rowMotion(prefersReducedMotion, index)}>
            {own ? (
              <button
                type="button"
                className="public-profile-list-card profile-list-card--own"
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
          <PaperRow row={row} fallbackTitle={copy.untitled} />
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
        {!hasAppChrome && <p className="public-profile-brand">{copy.brand} · {copy.publicProfile}</p>}

        {view.isOwner && (
          <button
            type="button"
            className="profile-gear"
            onClick={() => navigate('/settings')}
            aria-label={copy.settings}
            title={copy.settings}
          >
            <Settings2 size={20} />
          </button>
        )}

        <header className="public-profile-header">
          <div className="public-profile-avatar">
            {avatar
              ? <img src={avatar} alt="" referrerPolicy="no-referrer" />
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
              ? <p className="public-profile-handle">@{profile.handle}</p>
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

            <ul className="profile-stats">
              <li>
                <button
                  type="button"
                  className="profile-stat"
                  onClick={() => setFollowSheet('following')}
                  disabled={!statsUid}
                  title={copy.openFollowing}
                >
                  <strong>{followedStats ? followCount(followedStats) : '…'}</strong>
                  <span>{copy.stats.following}</span>
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
                  <strong>{followerStats ? followCount(followerStats) : '…'}</strong>
                  <span>{copy.stats.followers}</span>
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
                    <strong>{statValue(likesCount)}</strong>
                    <span>{copy.stats.likes}</span>
                  </button>
                </li>
              )}
            </ul>

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
                    <strong>{followingLoading ? '…' : statValue(followedContentCount)}</strong>
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
        </header>

        {view.isOwner ? (
          <>
            <div className="profile-tabs" role="tablist" aria-label={copy.tabsLabel}>
              {view.tabs.map(tab => (
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
              ))}
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
                      <Link className="profile-manage-link" to="/lists">{copy.manageLists}</Link>
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
          <section className="profile-visitor-lists" aria-label={copy.pinnedHeading}>
            <h2 className="profile-visitor-heading">{copy.pinnedHeading}</h2>
            {pinnedLists.length === 0 ? (
              <EmptyState
                Icon={FolderOpen}
                title={copy.emptyPinnedTitle}
                hint={copy.emptyPinnedHint}
              />
            ) : listCards(pinnedLists, false)}
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
        {followSheet && statsUid && (
          <FollowSheet
            uid={statsUid}
            mode={followSheet}
            counts={{
              followers: followerStats ? followCount(followerStats) : null,
              following: followedStats ? followCount(followedStats) : null,
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
