import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CornerDownRight, Flag, MessageCircle, Pencil, Trash2, X } from 'lucide-react';
import {
  createComment,
  deleteComment,
  editComment,
  fetchCommentCount,
  fetchThreadPage,
  groupThread,
} from '../../services/commentService.js';
import { resolveThreadAnchor } from '../../services/paperStubService.js';
import {
  fetchThreadAnchor,
  invalidateThreadAnchor,
  localThreadKeys,
} from '../../services/threadAnchorClient.js';
import { commentMillis } from '../../utils/commentTime.js';
import {
  commentTargetPath,
  hideCommentLocally,
  locallyHiddenCommentIds,
  readModerationConfig,
  submitReport,
} from '../../services/reportService.js';
import { profileIsPublic, readOwnUserProfile } from '../../services/userProfileService.js';
import { getPublicProfilePath } from '../../utils/publicNavigation.js';
import { createSessionCache } from '../../utils/sessionCache.js';
import { isReadTimeout, patientRead, withReadTimeout } from '../../utils/boundedRead.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { areaAccentForPaper } from '../../utils/areaAccent.js';
import { Button } from '../ui/button.jsx';
import './CommentsSheet.css';

// Opening the sheet used to start from nothing every time: anchor, pages and
// counts re-read on each open — three round trips of skeleton for a thread
// that was on screen two seconds earlier. Reopening now paints the cached
// thread instantly and lets the same load effect revalidate behind it.
const threadCache = createSessionCache({ maxEntries: 12 });
// One slot: the signed-in viewer of this tab. Cleared on sign-out so a
// following session can never inherit the previous account's composer gate.
let viewerProfileCache = null;

/**
 * The comment thread of one paper, as a sheet over the paper page.
 *
 * Everything Firestore here is lazy and bounded: nothing loads until the
 * sheet opens, and then it is one stub read (two for a dual-identity paper —
 * the split-brain check), one capped count, one `limit(20)` page, and the
 * viewer's own profile for composer gating. The feed never comes near any of
 * it.
 *
 * Threads read oldest-first, so a reply's parent is always already on
 * screen; replies hang one level deep under their parent, and answering a
 * reply answers its thread (the parent), TikTok-style.
 *
 * Who may write is the rules' decision, mirrored honestly by the composer:
 * signed out → sign in; no public profile → create one; private profile →
 * commenting is a public act, with the path to going public spelled out.
 */

const COPY = {
  title: { es: 'Comentarios', en: 'Comments' },
  close: { es: 'Cerrar', en: 'Close' },
  loading: { es: 'Cargando...', en: 'Loading...' },
  emptyTitle: { es: 'Nadie ha comentado todavía', en: 'Nobody has commented yet' },
  empty: { es: 'Abre la conversación.', en: 'Start the conversation.' },
  loadError: { es: 'No se pudieron cargar los comentarios.', en: 'The comments could not be loaded.' },
  slowLoad: {
    es: 'Está tardando más de lo normal. Seguimos intentándolo.',
    en: 'This is taking longer than usual. Still trying.',
  },
  noConnection: {
    es: 'Parece que no hay conexión. Seguimos intentándolo.',
    en: 'There seems to be no connection. Still trying.',
  },
  stalledLoad: {
    es: 'Está tardando muchísimo. Seguimos intentándolo por detrás.',
    en: 'This is taking unusually long. We are still trying in the background.',
  },
  retry: { es: 'Reintentar', en: 'Try again' },
  more: { es: 'Cargar más', en: 'Load more' },
  placeholder: { es: 'Añade un comentario...', en: 'Add a comment...' },
  replyingTo: { es: 'Respondiendo a', en: 'Replying to' },
  editing: { es: 'Editando tu comentario', en: 'Editing your comment' },
  cancel: { es: 'Cancelar', en: 'Cancel' },
  send: { es: 'Publicar', en: 'Post' },
  save: { es: 'Guardar', en: 'Save' },
  reply: { es: 'Responder', en: 'Reply' },
  edit: { es: 'Editar', en: 'Edit' },
  delete: { es: 'Borrar', en: 'Delete' },
  deleteConfirm: { es: '¿Borrar? Sus respuestas se borran también.', en: 'Delete? Its replies go too.' },
  deleteReplyConfirm: { es: '¿Borrar esta respuesta?', en: 'Delete this reply?' },
  confirm: { es: 'Sí, borrar', en: 'Yes, delete' },
  report: { es: 'Reportar', en: 'Report' },
  reportWhy: { es: 'Motivo del reporte', en: 'Reason' },
  reportSpam: { es: 'Spam', en: 'Spam' },
  reportAbuse: { es: 'Abuso', en: 'Abuse' },
  reportOther: { es: 'Otro', en: 'Other' },
  reported: { es: 'Reportado. Ya no lo verás en este dispositivo.', en: 'Reported. You will no longer see it on this device.' },
  reportThrottled: { es: 'Reportaste hace muy poco. Espera un minuto.', en: 'You reported very recently. Give it a minute.' },
  edited: { es: 'editado', en: 'edited' },
  hiddenBadge: { es: 'Oculto por moderación', en: 'Hidden by moderation' },
  hiddenExplain: { es: 'Solo tú lo ves aquí.', en: 'Only you can see it here.' },
  signInPrompt: { es: 'Inicia sesión para unirte a la conversación.', en: 'Sign in to join the conversation.' },
  signIn: { es: 'Iniciar sesión', en: 'Sign in' },
  needProfileTitle: { es: 'Comentar necesita un perfil público', en: 'Commenting needs a public profile' },
  needProfileBody: { es: 'Tu comentario se firma con tu handle. Crea tu perfil para comentar.', en: 'Your comment is signed with your handle. Create your profile to comment.' },
  needProfileCta: { es: 'Crear mi perfil', en: 'Create my profile' },
  privateTitle: { es: 'Tu perfil es privado', en: 'Your profile is private' },
  privateBody: {
    es: 'Comentar es un acto público: tu handle queda a la vista junto a lo que escribas. Para comentar, haz público tu perfil desde su editor.',
    en: 'Commenting is a public act: your handle stands next to what you write. To comment, make your profile public from the profile editor.',
  },
  privateCta: { es: 'Revisar mi privacidad', en: 'Review my privacy' },
  frozen: { es: 'Los comentarios están pausados temporalmente en toda la app.', en: 'Comments are temporarily paused across the app.' },
  throttled: { es: 'Vas demasiado rápido. Espera unos segundos y vuelve a intentarlo.', en: 'Too fast. Wait a few seconds and try again.' },
  writeError: { es: 'No se pudo publicar. Revisa tu conexión.', en: 'It could not be posted. Check your connection.' },
  deleteError: { es: 'No se pudo borrar. Vuelve a intentarlo.', en: 'It could not be deleted. Try again.' },
};

/**
 * What the body says while it is not showing a thread. Three of the four are
 * waits, not failures: only `error` is the sheet giving up, and it is reached
 * solely by an error that retrying cannot fix.
 */
const WAITING_COPY = {
  slow: COPY.slowLoad,
  offline: COPY.noConnection,
  // Past the budget, but the retry loop is still running behind it: a wait
  // with no end and no words reads as a hung screen, so it gets both.
  stalled: COPY.stalledLoad,
  error: COPY.loadError,
};

const RELATIVE_STEPS = [
  { seconds: 60, es: 'ahora', en: 'now' },
  { seconds: 3600, divisor: 60, es: 'min', en: 'min' },
  { seconds: 86400, divisor: 3600, es: 'h', en: 'h' },
  { seconds: 2592000, divisor: 86400, es: 'd', en: 'd' },
];

function relativeTime(value, isEnglish) {
  const time = commentMillis(value);
  if (!Number.isFinite(time) || time <= 0) return '';
  const elapsed = Math.max(0, (Date.now() - time) / 1000);
  for (const step of RELATIVE_STEPS) {
    if (elapsed < step.seconds) {
      if (!step.divisor) return isEnglish ? step.en : step.es;
      return `${Math.floor(elapsed / step.divisor)} ${isEnglish ? step.en : step.es}`;
    }
  }
  return new Date(time).toLocaleDateString(isEnglish ? 'en' : 'es', { day: 'numeric', month: 'short', year: 'numeric' });
}

function initialOf(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}


/**
 * Turns a denied write into the honest sentence for it: the killswitch, the
 * throttle, or a plain failure. One extra read (the config doc) and only on
 * the error path — the happy path never pays for the diagnosis.
 */
async function explainDenial(error, text) {
  if (error?.code !== 'permission-denied') return text(COPY.writeError);
  const config = await readModerationConfig().catch(() => null);
  if (config?.commentsFrozen) return text(COPY.frozen);
  return text(COPY.throttled);
}

function CommentBody({ comment, isEnglish, text, onNavigate }) {
  return (
    <>
      {/* The machine line: who, when, and whether it was touched since. */}
      <div className="comment-row-meta">
        <span className="comment-avatar" aria-hidden="true">{initialOf(comment.authorHandle)}</span>
        {/* Navigating from inside a modal closes the modal (the FollowSheet
            contract) — otherwise the sheet would sit over the profile. */}
        <Link
          className="comment-row-handle"
          to={getPublicProfilePath(comment.authorHandle) || '#'}
          onClick={onNavigate}
        >
          @{comment.authorHandle}
        </Link>
        <span className="comment-row-dot" aria-hidden="true">·</span>
        <span className="comment-row-time">{relativeTime(comment.createdAt, isEnglish)}</span>
        {comment.editedAt && (
          <>
            <span className="comment-row-dot" aria-hidden="true">·</span>
            <span className="comment-row-edited">{text(COPY.edited)}</span>
          </>
        )}
      </div>
      {comment.status === 'hidden' && (
        <div className="comment-row-hidden-badge">
          {text(COPY.hiddenBadge)}. {text(COPY.hiddenExplain)}
        </div>
      )}
      <p className="comment-row-text">{comment.text}</p>
    </>
  );
}

function CommentRow({
  comment, isReply, viewerUid, canInteract, busy,
  onReply, onEdit, onDelete, onReport, isEnglish, text, onNavigate,
}) {
  const [confirming, setConfirming] = useState(null); // 'delete' | 'report'
  const own = viewerUid && comment.authorUid === viewerUid;

  // `own` implies a viewer, so the two groups between them cover every case a
  // signed-in reader has; a guest only ever sees the thread.
  const hasActions = canInteract || Boolean(viewerUid);

  return (
    <div className={`comment-row${isReply ? ' comment-row--reply' : ''}`}>
      <CommentBody comment={comment} isEnglish={isEnglish} text={text} onNavigate={onNavigate} />

      {confirming === 'delete' ? (
        <div className="comment-row-confirm comment-row-confirm--danger" role="alert">
          <span>{text(isReply ? COPY.deleteReplyConfirm : COPY.deleteConfirm)}</span>
          <Button type="button" variant="destructive" size="sm" className="px-3" disabled={busy}
            onClick={() => { setConfirming(null); onDelete(comment); }}>
            {text(COPY.confirm)}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => setConfirming(null)}>
            {text(COPY.cancel)}
          </Button>
        </div>
      ) : confirming === 'report' ? (
        <div className="comment-row-confirm" role="alert">
          <span>{text(COPY.reportWhy)}:</span>
          {[['spam', COPY.reportSpam], ['abuse', COPY.reportAbuse], ['other', COPY.reportOther]].map(([reason, label]) => (
            <Button key={reason} type="button" variant="outline" size="sm" className="px-3" disabled={busy}
              onClick={() => { setConfirming(null); onReport(comment, reason); }}>
              {text(label)}
            </Button>
          ))}
          <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => setConfirming(null)}>
            {text(COPY.cancel)}
          </Button>
        </div>
      ) : hasActions && (
        /* Primary on the left, the one thing you can do *about* a comment
           behind a rule on the right. */
        <div className="comment-row-actions">
          <div className="comment-row-actions-primary">
            {canInteract && (
              <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => onReply(comment)}>
                <CornerDownRight size={14} aria-hidden="true" /> {text(COPY.reply)}
              </Button>
            )}
            {own && (
              <Button type="button" variant="ghost" size="sm" className="px-2" onClick={() => onEdit(comment)}>
                <Pencil size={14} aria-hidden="true" /> {text(COPY.edit)}
              </Button>
            )}
          </div>
          {viewerUid && (
            <div className="comment-row-actions-utility">
              {own ? (
                <Button type="button" variant="ghost" size="sm"
                  className="px-2 hover:text-[var(--accent-rose)]"
                  onClick={() => setConfirming('delete')}>
                  <Trash2 size={14} aria-hidden="true" /> {text(COPY.delete)}
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" className="px-2"
                  onClick={() => setConfirming('report')}>
                  <Flag size={14} aria-hidden="true" /> {text(COPY.report)}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommentsSheet({ paper, isAuthenticated, isEnglish, onClose, onAuthRequired }) {
  const prefersReducedMotion = useReducedMotion();
  const text = useCallback(entry => entry[isEnglish ? 'en' : 'es'], [isEnglish]);

  const seededThread = paper?.id ? threadCache.get(paper.id) : undefined;
  // Whether THIS open started from the cache — a ref, because the load
  // effect's failure guard needs the fact without re-running when the
  // write-through below updates the cache.
  const openedSeeded = useRef(Boolean(seededThread));
  const [anchor, setAnchor] = useState(seededThread ? seededThread.anchor : null);
  const [status, setStatus] = useState(seededThread ? 'ready' : 'loading');
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState(seededThread ? seededThread.rows : []);
  // One pagination source per stub the paper resolves to: the canonical one
  // plus any alternate that already holds comments (split-brain read).
  const [sources, setSources] = useState(seededThread ? seededThread.sources : []);
  const [count, setCount] = useState(seededThread ? seededThread.count : null);
  const [ownProfile, setOwnProfile] = useState(
    () => (isAuthenticated && viewerProfileCache) || { status: 'loading', profile: null },
  );
  const [hiddenLocally, setHiddenLocally] = useState(() => locallyHiddenCommentIds());
  const [paging, setPaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [composerError, setComposerError] = useState(null);
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);

  // The modal keyboard contract — Escape, a focus trap, and handing focus back
  // to whatever opened the sheet — comes from the shared hook rather than from
  // a copy of it here. The sheet only exists while it is open, so `open` is
  // constant.
  const sheet = useDialogFocus(true, onClose);
  const composerInput = useRef(null);
  const dupReported = useRef(false);
  const viewerUid = ownProfile.uid || null;
  const areaAccent = useMemo(() => areaAccentForPaper(paper), [paper]);

  const slidesFromBottom = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 599px)').matches,
    [],
  );

  // Everything the sheet needs, loaded once per open (and per retry). The
  // initial state is already 'loading', and the retry button re-arms it in
  // its own handler — no synchronous setState in the effect.
  useEffect(() => {
    let active = true;
    // `patientRead` keeps re-reading behind a backoff for as long as the
    // connection stays mute, and that loop outlives the promise on purpose.
    // Aborting on cleanup is what stops a closed sheet from reading forever.
    const controller = new AbortController();

    // One attempt = the whole pipeline the thread needs: anchor, then its
    // pages. Timing belongs to `patientRead`, not to the stages — measured,
    // a healthy attempt completes in 60-390 ms and a stalled one never does,
    // so what matters is retrying and accepting late answers, not slicing.
    const loadThread = async () => {
      try {
        const fromEdge = await fetchThreadAnchor(paper);
        if (fromEdge) return fromEdge;
      } catch (error) {
        // Worker down, unconfigured, or timed out: the Firestore path below
        // is the same chain the sheet used to run alone.
        console.warn('The edge thread lookup did not answer; reading Firestore', error);
      }
      const resolved = await resolveThreadAnchor(paper);
      if (!resolved) return { resolved: null };
      const keys = [
        ...(resolved.stubExists ? [resolved.key] : []),
        ...resolved.alternates.map(alternate => alternate.key),
      ];
      const pages = await Promise.all(keys.map(async key => ({
        key, ...(await fetchThreadPage(key)),
      })));
      return { resolved, keys, pages };
    };

    const apply = ({ resolved, keys, pages, count: counted }) => {
      if (!active) return;
      if (!resolved) {
        // No identity to converge on — a data condition, not a slow read.
        setStatus('error');
        return;
      }
      setAnchor(resolved);
      const merged = pages
        .flatMap(page => page.comments.map(comment => ({ ...comment, paperKey: page.key })))
        .sort((a, b) => commentMillis(a.createdAt) - commentMillis(b.createdAt));
      setRows(merged);
      setSources(pages.map(page => ({ key: page.key, cursor: page.cursor, hasMore: page.hasMore })));
      // Ready on the thread alone. The count is a header badge, and an
      // aggregation is server-only with no cache fallback — it must never
      // stand between the reader and comments already in hand.
      setStatus('ready');
      if (counted && typeof counted.count === 'number') {
        setCount(counted);
        return;
      }
      if (keys.length === 0) {
        // No stub means no thread: zero is knowledge already in hand, not a
        // number worth an aggregation read.
        setCount({ count: 0, capped: false });
        return;
      }
      Promise.all(keys.map(key => withReadTimeout(fetchCommentCount(key), { label: 'comment count' })
        .catch(() => null)))
        .then(counts => {
          if (!active || counts.every(entry => entry === null)) return;
          const total = counts.reduce((sum, entry) => sum + (entry?.count ?? 0), 0);
          setCount({ count: total, capped: counts.some(entry => entry?.capped) });
        });
    };

    patientRead(loadThread, {
      attempts: 3,
      label: 'comment thread',
      signal: controller.signal,
      // The truth at the first timeout is "slow", not "failed": the interface
      // says so, keeps the retry racing, and any answer replaces the notice.
      // A mute connection and a missing one are different truths, and the
      // reader can act on the second one.
      onSlow: (attemptNumber, info) => {
        if (!active) return;
        if (openedSeeded.current && attempt === 0) return;
        setStatus(info?.offline ? 'offline' : 'slow');
      },
      // A stall that ends at nine seconds heals the sheet at nine seconds.
      onLateResult: apply,
    })
      .then(apply)
      .catch((error) => {
        if (!active) return;
        // A failed refresh behind an already-visible cached thread stays quiet
        // (the cached view keeps standing); an explicit retry reports honestly.
        if (openedSeeded.current && attempt === 0) return;
        if (isReadTimeout(error)) {
          // The budget is spent, the loop is not: onLateResult stays armed and
          // can still paint the thread. Saying "could not be loaded" here
          // blamed the server for a slow answer — disproved by the instant
          // success on the next tap — but leaving the skeleton up forever is
          // its own lie, so this says what is true and offers the button.
          console.warn('The comment thread did not answer in time', error);
          setStatus('stalled');
          return;
        }
        console.error('The comment thread could not be loaded', error);
        setStatus('error');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [paper, attempt]);

  // Write-through, and not only after loads: local mutations (post, edit,
  // delete) flow through `rows`, so the next reopen starts from what the
  // reader last saw.
  useEffect(() => {
    if (status !== 'ready' || !paper?.id || !anchor) return;
    threadCache.set(paper.id, { anchor, rows, sources, count });
  }, [status, paper?.id, anchor, rows, sources, count]);

  // The viewer's own profile decides what the composer is allowed to say.
  // Signed out, the composer never consults it (the signed-out gate comes
  // first), so the effect simply has nothing to fetch.
  useEffect(() => {
    let active = true;
    if (!isAuthenticated) {
      viewerProfileCache = null;
      return undefined;
    }
    readOwnUserProfile()
      .then((profile) => {
        const resolved = { status: 'ready', profile, uid: profile?.uid ?? undefined };
        // Only a real answer is worth keeping across opens; a transient
        // failure must not gate the composer for the rest of the session.
        viewerProfileCache = resolved;
        if (active) setOwnProfile(resolved);
      })
      .catch(() => {
        if (active) setOwnProfile({ status: 'ready', profile: null });
      });
    return () => { active = false; };
  }, [isAuthenticated]);

  // Two stubs for one paper is a data condition the admin fixes by merging;
  // the reader who noticed files the report, silently and at most once.
  useEffect(() => {
    if (!anchor || !isAuthenticated || dupReported.current) return;
    if (!anchor.stubExists || anchor.alternates.length === 0) return;
    dupReported.current = true;
    submitReport({
      targetPath: `papers/${anchor.key}`,
      targetAuthorUid: '',
      reason: 'dup-stub',
      note: `also: ${anchor.alternates.map(alternate => `papers/${alternate.key}`).join(', ')}`,
    }).catch(() => { /* throttled or offline: the condition resurfaces */ });
  }, [anchor, isAuthenticated]);

  const visibleRows = useMemo(() => rows.filter(row => (
    (row.status !== 'hidden' || row.authorUid === viewerUid)
    && !hiddenLocally.has(row.id)
  )), [rows, viewerUid, hiddenLocally]);
  const thread = useMemo(() => groupThread(visibleRows), [visibleRows]);

  const composerState = !isAuthenticated
    ? 'signed-out'
    : ownProfile.status !== 'ready'
      ? 'loading'
      : !ownProfile.profile
        ? 'no-profile'
        : !profileIsPublic(ownProfile.profile)
          ? 'private'
          : 'ready';
  const canInteract = composerState === 'ready';

  const loadMore = async () => {
    if (paging) return;
    const pending = sources.filter(source => source.hasMore && source.cursor);
    if (!pending.length) return;
    setPaging(true);
    try {
      const pages = await Promise.all(pending.map(async source => ({
        key: source.key,
        ...(await fetchThreadPage(source.key, { cursor: source.cursor })),
      })));
      const fresh = pages
        .flatMap(page => page.comments.map(comment => ({ ...comment, paperKey: page.key })))
        .sort((a, b) => commentMillis(a.createdAt) - commentMillis(b.createdAt));
      setRows(previous => [...previous, ...fresh]);
      setSources(previous => previous.map(source => {
        const page = pages.find(entry => entry.key === source.key);
        return page ? { key: source.key, cursor: page.cursor, hasMore: page.hasMore } : source;
      }));
    } catch (error) {
      console.error('The comment thread could not be paged', error);
    } finally {
      setPaging(false);
    }
  };

  const startReply = (comment) => {
    // Replying to a reply answers its thread: one level, by design.
    setEditTarget(null);
    setReplyTarget(comment.replyTo
      ? rows.find(row => row.id === comment.replyTo) ?? comment
      : comment);
    composerInput.current?.focus();
  };

  const startEdit = (comment) => {
    setReplyTarget(null);
    setEditTarget(comment);
    setDraft(comment.text);
    composerInput.current?.focus();
  };

  const resetComposer = () => {
    setDraft('');
    setReplyTarget(null);
    setEditTarget(null);
    setComposerError(null);
  };

  const submit = async () => {
    if (busy || !anchor || !draft.trim()) return;
    setBusy(true);
    setComposerError(null);
    setNotice(null);
    try {
      if (editTarget) {
        const trimmed = draft.trim();
        await editComment(editTarget.paperKey ?? anchor.key, editTarget.id, trimmed);
        setRows(previous => previous.map(row => (
          row.id === editTarget.id ? { ...row, text: trimmed, editedAt: new Date() } : row
        )));
        void invalidateThreadAnchor([editTarget.paperKey ?? anchor.key]);
      } else {
        const result = await createComment({
          anchor,
          paper,
          authorHandle: ownProfile.profile.handle,
          text: draft,
          replyTo: replyTarget?.id ?? null,
        });
        setRows(previous => [...previous, {
          id: result.id, ...result.comment, authorUid: viewerUid ?? result.comment.authorUid, paperKey: anchor.key,
        }]);
        setCount(previous => (previous ? { ...previous, count: previous.count + 1 } : previous));
        if (!anchor.stubExists) setAnchor(previous => ({ ...previous, stubExists: true }));
        void invalidateThreadAnchor([anchor.key, ...localThreadKeys(paper)]);
      }
      resetComposer();
    } catch (error) {
      setComposerError(await explainDenial(error, text));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (comment) => {
    setBusy(true);
    setNotice(null);
    try {
      await deleteComment({
        paperKey: comment.paperKey ?? anchor.key,
        commentId: comment.id,
        isReply: Boolean(comment.replyTo),
      });
      const droppedIds = new Set([comment.id]);
      if (!comment.replyTo) {
        for (const row of rows) {
          if (row.replyTo === comment.id) droppedIds.add(row.id);
        }
      }
      setRows(previous => previous.filter(row => !droppedIds.has(row.id)));
      setCount(previous => (previous
        ? { ...previous, count: Math.max(0, previous.count - droppedIds.size) }
        : previous));
      void invalidateThreadAnchor([comment.paperKey ?? anchor.key, anchor.key]);
    } catch (error) {
      console.error('The comment could not be deleted', error);
      setNotice(text(COPY.deleteError));
    } finally {
      setBusy(false);
    }
  };

  const report = async (comment, reason) => {
    setBusy(true);
    setNotice(null);
    try {
      await submitReport({
        targetPath: commentTargetPath(comment.paperKey ?? anchor.key, comment.id),
        targetAuthorUid: comment.authorUid,
        reason,
      });
      hideCommentLocally(comment.id);
      setHiddenLocally(locallyHiddenCommentIds());
      setNotice(text(COPY.reported));
    } catch (error) {
      setNotice(error?.code === 'permission-denied' ? text(COPY.reportThrottled) : text(COPY.writeError));
    } finally {
      setBusy(false);
    }
  };

  // The sheet arrives on a spring — it should read as pulled into place — and
  // leaves on a short ease-in, because a spring on the way out reads as
  // hesitation. Entrance and exit are therefore separate transitions rather
  // than one shared curve, and the backdrop below is timed so that neither of
  // the two ever outlives the other on screen.
  const sheetMotion = prefersReducedMotion ? {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.12 } },
    exit: { opacity: 0, transition: { duration: 0.12 } },
  } : slidesFromBottom ? {
    initial: { y: '100%' },
    animate: {
      y: 0,
      // Near-critically damped (damping ~ 2*sqrt(stiffness*mass)): the sheet
      // glides in and lands without a bounce. The old 420-stiffness spring
      // covered the distance so fast it read as a snap.
      transition: { type: 'spring', stiffness: 260, damping: 31, mass: 0.95 },
    },
    exit: {
      y: '100%',
      transition: { duration: 0.3, ease: [0.4, 0, 1, 1] },
    },
  } : {
    initial: { opacity: 0, scale: 0.94, y: 18 },
    animate: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: {
        type: 'spring',
        stiffness: 280,
        damping: 30,
        mass: 0.9,
        // Opacity on a spring flickers at the settle; give it its own tween,
        // long enough to keep pace with the slower spring.
        opacity: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
      },
    },
    exit: {
      opacity: 0,
      scale: 0.98,
      y: 10,
      transition: { duration: 0.28, ease: [0.4, 0, 1, 1] },
    },
  };

  // Slightly slower out than the sheet, so the dimmed backdrop is the last
  // thing to go and the sheet never flashes against the bare page.
  const backdropMotion = {
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: { duration: prefersReducedMotion ? 0.12 : 0.3, ease: 'easeOut' },
    },
    exit: {
      opacity: 0,
      transition: { duration: prefersReducedMotion ? 0.12 : 0.36, ease: 'easeIn' },
    },
  };

  const hasMore = sources.some(source => source.hasMore);

  return (
    <motion.div
      className="comments-sheet-backdrop"
      {...backdropMotion}
      onClick={onClose}
    >
      <motion.div
        ref={sheet}
        className="comments-sheet"
        style={{ '--area-accent': areaAccent }}
        role="dialog"
        aria-modal="true"
        aria-label={text(COPY.title)}
        tabIndex={-1}
        {...sheetMotion}
        onClick={event => event.stopPropagation()}
      >
        <header className="comments-sheet-header">
          <div className="comments-sheet-heading">
            <div className="comments-sheet-titles">
              <h2 className="comments-sheet-title">{text(COPY.title)}</h2>
              {count != null && (
                <span className="comments-sheet-count">{count.capped ? '1000+' : count.count}</span>
              )}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="comments-sheet-close"
            onClick={onClose}
            aria-label={text(COPY.close)}
          >
            <X size={16} />
          </Button>
        </header>

        <div className="comments-sheet-body">
          {status === 'loading' && (
            <div className="comments-sheet-loading" role="status" aria-label={text(COPY.loading)} aria-busy="true">
              {[0, 1, 2].map(index => (
                <div className="comment-skeleton" key={index} aria-hidden="true">
                  <span /><span /><span />
                </div>
              ))}
            </div>
          )}
          {WAITING_COPY[status] && (
            // 'slow' and 'offline' are still waits — they keep `aria-busy` and
            // the retry loop behind them. Only 'error' is a verdict.
            <div className="comments-sheet-state" role="status" aria-busy={status !== 'error'}>
              <p>{text(WAITING_COPY[status])}</p>
              <Button
                type="button"
                variant="outline"
                className="comments-sheet-state-action"
                onClick={() => {
                  setStatus('loading');
                  setAttempt(value => value + 1);
                }}
              >
                {text(COPY.retry)}
              </Button>
            </div>
          )}
          {status === 'ready' && thread.length === 0 && (
            <div className="comments-sheet-state" role="status">
              <span className="comments-sheet-state-icon" aria-hidden="true">
                <MessageCircle size={20} />
              </span>
              <h3 className="comments-sheet-state-title">{text(COPY.emptyTitle)}</h3>
              <p>{text(COPY.empty)}</p>
            </div>
          )}
          {status === 'ready' && thread.length > 0 && (
            <ul className="comments-list">
              {thread.map(entry => (
                <li key={entry.id} className="comments-list-item">
                  <CommentRow
                    comment={entry}
                    isReply={false}
                    viewerUid={viewerUid}
                    canInteract={canInteract}
                    busy={busy}
                    onReply={startReply}
                    onEdit={startEdit}
                    onDelete={remove}
                    onReport={report}
                    isEnglish={isEnglish}
                    text={text}
                    onNavigate={onClose}
                  />
                  {entry.replies.length > 0 && (
                    <ul className="comments-replies">
                      {entry.replies.map(reply => (
                        <li key={reply.id}>
                          <CommentRow
                            comment={reply}
                            isReply
                            viewerUid={viewerUid}
                            canInteract={canInteract}
                            busy={busy}
                            onReply={startReply}
                            onEdit={startEdit}
                            onDelete={remove}
                            onReport={report}
                            isEnglish={isEnglish}
                            text={text}
                            onNavigate={onClose}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status === 'ready' && hasMore && (
            <Button
              type="button"
              variant="outline"
              className="comments-sheet-more w-full"
              onClick={loadMore}
              disabled={paging}
            >
              {paging ? text(COPY.loading) : text(COPY.more)}
            </Button>
          )}
          {notice && <p className="comments-sheet-notice" role="status">{notice}</p>}
        </div>

        <footer className="comments-sheet-footer">
          {composerState === 'signed-out' && (
            <div className="comments-gate">
              <p>{text(COPY.signInPrompt)}</p>
              <Button type="button" onClick={onAuthRequired}>
                {text(COPY.signIn)}
              </Button>
            </div>
          )}
          {composerState === 'no-profile' && (
            <div className="comments-gate">
              <p><strong>{text(COPY.needProfileTitle)}.</strong> {text(COPY.needProfileBody)}</p>
              <Button asChild variant="outline">
                <Link to="/settings/profile" onClick={onClose}>{text(COPY.needProfileCta)}</Link>
              </Button>
            </div>
          )}
          {composerState === 'private' && (
            <div className="comments-gate">
              <p><strong>{text(COPY.privateTitle)}.</strong> {text(COPY.privateBody)}</p>
              <Button asChild variant="outline">
                <Link to="/settings/profile" onClick={onClose}>{text(COPY.privateCta)}</Link>
              </Button>
            </div>
          )}
          {composerState === 'ready' && (
            <div className="comments-composer">
              {replyTarget && (
                <div className="comments-composer-context">
                  <CornerDownRight size={13} aria-hidden="true" />
                  <span>{text(COPY.replyingTo)} @{replyTarget.authorHandle}</span>
                  <Button type="button" variant="ghost" size="icon-sm"
                    onClick={() => setReplyTarget(null)} aria-label={text(COPY.cancel)}>
                    <X size={14} />
                  </Button>
                </div>
              )}
              {editTarget && (
                <div className="comments-composer-context">
                  <Pencil size={13} aria-hidden="true" />
                  <span>{text(COPY.editing)}</span>
                  <Button type="button" variant="ghost" size="icon-sm"
                    onClick={resetComposer} aria-label={text(COPY.cancel)}>
                    <X size={14} />
                  </Button>
                </div>
              )}
              <div className="comments-composer-row">
                <textarea
                  ref={composerInput}
                  className="comments-composer-input"
                  value={draft}
                  maxLength={4000}
                  rows={1}
                  placeholder={text(COPY.placeholder)}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
                <Button
                  type="button"
                  className="comments-composer-send"
                  onClick={submit}
                  disabled={busy || !draft.trim()}
                >
                  {text(editTarget ? COPY.save : COPY.send)}
                </Button>
              </div>
              <AnimatePresence>
                {composerError && (
                  <motion.p
                    className="comments-composer-error"
                    role="alert"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {composerError}
                  </motion.p>
                )}
              </AnimatePresence>
            </div>
          )}
        </footer>
      </motion.div>
    </motion.div>
  );
}
