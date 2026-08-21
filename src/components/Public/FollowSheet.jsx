import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { UsersRound, X } from 'lucide-react';
import {
  FOLLOW_PAGE_SIZE,
  readFollowedUsersPage,
  readFollowersPage,
} from '../../services/followUserService.js';
import { readUserProfile } from '../../services/userProfileService.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { isTransientReadError, patientRead } from '../../utils/boundedRead.js';
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
 * per row on screen, cached for the life of the sheet so switching tabs and
 * paging back never asks twice.
 *
 * Both tabs count *users*, and so do both header counters now — the entities
 * the feed follows live behind their own "Followed content" chip — so the tab
 * can simply say "Following" again without colliding with anything.
 */

const MODES = Object.freeze({
  followers: { read: readFollowersPage },
  following: { read: readFollowedUsersPage },
});

function initialOf(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function Row({ uid, profile, unavailableLabel, onNavigate }) {
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
            ? <img src={profile.photo} alt="" referrerPolicy="no-referrer" />
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
  mode: null, rows: [], cursor: null, hasMore: false, status: 'loading',
});

export default function FollowSheet({
  uid,
  mode,
  counts,
  isEnglish,
  onModeChange,
  onClose,
}) {
  const prefersReducedMotion = useReducedMotion();
  // One state object stamped with the tab it belongs to. Switching tabs then
  // needs no reset: a page from the other tab simply is not this tab's page,
  // and the loader shows until its own first page lands.
  const [page, setPage] = useState(EMPTY_PAGE);
  const [attempt, setAttempt] = useState(0);
  const [paging, setPaging] = useState(false);
  // One entry per uid, for the life of the sheet: the two tabs overlap often
  // (mutuals) and paging must not re-read a profile already on screen.
  const profileCache = useRef(new Map());
  const sheet = useRef(null);
  const closeButton = useRef(null);
  const current = page.mode === mode ? page : EMPTY_PAGE;
  // Decided once per open: this drives which entrance the sheet plays (slide
  // from the bottom edge it is anchored to on phones, a scale-fade when it
  // floats centered on desktop), not the layout, which is pure CSS.
  const slidesFromBottom = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 599px)').matches,
    [],
  );

  // The body height tracks the LARGER of the two counts (both are known when
  // the sheet opens), so switching tabs still never resizes the dialog — the
  // rule the old fixed height existed for — while a two-row list no longer
  // floats in a full-height void. Capped at 8 rows: past that the list
  // scrolls. "1000+" parses as 1000 and lands on the cap.
  const expectedRows = useMemo(() => {
    const numeric = (value) => {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const known = [numeric(counts?.followers), numeric(counts?.following)]
      .filter(value => value != null);
    if (known.length === 0) return null;
    return Math.min(8, Math.max(3, Math.max(...known)));
  }, [counts]);

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
    error: 'This list could not be loaded.',
    retry: 'Try again',
    unavailable: 'Account unavailable',
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
    error: 'No se pudo cargar esta lista.',
    retry: 'Reintentar',
    unavailable: 'Cuenta no disponible',
  };

  /**
   * One bounded page, plus the public profile behind each row on it.
   *
   * The edges hold uids and nothing else, so a row's name and handle come from
   * `userProfiles/{uid}` — at most one read per row on screen, memoised for the
   * life of the sheet.
   */
  const readPage = useCallback(async (cursor) => {
    const read = MODES[mode]?.read;
    if (!read || !uid) return { rows: [], cursor: null, hasMore: false };
    const result = await read(uid, { cursor, pageSize: FOLLOW_PAGE_SIZE });
    const rows = await Promise.all(result.edges.map(async (edge) => {
      if (!profileCache.current.has(edge.uid)) {
        profileCache.current.set(edge.uid, await readUserProfile(edge.uid).catch(() => null));
      }
      return { uid: edge.uid, profile: profileCache.current.get(edge.uid) };
    }));
    return { rows, cursor: result.cursor, hasMore: result.hasMore };
  }, [mode, uid]);

  useEffect(() => {
    let active = true;
    // The retry loop outlives the promise; closing the sheet must end it.
    const controller = new AbortController();

    const apply = (result) => {
      if (active) setPage({ mode, ...result, status: 'ready' });
    };

    // One attempt is the whole first page: the bounded edge query plus the
    // profile behind each row. Unbounded, a stalled read left this sheet on
    // "Loading..." for as long as it stayed open, with no way out — the same
    // shape as the comment sheet, which is why it takes the same helper. The
    // error state below already has a Try again, so a timeout lands somewhere
    // the reader can act on.
    patientRead(() => readPage(null), {
      attempts: 2,
      label: 'follow list',
      signal: controller.signal,
      onSlow: (attemptNumber, info) => {
        if (active) setPage({ ...EMPTY_PAGE, mode, status: info?.offline ? 'offline' : 'slow' });
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        // A mute connection answers as a rejection ten seconds later. That is
        // still a wait, and the retry behind it is still running.
        if (isTransientReadError(error)) {
          console.warn('The follow list did not answer in time', error);
          return;
        }
        console.error('Error loading the follow list:', error);
        if (active) setPage({ ...EMPTY_PAGE, mode, status: 'error' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [readPage, mode, attempt]);

  const loadMore = async () => {
    if (paging || !current.cursor) return;
    setPaging(true);
    try {
      const result = await readPage(current.cursor);
      setPage(previous => (previous.mode === mode
        ? { ...previous, rows: [...previous.rows, ...result.rows], cursor: result.cursor, hasMore: result.hasMore }
        : previous));
    } catch (error) {
      console.error('Error paging the follow list:', error);
    } finally {
      setPaging(false);
    }
  };

  // A modal dialog owns the keyboard while it is open: Escape closes, and Tab
  // cycles inside the sheet instead of wandering into the blurred page behind.
  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !sheet.current) return;
      const focusable = [...sheet.current.querySelectorAll(
        'button:not(:disabled), a[href]',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
        ref={sheet}
        className="follow-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'followers' ? copy.followers : copy.following}
        {...sheetMotion}
        style={expectedRows != null ? { '--follow-rows': expectedRows } : undefined}
        onClick={event => event.stopPropagation()}
      >
        <header className="follow-sheet-header">
          <div className="follow-sheet-tabs" role="tablist">
            {['followers', 'following'].map(name => (
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
              </button>
            ))}
          </div>
          <button
            ref={closeButton}
            type="button"
            className="follow-sheet-close"
            onClick={onClose}
            aria-label={copy.close}
          >
            <X size={18} />
          </button>
        </header>

        <div className="follow-sheet-body">
          {FOLLOW_WAITING.includes(current.status) && (
            <div className="follow-sheet-loading" aria-label={copy.loading} aria-busy="true">
              <div className="follow-row-skeleton" />
              <div className="follow-row-skeleton" />
              <div className="follow-row-skeleton" />
              {current.status !== 'loading' && (
                <p role="status">{current.status === 'offline' ? copy.offline : copy.slow}</p>
              )}
            </div>
          )}
          {current.status === 'error' && (
            <div className="follow-sheet-state">
              <p>{copy.error}</p>
              <button
                type="button"
                className="follow-sheet-more"
                onClick={() => setAttempt(value => value + 1)}
              >
                {copy.retry}
              </button>
            </div>
          )}
          {current.status === 'ready' && current.rows.length === 0 && (
            <div className="follow-sheet-state">
              <span className="follow-sheet-state-icon" aria-hidden="true">
                <UsersRound size={20} />
              </span>
              <p className="follow-sheet-state-title">{copy.emptyTitle}</p>
              <p>{copy.emptyHint}</p>
            </div>
          )}
          <AnimatePresence initial={false}>
            {current.rows.length > 0 && (
              <motion.ul
                className="follow-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: prefersReducedMotion ? 0.1 : 0.2 }}
              >
                {current.rows.map((row, index) => (
                  <motion.li
                    key={row.uid}
                    className={`follow-row${row.profile ? '' : ' follow-row--gone'}`}
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
              </motion.ul>
            )}
          </AnimatePresence>
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
        </div>
      </motion.div>
    </motion.div>
  );
}
