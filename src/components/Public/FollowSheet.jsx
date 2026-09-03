import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { UsersRound, X } from 'lucide-react';
import {
  FOLLOW_PAGE_SIZE,
  readFollowedUsersPage,
  readFollowersPage,
} from '../../services/followUserService.js';
import { readUserProfile } from '../../services/userProfileService.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { isReadTimeout, patientRead } from '../../utils/boundedRead.js';
import {
  followRowProfileCache,
  readFollowList,
  rememberFollowList,
} from '../../utils/profileSessionCaches.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import './FollowSheet.css';

/**
 * The follower / following lists of one profile.
 *
 * Paged, never bulk: one `limit(30)` query per press, with the cursor of the
 * last row. `firestore.rules` refuses any query on `follows` without a ceiling,
 * so an unbounded read here is not a discipline, it is impossible.
 *
 * The edges hold uids and nothing else — deliberately. Denormalizing a name or
 * a handle into the edge would let a follower write display text that renders
 * on somebody else's profile, which is an impersonation surface for the sake of
 * saving reads. So each row resolves its own public profile, at most one read
 * per row on screen, cached for the whole tab session so switching tabs, paging
 * back, closing the sheet and opening it again never ask twice.
 *
 * Both tabs count *users*, and so do both header counters now — the entities
 * the feed follows live behind their own "Followed content" chip — so the tab
 * can simply say "Following" again without colliding with anything.
 *
 * Two rules keep the wait from being felt twice over. **The list paints as soon
 * as the edges land**, with the names filling in behind: they are two waves, and
 * holding the finished page back until the second one finished meant the sheet
 * showed a skeleton for a round trip it had already made. And **a tab that has
 * rows keeps them** — in state while the sheet is open, in the session cache
 * once it closes — so going followers ⇄ following ⇄ followers repaints instead
 * of starting over. Both are the pattern the rest of the profile already uses.
 */

const MODES = Object.freeze({
  followers: { read: readFollowersPage },
  following: { read: readFollowedUsersPage },
});

const MODE_NAMES = Object.freeze(['followers', 'following']);

/** How many rows a counter promises. `'1000+'` parses as 1000; `'—'` as nothing. */
function numericCount(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function initialOf(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

/**
 * `undefined` is a row whose account has not been read yet; `null` is one that
 * was read and is gone. The distinction is the whole point of painting early —
 * without it every row would announce a missing account for the moment between
 * the edge landing and its profile landing.
 */
function Row({ uid, profile, unavailableLabel, onNavigate }) {
  if (profile === undefined) {
    return (
      <span className="follow-row-link follow-row-link--pending" aria-hidden="true">
        <span className="follow-avatar follow-row-pending-block" />
        <span className="follow-row-body">
          <span className="follow-row-pending-line" />
          <span className="follow-row-pending-line follow-row-pending-line--short" />
        </span>
      </span>
    );
  }

  if (!profile) {
    return (
      <>
        <span className="follow-avatar" aria-hidden="true">?</span>
        <span className="follow-row-body">
          <span className="follow-row-name">{unavailableLabel}</span>
        </span>
      </>
    );
  }

  return (
    <>
      <Link
        className="follow-row-link"
        to={getPublicProfilePath(profile.handle)}
        onClick={onNavigate}
      >
        <span className="follow-avatar">
          {profile.photo
            ? (
              <img
                src={profile.photo}
                alt=""
                referrerPolicy="no-referrer"
                // One row in a scrollable follow/followers list -- most rows
                // start off screen, so this is the one avatar in the batch
                // that is genuinely worth deferring. `.follow-avatar img`
                // renders at 36x36.
                loading="lazy"
                decoding="async"
                width="36"
                height="36"
              />
            )
            : <span aria-hidden="true">{initialOf(profile.displayName)}</span>}
        </span>
        <span className="follow-row-body">
          <span className="follow-row-name">{profile.displayName}</span>
          <span className="follow-row-handle">@{profile.handle}</span>
        </span>
      </Link>
      <span className="follow-row-key" hidden>{uid}</span>
    </>
  );
}

/**
 * States where the page is still on its way. 'slow' and 'offline' keep the
 * skeleton and the read behind it: only 'error' is the sheet giving up.
 */
const FOLLOW_WAITING = ['loading', 'slow', 'offline'];

const EMPTY_PAGE = Object.freeze({
  rows: [], cursor: null, hasMore: false, status: 'loading',
});

/** Rows carry uids; the names come from whatever the profile cache already holds. */
function hydrate(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({ uid: row.uid, profile: followRowProfileCache.get(row.uid) }));
}

/** Whatever this tab session already knows about either tab of this profile. */
function seedPages(uid) {
  const seeded = {};
  MODE_NAMES.forEach(name => {
    const cached = readFollowList(uid, name);
    if (cached) seeded[name] = { ...cached, rows: hydrate(cached.rows), status: 'ready' };
  });
  return seeded;
}

/**
 * Drops one resolved account into every row that is waiting for it, in both
 * tabs — mutuals appear on each, and a name read once should never be read or
 * awaited twice.
 */
function withProfile(pages, rowUid, profile) {
  let changed = false;
  const next = {};
  Object.entries(pages).forEach(([name, page]) => {
    if (page.rows.some(row => row.uid === rowUid && row.profile !== profile)) {
      changed = true;
      next[name] = {
        ...page,
        rows: page.rows.map(row => (row.uid === rowUid ? { ...row, profile } : row)),
      };
    } else {
      next[name] = page;
    }
  });
  return changed ? next : pages;
}

export default function FollowSheet({
  uid,
  mode,
  counts,
  isEnglish,
  onModeChange,
  onClose,
}) {
  const prefersReducedMotion = useReducedMotion();
  // One entry per tab, kept while the sheet is open and handed to the session
  // cache when it closes. Switching tabs then needs no reset and no reload: the
  // other tab's page is simply still there.
  const [pages, setPages] = useState(() => seedPages(uid));
  const [attempt, setAttempt] = useState(0);
  const [paging, setPaging] = useState(false);
  // The sheet only exists in the tree while it is shown, so `open` is always
  // true here — the same contract AuthPrompt uses.
  const dialogRef = useDialogFocus(true, onClose);
  const current = pages[mode] || EMPTY_PAGE;
  // Decided once per open: this drives which entrance the sheet plays (slide
  // from the bottom edge it is anchored to on phones, a scale-fade when it
  // floats centered on desktop), not the layout, which is pure CSS.
  const slidesFromBottom = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 599px)').matches,
    [],
  );

  // The body height tracks THIS tab's count, not the larger of the two — the
  // old rule is what left 440px of void under a single follower. Switching
  // tabs therefore changes the height, which is fine now for two reasons: the
  // sheet is anchored (top on desktop, bottom on phones) so it grows in one
  // direction instead of re-centering, and the height is a calculated length,
  // so CSS transitions it with the house spring instead of snapping.
  //
  // Once the page has landed the rows on screen are the truth; before that the
  // counter is the best promise there is, and it is the same number the
  // skeleton draws, so the box does not resettle when the real rows replace the
  // bars. Capped at 8, past which the list scrolls; a list with nothing in it —
  // and the two states that gave up — get three rows of box to put a band in.
  const expectedRows = useMemo(() => {
    if (current.status === 'error' || current.status === 'stalled') return 3;
    const rows = current.status === 'ready'
      ? current.rows.length
      : numericCount(counts?.[mode]);
    if (rows == null) return null;
    return rows === 0 ? 3 : Math.min(8, Math.max(1, rows));
  }, [counts, mode, current.status, current.rows.length]);

  // The skeleton, on the other hand, promises exactly what THIS tab says it
  // holds. Three bars for one follower was the shape of the wait disagreeing
  // with the shape of the answer, and the box visibly settling afterwards.
  const skeletonRows = useMemo(() => {
    const known = numericCount(counts?.[mode]);
    return known == null ? 3 : Math.min(8, Math.max(0, known));
  }, [counts, mode]);

  const copy = isEnglish ? {
    followers: 'Followers',
    following: 'Following',
    close: 'Close',
    emptyTitle: mode === 'followers' ? 'No followers yet' : 'Not following anyone yet',
    emptyHint: mode === 'followers'
      ? 'When someone follows this account, they will show up here.'
      : 'Users this account follows will show up here.',
    more: 'Load more',
    loading: 'Loading...',
    slow: 'This is taking longer than usual. Still trying.',
    offline: 'There seems to be no connection. Still trying.',
    stalled: 'This is taking unusually long. We are still trying in the background.',
    error: 'This list could not be loaded.',
    retry: 'Try again',
    unavailable: 'Account unavailable',
    showing: 'Showing',
    of: 'of',
  } : {
    followers: 'Seguidores',
    following: 'Siguiendo',
    close: 'Cerrar',
    emptyTitle: mode === 'followers' ? 'Sin seguidores todavía' : 'Sin usuarios seguidos todavía',
    emptyHint: mode === 'followers'
      ? 'Cuando alguien siga esta cuenta, aparecerá aquí.'
      : 'Aquí aparecerán los usuarios que siga esta cuenta.',
    more: 'Cargar más',
    loading: 'Cargando...',
    slow: 'Está tardando más de lo normal. Seguimos intentándolo.',
    offline: 'Parece que no hay conexión. Seguimos intentándolo.',
    stalled: 'Está tardando muchísimo. Seguimos intentándolo por detrás.',
    error: 'No se pudo cargar esta lista.',
    retry: 'Reintentar',
    unavailable: 'Cuenta no disponible',
    showing: 'Mostrando',
    of: 'de',
  };

  /**
   * Wave one: one bounded page of edges, and nothing else. The rows come back
   * carrying whatever the profile cache already has for them, which after the
   * first tab is usually everything.
   */
  const readEdges = useCallback(async (cursor) => {
    const read = MODES[mode]?.read;
    if (!read || !uid) return { rows: [], cursor: null, hasMore: false };
    const result = await read(uid, { cursor, pageSize: FOLLOW_PAGE_SIZE });
    return { rows: hydrate(result.edges), cursor: result.cursor, hasMore: result.hasMore };
  }, [mode, uid]);

  /**
   * Wave two: the account behind each row that has none yet, each one landing
   * on its own. Not a `Promise.all` — one slow profile used to hold up every
   * other name on screen, and there is nothing the reader gains by waiting for
   * the row they were not looking at.
   */
  const resolveRows = useCallback((rows, isActive) => {
    rows.filter(row => row.profile === undefined).forEach(row => {
      readUserProfile(row.uid)
        .catch(() => null)
        .then(profile => {
          const settled = profile ?? null;
          followRowProfileCache.set(row.uid, settled);
          if (isActive()) setPages(previous => withProfile(previous, row.uid, settled));
        });
    });
  }, []);

  useEffect(() => {
    let active = true;
    // The retry loop outlives the promise; closing the sheet must end it.
    const controller = new AbortController();
    const isActive = () => active;

    const apply = (result) => {
      if (!active) return;
      const page = { ...result, status: 'ready' };
      rememberFollowList(uid, mode, page);
      setPages(previous => ({ ...previous, [mode]: page }));
      resolveRows(result.rows, isActive);
    };

    // One attempt is now just the edge query: bounded, and the only part of
    // this that can stall with nothing to show. Unbounded, a stalled read left
    // this sheet on "Loading..." for as long as it stayed open, with no way out
    // — the same shape as the comment sheet, which is why it takes the same
    // helper. The error state below already has a Try again, so a timeout lands
    // somewhere the reader can act on.
    patientRead(() => readEdges(null), {
      attempts: 3,
      label: 'follow list',
      signal: controller.signal,
      onSlow: (attemptNumber, info) => {
        // A tab already showing rows keeps them: a slow revalidation is not a
        // reason to take the list back off the screen.
        if (!active) return;
        setPages(previous => (previous[mode]?.status === 'ready' ? previous : {
          ...previous,
          [mode]: { ...EMPTY_PAGE, status: info?.offline ? 'offline' : 'slow' },
        }));
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        // A mute connection answers as a rejection ten seconds later. That is
        // still a wait, and the retry behind it is still running — but past
        // the budget it has to say so rather than hold the skeleton forever.
        // Unless the tab is already painted, in which case it says nothing and
        // leaves the rows where they are.
        const failed = isReadTimeout(error) ? 'stalled' : 'error';
        if (failed === 'stalled') console.warn('The follow list did not answer in time', error);
        else console.error('Error loading the follow list:', error);
        if (!active) return;
        setPages(previous => (previous[mode]?.status === 'ready' ? previous : {
          ...previous,
          [mode]: { ...EMPTY_PAGE, status: failed },
        }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [readEdges, resolveRows, uid, mode, attempt]);

  const loadMore = async () => {
    if (paging || !current.cursor) return;
    setPaging(true);
    try {
      const result = await readEdges(current.cursor);
      const page = {
        rows: [...current.rows, ...result.rows],
        cursor: result.cursor,
        hasMore: result.hasMore,
        status: 'ready',
      };
      rememberFollowList(uid, mode, page);
      setPages(previous => ({ ...previous, [mode]: page }));
      resolveRows(result.rows, () => true);
    } catch (error) {
      console.error('Error paging the follow list:', error);
    } finally {
      setPaging(false);
    }
  };

  const sheetMotion = prefersReducedMotion ? {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: 0.1 },
  } : slidesFromBottom ? {
    initial: { y: '100%' },
    animate: { y: 0 },
    exit: { y: '100%' },
    transition: { type: 'spring', damping: 32, stiffness: 340 },
  } : {
    initial: { opacity: 0, scale: 0.96, y: 12 },
    animate: { opacity: 1, scale: 1, y: 0 },
    exit: { opacity: 0, scale: 0.97, y: 8 },
    transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] },
  };

  return (
    <motion.div
      className="follow-sheet-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: prefersReducedMotion ? 0.1 : 0.18 }}
      onClick={onClose}
    >
      <motion.div
        ref={dialogRef}
        className="follow-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'followers' ? copy.followers : copy.following}
        tabIndex={-1}
        {...sheetMotion}
        style={expectedRows != null ? { '--follow-rows': expectedRows } : undefined}
        onClick={event => event.stopPropagation()}
      >
        <header className="follow-sheet-header">
          <div className="follow-sheet-tabs" role="tablist">
            {MODE_NAMES.map(name => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={mode === name}
                className={`follow-sheet-tab${mode === name ? ' follow-sheet-tab--active' : ''}`}
                onClick={() => onModeChange(name)}
              >
                {copy[name]}
                {counts?.[name] != null && (
                  <span className="follow-sheet-tab-count">{counts[name]}</span>
                )}
                {/* The shared layoutId is the whole point: the yellow rule
                    slides from one tab to the other instead of blinking off
                    here and on over there — the same gesture the profile's own
                    tabs make, so the two rows of tabs move alike. */}
                {mode === name && (
                  <motion.span
                    className="follow-sheet-tab-indicator"
                    layoutId="follow-sheet-tab-indicator"
                    transition={prefersReducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 520, damping: 42 }}
                  />
                )}
              </button>
            ))}
          </div>
          <div className="follow-sheet-close-wrap">
            <button
              type="button"
              className="follow-sheet-close"
              data-dialog-initial-focus
              onClick={onClose}
              aria-label={copy.close}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {/* Only once the list is genuinely paged: with three followers this
            would repeat the number already sitting in the tab. */}
        {current.status === 'ready' && current.hasMore && (
          <p className="follow-sheet-meta">
            {`${copy.showing} ${current.rows.length} ${copy.of} ${counts?.[mode] ?? '—'}`}
          </p>
        )}

        <div className="follow-sheet-body">
          {/* One panel per tab. Deliberately NOT an AnimatePresence crossfade:
              a `mode="wait"` swap makes every tab change wait on an exit
              animation before the next tab exists, and the motion it would buy
              is already there — the rows stagger in on their own, under a box
              whose height is easing at the same time. */}
          <div className="follow-sheet-panel">
              {FOLLOW_WAITING.includes(current.status) && (
                <div className="follow-sheet-loading" aria-label={copy.loading} aria-busy="true">
                  {Array.from({ length: skeletonRows }, (unused, index) => (
                    <div key={index} className="follow-row-skeleton">
                      <span className="follow-avatar follow-row-pending-block" />
                      <span className="follow-row-body">
                        <span className="follow-row-pending-line" />
                        <span className="follow-row-pending-line follow-row-pending-line--short" />
                      </span>
                    </div>
                  ))}
                  {current.status !== 'loading' && (
                    <p className="follow-sheet-loading-note" role="status">
                      {current.status === 'offline' ? copy.offline : copy.slow}
                    </p>
                  )}
                </div>
              )}
              {(current.status === 'error' || current.status === 'stalled') && (
                // 'stalled' still has a read running behind it; 'error' does not.
                <div className="follow-sheet-state" aria-busy={current.status === 'stalled'}>
                  <p>{current.status === 'stalled' ? copy.stalled : copy.error}</p>
                  <button
                    type="button"
                    className="follow-sheet-retry"
                    onClick={() => setAttempt(value => value + 1)}
                  >
                    {copy.retry}
                  </button>
                </div>
              )}
              {current.status === 'ready' && current.rows.length === 0 && (
                <div className="follow-sheet-state">
                  <span className="follow-sheet-state-icon" aria-hidden="true">
                    <UsersRound size={18} />
                  </span>
                  <p className="follow-sheet-state-title">{copy.emptyTitle}</p>
                  <p>{copy.emptyHint}</p>
                </div>
              )}
              {current.rows.length > 0 && (
                <ul className="follow-list">
                  {current.rows.map((row, index) => (
                    <motion.li
                      key={row.uid}
                      className={`follow-row${row.profile === null ? ' follow-row--gone' : ''}`}
                      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      animate={{
                        opacity: 1,
                        y: 0,
                        transition: {
                          delay: prefersReducedMotion ? 0 : Math.min(index * 0.02, 0.16),
                          duration: prefersReducedMotion ? 0.08 : 0.18,
                          ease: 'easeOut',
                        },
                      }}
                    >
                      <Row
                        uid={row.uid}
                        profile={row.profile}
                        unavailableLabel={copy.unavailable}
                        onNavigate={onClose}
                      />
                    </motion.li>
                  ))}
                </ul>
              )}
          </div>
        </div>

        {/* Outside the body on purpose: inside it, the button scrolled away
            exactly when it was needed. */}
        {current.hasMore && (
          <button
            type="button"
            className="follow-sheet-more"
            onClick={loadMore}
            disabled={paging}
          >
            {paging ? copy.loading : copy.more}
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}
