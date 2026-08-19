import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import {
  FOLLOW_PAGE_SIZE,
  readFollowedUsersPage,
  readFollowersPage,
} from '../../services/followUserService.js';
import { readUserProfile } from '../../services/userProfileService.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
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
      <li className="follow-row follow-row--gone">
        <span className="follow-avatar" aria-hidden="true">?</span>
        <span className="follow-row-body">
          <span className="follow-row-name">{unavailableLabel}</span>
        </span>
      </li>
    );
  }

  return (
    <li className="follow-row">
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
    </li>
  );
}

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
  const closeButton = useRef(null);
  const current = page.mode === mode ? page : EMPTY_PAGE;

  const copy = isEnglish ? {
    followers: 'Followers',
    following: 'Following',
    close: 'Close',
    empty: mode === 'followers' ? 'No followers yet.' : 'Not following anyone yet.',
    more: 'Load more',
    loading: 'Loading...',
    error: 'This list could not be loaded.',
    retry: 'Try again',
    unavailable: 'Account unavailable',
  } : {
    followers: 'Seguidores',
    following: 'Siguiendo',
    close: 'Cerrar',
    empty: mode === 'followers' ? 'Todavía no tiene seguidores.' : 'Todavía no sigue a nadie.',
    more: 'Cargar más',
    loading: 'Cargando...',
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
    readPage(null)
      .then((result) => {
        if (active) setPage({ mode, ...result, status: 'ready' });
      })
      .catch((error) => {
        console.error('Error loading the follow list:', error);
        if (active) setPage({ ...EMPTY_PAGE, mode, status: 'error' });
      });
    return () => { active = false; };
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

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
        className="follow-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'followers' ? copy.followers : copy.following}
        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
        transition={prefersReducedMotion
          ? { duration: 0.1 }
          : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
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
          {current.status === 'loading' && <p className="follow-sheet-note">{copy.loading}</p>}
          {current.status === 'error' && (
            <div className="follow-sheet-note">
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
            <p className="follow-sheet-note">{copy.empty}</p>
          )}
          <AnimatePresence initial={false}>
            {current.rows.length > 0 && (
              <motion.ul
                className="follow-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: prefersReducedMotion ? 0.1 : 0.2 }}
              >
                {current.rows.map(row => (
                  <Row
                    key={row.uid}
                    uid={row.uid}
                    profile={row.profile}
                    unavailableLabel={copy.unavailable}
                    onNavigate={onClose}
                  />
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
