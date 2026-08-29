import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { EyeOff, ExternalLink, MessageCircle, Trash2 } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { deleteComment, fetchMyCommentsPage } from '../../services/commentService.js';
import { decodeCanonicalPaperKey } from '../../utils/paperCanonicalKey.js';
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
  title: { es: 'Mis comentarios', en: 'My comments' },
  subtitle: {
    es: 'Lo que has escrito en papers, con lo moderado incluido.',
    en: 'What you have written on papers, moderated items included.',
  },
  back: { es: 'Volver', en: 'Back' },
  loading: { es: 'Cargando...', en: 'Loading...' },
  emptyTitle: { es: 'Todavía no has comentado', en: 'No comments yet' },
  empty: { es: 'Todavía no has comentado ningún paper.', en: 'You have not commented on any paper yet.' },
  emptyCta: { es: 'Explorar papers', en: 'Explore papers' },
  error: { es: 'No se pudieron cargar tus comentarios.', en: 'Your comments could not be loaded.' },
  retry: { es: 'Reintentar', en: 'Try again' },
  more: { es: 'Cargar más', en: 'Load more' },
  openPaper: { es: 'Ver el paper', en: 'View paper' },
  reply: { es: 'Respuesta', en: 'Reply' },
  hidden: { es: 'Oculto por moderación', en: 'Hidden by moderation' },
  edited: { es: 'editado', en: 'edited' },
  delete: { es: 'Borrar', en: 'Delete' },
  deleteConfirm: { es: '¿Borrar? Si tiene respuestas, se borran también.', en: 'Delete? Any replies go too.' },
  confirm: { es: 'Sí, borrar', en: 'Yes, delete' },
  cancel: { es: 'Cancelar', en: 'Cancel' },
  deleteError: { es: 'No se pudo borrar. Vuelve a intentarlo.', en: 'It could not be deleted. Try again.' },
};

function formatDate(value, locale) {
  const date = typeof value?.toDate === 'function' ? value.toDate() : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MyCommentsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isEnglish, locale } = useLanguage();
  const text = useCallback(entry => entry[isEnglish ? 'en' : 'es'], [isEnglish]);

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
  // its own handler, so the effect never needs a synchronous setState.
  useEffect(() => {
    let active = true;
    fetchMyCommentsPage()
      .then((page) => {
        if (active) {
          setState({ status: 'ready', rows: page.comments, cursor: page.cursor, hasMore: page.hasMore });
        }
      })
      .catch((error) => {
        console.error('My comments could not be loaded', error);
        if (active) setState({ status: 'error', rows: [], cursor: null, hasMore: false });
      });
    return () => { active = false; };
  }, [attempt]);

  const loadMore = async () => {
    if (paging || !state.cursor) return;
    setPaging(true);
    try {
      const page = await fetchMyCommentsPage({ cursor: state.cursor });
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

        {state.status === 'error' && (
          <div className="my-comments-state">
            <p>{text(COPY.error)}</p>
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
            <span className="my-comments-state-icon" aria-hidden="true"><MessageCircle size={20} /></span>
            <h2 className="my-comments-state-title">{text(COPY.emptyTitle)}</h2>
            <p>{text(COPY.empty)}</p>
            <Link className="my-comments-cta" to="/">{text(COPY.emptyCta)}</Link>
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
                      <EyeOff size={11} aria-hidden="true" /> {text(COPY.hidden)}
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
                        <ExternalLink size={13} aria-hidden="true" /> {text(COPY.openPaper)}
                      </Link>
                    )}
                    <button type="button" className="my-comments-action my-comments-action--danger"
                      onClick={() => setConfirming(row.id)}>
                      <Trash2 size={13} aria-hidden="true" /> {text(COPY.delete)}
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
