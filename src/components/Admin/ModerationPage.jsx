import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, ShieldWarning } from '@phosphor-icons/react';
import { useLanguage } from '../../context/LanguageContext';
import { deleteComment, fetchComment } from '../../services/commentService.js';
import {
  fetchOpenReports,
  parseCommentTargetPath,
  readModerationConfig,
  setCommentVisibility,
  setCommentsFrozen,
  setReportStatus,
} from '../../services/reportService.js';
import { Checkbox } from '../ui/checkbox.jsx';
import { Label } from '../ui/label.jsx';
import './ModerationPage.css';

/**
 * The admin's queue, sized for one person: a FIFO page of open reports, four
 * verbs per row (hide/show, delete, resolve, dismiss), and the killswitch.
 * The route is unlisted rather than secret — for anyone who is not the admin
 * uid wired into the rules, the very first query is denied and the page says
 * so. Authorization lives in the rules; this screen only renders it.
 */

const COPY = {
  title: { en: 'Moderation' },
  back: { en: 'Back' },
  loading: { en: 'Loading...' },
  refresh: { en: 'Refresh' },
  unauthorized: {
    en: 'This account is not the admin. The queue is invisible to any other.',
  },
  empty: { en: 'No open reports. Nothing to review.' },
  error: { en: 'The queue could not be loaded.' },
  killswitch: { en: 'Freeze comments across the app' },
  killswitchHint: {
    en: 'While on, nobody can create comments or threads. No deploy involved.',
  },
  reportedBy: { en: 'Reported by' },
  targetGone: { en: 'The content no longer exists.' },
  targetNotComment: { en: 'Report about a paper stub (possible duplicate).' },
  openPaper: { en: 'Open paper' },
  hide: { en: 'Hide' },
  show: { en: 'Show' },
  hiddenNow: { en: 'Hidden' },
  deleteTarget: { en: 'Delete comment' },
  deleteConfirm: { en: 'Delete it? Replies go too.' },
  confirm: { en: 'Yes, delete' },
  cancel: { en: 'Cancel' },
  resolve: { en: 'Resolve' },
  dismiss: { en: 'Dismiss' },
  actionError: { en: 'The action failed. Try again.' },
};

function formatWhen(value, locale) {
  const date = typeof value?.toDate === 'function' ? value.toDate() : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function ModerationPage() {
  const navigate = useNavigate();
  const { locale } = useLanguage();
  const text = useCallback(entry => entry.en, []);
  const killswitchId = useId();

  const [state, setState] = useState({ status: 'loading', reports: [] });
  const [targets, setTargets] = useState({});
  const [frozen, setFrozen] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(null);
  const [feedback, setFeedback] = useState('');

  // The initial state is already 'loading'; the refresh button re-arms it in
  // its own handler, so the effect never needs a synchronous setState.
  useEffect(() => {
    let active = true;
    (async () => {
      const reports = await fetchOpenReports();
      if (!active) return;
      setState({ status: 'ready', reports });
      const config = await readModerationConfig().catch(() => null);
      if (active && config) setFrozen(config.commentsFrozen);

      // Resolve each reported comment once: text and current status, so the
      // row shows what the report is about without leaving the queue.
      const entries = await Promise.all(reports.map(async (report) => {
        const target = parseCommentTargetPath(report.targetPath);
        if (!target) return [report.targetPath, { kind: 'other' }];
        const comment = await fetchComment(target.paperKey, target.commentId).catch(() => null);
        return [report.targetPath, comment
          ? { kind: 'comment', ...target, comment }
          : { kind: 'gone', ...target }];
      }));
      if (active) setTargets(Object.fromEntries(entries));
    })().catch((error) => {
      if (!active) return;
      if (error?.code === 'permission-denied') setState({ status: 'unauthorized', reports: [] });
      else {
        console.error('The moderation queue could not be loaded', error);
        setState({ status: 'error', reports: [] });
      }
    });
    return () => { active = false; };
  }, [attempt]);

  const act = async (action) => {
    setFeedback('');
    try {
      await action();
    } catch (error) {
      console.error('Moderation action failed', error);
      setFeedback(text(COPY.actionError));
    }
  };

  const toggleFreeze = () => act(async () => {
    const next = !frozen;
    await setCommentsFrozen(next);
    setFrozen(next);
  });

  const closeReport = (report, status) => act(async () => {
    await setReportStatus(report.id, status);
    setState(previous => ({
      ...previous,
      reports: previous.reports.filter(entry => entry.id !== report.id),
    }));
  });

  const toggleHidden = (report, target) => act(async () => {
    const nextVisible = target.comment.status === 'hidden';
    await setCommentVisibility(report.targetPath, nextVisible);
    setTargets(previous => ({
      ...previous,
      [report.targetPath]: {
        ...target,
        comment: { ...target.comment, status: nextVisible ? 'visible' : 'hidden' },
      },
    }));
  });

  const deleteTarget = (report, target) => act(async () => {
    await deleteComment({
      paperKey: target.paperKey,
      commentId: target.commentId,
      isReply: Boolean(target.comment.replyTo),
    });
    setTargets(previous => ({
      ...previous,
      [report.targetPath]: { kind: 'gone', paperKey: target.paperKey, commentId: target.commentId },
    }));
  });

  return (
    <main className="moderation-page">
      <div className="moderation-shell">
        <header className="moderation-header">
          <button type="button" className="moderation-back" onClick={() => navigate('/settings')} aria-label={text(COPY.back)}>
            <ArrowLeft size={18} />
          </button>
          <h1>{text(COPY.title)}</h1>
          <button
            type="button"
            className="moderation-refresh"
            onClick={() => {
              setState(previous => ({ ...previous, status: 'loading' }));
              setAttempt(value => value + 1);
            }}
            aria-label={text(COPY.refresh)}
          >
            <ArrowClockwise size={16} />
          </button>
        </header>

        {state.status === 'ready' && frozen !== null && (
          <div className="moderation-killswitch">
            <Checkbox id={killswitchId} checked={frozen} onCheckedChange={toggleFreeze} />
            <Label htmlFor={killswitchId}>
              <strong>{text(COPY.killswitch)}</strong>
              <small>{text(COPY.killswitchHint)}</small>
            </Label>
          </div>
        )}

        {feedback && <p className="moderation-feedback" role="alert">{feedback}</p>}

        {state.status === 'loading' && (
          <p className="moderation-state" aria-busy="true">{text(COPY.loading)}</p>
        )}
        {state.status === 'unauthorized' && (
          <div className="moderation-state">
            <ShieldWarning size={22} aria-hidden="true" />
            <p>{text(COPY.unauthorized)}</p>
          </div>
        )}
        {state.status === 'error' && (
          <p className="moderation-state">{text(COPY.error)}</p>
        )}
        {state.status === 'ready' && state.reports.length === 0 && (
          <p className="moderation-state">{text(COPY.empty)}</p>
        )}

        {state.status === 'ready' && state.reports.length > 0 && (
          <ul className="moderation-list">
            {state.reports.map((report) => {
              const target = targets[report.targetPath];
              return (
                <li key={report.id} className="moderation-item">
                  <div className="moderation-item-meta">
                    <span className="moderation-chip">{report.reason}</span>
                    <span>{formatWhen(report.createdAt, locale)}</span>
                    <span>{text(COPY.reportedBy)} {report.reporterUid}</span>
                  </div>
                  {report.note && <p className="moderation-note">“{report.note}”</p>}

                  {!target && <p className="moderation-target">{text(COPY.loading)}</p>}
                  {target?.kind === 'gone' && <p className="moderation-target">{text(COPY.targetGone)}</p>}
                  {target?.kind === 'other' && (
                    <p className="moderation-target">
                      {text(COPY.targetNotComment)} <code>{report.targetPath}</code>
                    </p>
                  )}
                  {target?.kind === 'comment' && (
                    <blockquote className="moderation-target moderation-target--comment">
                      <span className="moderation-target-author">
                        @{target.comment.authorHandle}
                        {target.comment.status === 'hidden' && (
                          <em> · {text(COPY.hiddenNow)}</em>
                        )}
                      </span>
                      {target.comment.text}
                    </blockquote>
                  )}

                  <div className="moderation-actions">
                    {(target?.kind === 'comment' || target?.kind === 'gone' || target?.kind === 'other') && (
                      <Link
                        className="moderation-action"
                        to={`/public/paper/${encodeURIComponent(target.paperKey ?? parseCommentTargetPath(report.targetPath)?.paperKey ?? report.targetPath.replace(/^papers\//, ''))}`}
                      >
                        <ArrowSquareOut size={13} aria-hidden="true" /> {text(COPY.openPaper)}
                      </Link>
                    )}
                    {target?.kind === 'comment' && (
                      <>
                        <button type="button" className="moderation-action" onClick={() => toggleHidden(report, target)}>
                          {target.comment.status === 'hidden' ? text(COPY.show) : text(COPY.hide)}
                        </button>
                        {confirming === report.id ? (
                          <>
                            <span className="moderation-item-meta">{text(COPY.deleteConfirm)}</span>
                            <button type="button" className="moderation-action moderation-action--danger"
                              onClick={() => { setConfirming(null); deleteTarget(report, target); }}>
                              {text(COPY.confirm)}
                            </button>
                            <button type="button" className="moderation-action" onClick={() => setConfirming(null)}>
                              {text(COPY.cancel)}
                            </button>
                          </>
                        ) : (
                          <button type="button" className="moderation-action moderation-action--danger"
                            onClick={() => setConfirming(report.id)}>
                            {text(COPY.deleteTarget)}
                          </button>
                        )}
                      </>
                    )}
                    <button type="button" className="moderation-action" onClick={() => closeReport(report, 'resolved')}>
                      {text(COPY.resolve)}
                    </button>
                    <button type="button" className="moderation-action" onClick={() => closeReport(report, 'dismissed')}>
                      {text(COPY.dismiss)}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}
