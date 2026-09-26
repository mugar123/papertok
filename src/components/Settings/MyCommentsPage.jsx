import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowSquareOut, ChatCircle, EyeSlash, Trash } from '@phosphor-icons/react';
import { useLanguage } from '../../context/LanguageContext';
import { deleteComment, fetchMyCommentsPage } from '../../services/commentService.js';
import { decodeCanonicalPaperKey } from '../../utils/paperCanonicalKey.js';
import { isReadTimeout, patientRead, slowNoticeStatus } from '../../utils/boundedRead.js';
import { authoritativePage } from './myCommentsLoad.js';
import SettingsSubheader from './SettingsSubheader.jsx';
import { SETTINGS_BREADCRUMB } from './settingsBreadcrumb.js';
import './MyCommentsPage.css';

/**
 * Every comment this account has written, across all papers — the
 * collection-group query by author. This is also where moderation becomes
 * visible to the moderated: a hidden comment renders here with its badge,
 * which nobody else's thread view will show them.
 */

const COPY = {
  eyebrow: SETTINGS_BREADCRUMB,
  title: { en: 'My comments' },
  subtitle: {
    en: 'What you have written on papers, moderated items included.',
  },
  back: { en: 'Back' },
  loading: { en: 'Loading...' },
  emptyTitle: { en: 'No comments yet' },
  empty: { en: 'You have not commented on any paper yet.' },
  emptyCta: { en: 'Explore papers' },
  error: { en: 'Your comments could not be loaded.' },
  slowLoad: {
    en: 'This is taking longer than usual. Still trying.',
  },
  noConnection: {
    en: 'There seems to be no connection. Still trying.',
  },
  stalledLoad: {
    en: 'This is taking unusually long. We are still trying in the background.',
  },
  retry: { en: 'Try again' },
  more: { en: 'Load more' },
  openPaper: { en: 'View paper' },
  reply: { en: 'Reply' },
  hidden: { en: 'Hidden by moderation' },
  edited: { en: 'edited' },
  delete: { en: 'Delete' },
  deleteConfirm: { en: 'Delete? Any replies go too.' },
  confirm: { en: 'Yes, delete' },
  cancel: { en: 'Cancel' },
  deleteError: { en: 'It could not be deleted. Try again.' },
};

/**
 * What the page says while it is not showing the list. Three are waits (the
 * retry loop is still running behind them); only `error` is a verdict.
 */
const WAITING_COPY = {
  slow: COPY.slowLoad,
  offline: COPY.noConnection,
  stalled: COPY.stalledLoad,
  error: COPY.error,
};

function formatDate(value, locale) {
  const date = typeof value?.toDate === 'function' ? value.toDate() : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MyCommentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { locale } = useLanguage();
  const text = useCallback(entry => entry.en, []);

  const [state, setState] = useState({ status: 'loading', rows: [], cursor: null, hasMore: false });
  const [attempt, setAttempt] = useState(0);
  const [paging, setPaging] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [feedback, setFeedback] = useState('');

  const goBack = () => {
    if (location.key !== 'default') navigate(-1);
    else navigate('/settings');
  };

  // The initial state is already 'loading'; the retry button re-arms it in
  // its own handler, so the effect never needs a synchronous setState. The
  // read is the only comments query with no edge path — it is the one that
  // meets a cold WebChannel — so it waits like the sheet does: intermediate
  // timeouts become words, a transient rejection (including an empty cached
  // answer, see myCommentsLoad.js) is retried, and the loop outlives the
  // promise so a late answer still heals the screen.
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const startedAt = Date.now();
    const apply = (page) => {
      if (!active) return;
      setState({ status: 'ready', rows: page.comments, cursor: page.cursor, hasMore: page.hasMore });
    };
    patientRead(() => fetchMyCommentsPage().then(authoritativePage), {
      attempts: 3,
      label: 'my comments',
      signal: controller.signal,
      // `onSlow` fires at every intermediate timeout AND at every transient
      // rejection — and on the very path this page was rewritten for, the
      // first rejection is instant: an empty cached answer becomes an
      // `unavailable` in about half a millisecond, so the skeleton turned
      // into "this is taking longer than usual" at 2 ms, before anything had
      // taken long. The gate holds those words until the wait is real; being
      // offline is exempt, because that sentence is useful immediately.
      onSlow: (attemptNumber, info) => {
        if (!active) return;
        const waited = slowNoticeStatus(Date.now() - startedAt, info);
        if (!waited) return;
        setState(previous => ({ ...previous, status: waited }));
      },
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        if (!active) return;
        if (isReadTimeout(error)) {
          console.warn('My comments did not answer in time', error);
          setState(previous => ({ ...previous, status: 'stalled' }));
          return;
        }
        console.error('My comments could not be loaded', error);
        setState({ status: 'error', rows: [], cursor: null, hasMore: false });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  const loadMore = async () => {
    if (paging || !state.cursor) return;
    setPaging(true);
    try {
      const page = await fetchMyCommentsPage({ cursor: state.cursor }).then(authoritativePage);
      setState(previous => ({
        ...previous,
        rows: [...previous.rows, ...page.comments],
        cursor: page.cursor,
        hasMore: page.hasMore,
      }));
    } catch (error) {
      console.error('My comments could not be paged', error);
    } finally {
      setPaging(false);
    }
  };

  const remove = async (row) => {
    setFeedback('');
    try {
      await deleteComment({
        paperKey: row.paperKey,
        commentId: row.id,
        isReply: Boolean(row.replyTo),
      });
      setState(previous => ({ ...previous, rows: previous.rows.filter(entry => entry.id !== row.id) }));
    } catch (error) {
      console.error('The comment could not be deleted', error);
      setFeedback(text(COPY.deleteError));
    }
  };

  return (
    <main className="my-comments-page">
      <div className="my-comments-shell">
        <SettingsSubheader
          eyebrow={text(COPY.eyebrow)}
          title={text(COPY.title)}
          subtitle={text(COPY.subtitle)}
          backLabel={text(COPY.back)}
          onBack={goBack}
        />

        {feedback && <p className="my-comments-feedback" role="status">{feedback}</p>}

        {state.status === 'loading' && (
          <div className="my-comments-loading" aria-busy="true" aria-label={text(COPY.loading)}>
            <div className="my-comments-skeleton" />
            <div className="my-comments-skeleton" />
            <div className="my-comments-skeleton" />
          </div>
        )}

        {WAITING_COPY[state.status] && (
          // 'slow', 'offline' and 'stalled' keep aria-busy and the retry loop
          // behind them; only 'error' is a verdict.
          <div className="my-comments-state" role="status" aria-busy={state.status !== 'error'}>
            <p>{text(WAITING_COPY[state.status])}</p>
            <button
              type="button"
              className="my-comments-more"
              onClick={() => {
                setState(previous => ({ ...previous, status: 'loading' }));
                setAttempt(value => value + 1);
              }}
            >
              {text(COPY.retry)}
            </button>
          </div>
        )}

        {state.status === 'ready' && state.rows.length === 0 && (
          <div className="my-comments-state">
            <span className="my-comments-state-icon" aria-hidden="true"><ChatCircle size={20} /></span>
            <h2 className="my-comments-state-title">{text(COPY.emptyTitle)}</h2>
            <p>{text(COPY.empty)}</p>
            <Link className="my-comments-cta" to="/feed">{text(COPY.emptyCta)}</Link>
          </div>
        )}

        {state.status === 'ready' && state.rows.length > 0 && (
          <ul className="my-comments-list">
            {state.rows.map(row => {
              // The comment document stores no paper title, but its key
              // decodes to an honest identity (arxiv:…, doi:…) — enough
              // context to tell the rows apart without inventing data.
              const paperIdentity = row.paperKey ? decodeCanonicalPaperKey(row.paperKey) : null;
              return (
              <li
                key={`${row.paperKey}/${row.id}`}
                className={`my-comments-item${row.status === 'hidden' ? ' is-hidden' : ''}`}
              >
                <div className="my-comments-item-meta">
                  <span className="my-comments-item-date">{formatDate(row.createdAt, locale)}</span>
                  {paperIdentity && <span className="my-comments-paper-id">{paperIdentity}</span>}
                  {row.replyTo && <span className="my-comments-chip">{text(COPY.reply)}</span>}
                  {row.editedAt && <span className="my-comments-item-date">{text(COPY.edited)}</span>}
                  {row.status === 'hidden' && (
                    <span className="my-comments-chip my-comments-chip--hidden">
                      <EyeSlash size={11} aria-hidden="true" /> {text(COPY.hidden)}
                    </span>
                  )}
                </div>
                <p className="my-comments-item-text">{row.text}</p>
                {/* Confirming replaces the row's actions instead of crowding in
                    beside them: the only two answers on offer are the two that
                    matter. */}
                {confirming === row.id ? (
                  <div className="my-comments-confirm" role="group" aria-label={text(COPY.deleteConfirm)}>
                    <span>{text(COPY.deleteConfirm)}</span>
                    <button
                      type="button"
                      className="my-comments-confirm-yes"
                      autoFocus
                      onClick={() => { setConfirming(null); remove(row); }}
                    >
                      {text(COPY.confirm)}
                    </button>
                    <button type="button" className="my-comments-confirm-no" onClick={() => setConfirming(null)}>
                      {text(COPY.cancel)}
                    </button>
                  </div>
                ) : (
                  <div className="my-comments-item-actions">
                    {row.paperKey && (
                      <Link className="my-comments-action" to={`/public/paper/${encodeURIComponent(row.paperKey)}`}>
                        <ArrowSquareOut size={13} aria-hidden="true" /> {text(COPY.openPaper)}
                      </Link>
                    )}
                    <button type="button" className="my-comments-action my-comments-action--danger"
                      onClick={() => setConfirming(row.id)}>
                      <Trash size={13} aria-hidden="true" /> {text(COPY.delete)}
                    </button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}

        {state.status === 'ready' && state.hasMore && (
          <button type="button" className="my-comments-more" onClick={loadMore} disabled={paging}>
            {paging ? text(COPY.loading) : text(COPY.more)}
          </button>
        )}
      </div>
    </main>
  );
}
