import type { PointerEvent, UIEvent } from 'react';
import type { Paper } from '../../models/paper.ts';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ArrowsClockwise, Intersect, X } from '@phosphor-icons/react';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../onboarding/petri.tsx';
import ScientificText from '../scientific-text.ts';
import FeedContainer from './feed-container.tsx';
import SkeletonCard from './skeleton-card.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useOverlayHistory } from '../../hooks/use-overlay-history.ts';
import { loadSimilarPapers } from '../../services/similar-feed-service.ts';
import { withoutNotInterested } from '../../utils/following-feed.ts';
import { isSignInRequiredError } from '../../utils/sign-in-required.ts';
import './similar-feed-layer.css';

// How far the header has to be pulled down for letting go to close the layer.
const DRAG_CLOSE_PX = 96;

type Phase = 'finding' | 'classifying' | 'ready' | 'error';
interface Load { for: Paper; attempt: number; phase: Phase; papers: Paper[]; unclassified: number; error?: unknown }

/** The rail button's box as a clip of the full-screen layer: what it grows out of and folds back into. */
function clipFrom(origin: HTMLElement) {
  const box = origin.isConnected ? origin.getBoundingClientRect() : null;
  if (!box || box.width === 0) return 'inset(50% 50% 50% 50% round 3px)';
  return `inset(${box.top}px ${window.innerWidth - box.right}px ${window.innerHeight - box.bottom}px ${box.left}px round 3px)`;
}

/**
 * The papers Semantic Scholar recommends for `anchor`, as a feed of their own
 * in a full-screen layer over the page. It grows out of the card's Similar button and
 * folds back into it, so the feed underneath never moves: closing it — the X,
 * Escape, Back, or pulling the header down — leaves the reader on the card
 * they left. Nothing is shown until every paper has been classified
 * (similar-feed-service.ts, PAP-50); until then the layer is a skeleton.
 */
export default function SimilarFeedLayer({ anchor, origin, onClosed, onOpenPdf, onSaveToList }: {
  onOpenPdf?: (paper: Paper) => void;
  onSaveToList?: (paper: Paper) => void;
  anchor: Paper;
  origin: HTMLElement;
  onClosed: () => void;
}) {
  const { notInterestedIds } = useFeed();
  const [open, setOpen] = useState(true);
  const [originClip, setOriginClip] = useState(() => clipFrom(origin));
  const [droppedBy, setDroppedBy] = useState<'fold' | 'drag'>('fold');
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ from: number; by: number } | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  // A topic, author or project link on a card in the layer navigates the page
  // underneath. The layer then has nothing left to return to: it goes with
  // the page it was opened over, quietly, instead of hiding the new one.
  const { key: routeKey } = useLocation();
  const [openedOn] = useState(routeKey);
  const routeLeft = routeKey !== openedOn;
  const shown = open && !routeLeft;

  const requestClose = useCallback(() => {
    setOriginClip(clipFrom(origin));
    setOpen(false);
  }, [origin]);
  useOverlayHistory(shown, requestClose, 'similar');

  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  useEffect(() => {
    let cancelled = false;
    const settle = (patch: Pick<Load, 'phase'> & Partial<Load>) => {
      if (!cancelled) setLoad({ for: anchor, attempt, papers: [], unclassified: 0, ...patch });
    };
    loadSimilarPapers(anchor, () => settle({ phase: 'classifying' }))
      .then(({ papers, unclassified }) => settle({ phase: 'ready', papers, unclassified }))
      .catch((error) => {
        if (cancelled) return;
        console.error('Similar papers did not load', error);
        settle({ phase: 'error', error });
      });
    return () => { cancelled = true; };
  }, [anchor, attempt]);
  const current = load?.for === anchor && load.attempt === attempt ? load : null;
  const phase: Phase = current?.phase || 'finding';
  const papers = useMemo(
    () => withoutNotInterested(current?.papers || [], notInterestedIds),
    [current, notInterestedIds],
  );

  // The counter follows the feed's own scroller, which reports nothing upward.
  const [active, setActive] = useState({ for: anchor, index: 0 });
  const activeIndex = active.for === anchor ? active.index : 0;
  const followScroll = (event: UIEvent<HTMLElement>) => {
    const scroller = event.target as HTMLElement;
    if (!scroller.classList?.contains('feed-container') || !scroller.clientHeight) return;
    const index = Math.round(scroller.scrollTop / scroller.clientHeight);
    if (index !== activeIndex) setActive({ for: anchor, index });
  };
  const status = phase === 'finding' ? 'Finding…'
    : phase === 'classifying' ? 'Classifying…'
      : phase === 'ready' && papers.length ? `${Math.min(activeIndex, papers.length - 1) + 1} / ${papers.length}` : '';

  const retry = () => setAttempt(value => value + 1);
  const retryAction = (
    <Button size="sm" onClick={retry}>
      <ArrowsClockwise size={16} aria-hidden="true" />
      {'Try again'}
    </Button>
  );
  const closeAction = useMemo(
    () => <Button size="sm" onClick={requestClose}>{'Close similar papers'}</Button>,
    [requestClose],
  );
  const source = useMemo(() => {
    const left = current?.unclassified || 0;
    const leftOut = left ? ` ${left} more could not be classified, so ${left === 1 ? 'it is' : 'they are'} not shown.` : '';
    return {
      papers,
      loading: false,
      hasMore: false,
      surface: 'similar',
      endCard: (
        <EmptyState className="similar-end" icon art={<Intersect />} title={'No more similar papers'} actions={closeAction}>
          {`That was every similar paper for this one.${leftOut}`}
        </EmptyState>
      ),
      emptyState: (
        <EmptyState role="status" icon art={<Intersect />} title={'No similar papers left'} actions={closeAction}>
          {'You skipped every paper recommended for this one.'}
        </EmptyState>
      ),
    };
  }, [papers, current, closeAction]);

  let body;
  if (phase === 'finding' || phase === 'classifying') {
    body = (
      <div className="feed-wrapper">
        <div className="feed-container">
          <div className="feed-snap-item"><SkeletonCard /></div>
        </div>
      </div>
    );
  } else if (phase === 'error') {
    body = (
      <div className="feed-empty">
        {isSignInRequiredError(current?.error) ? (
          <EmptyState role="status" art={<Petri pose="upset" className="feed-error-petri" />} title={'Similar papers need an account'} actions={closeAction}>
            {'Sign in to see them.'}
          </EmptyState>
        ) : (
          <EmptyState role="alert" art={<Petri pose="upset" className="feed-error-petri" />} title={'Similar papers did not load'} actions={retryAction}>
            {'The rest of PaperTok keeps working.'}
          </EmptyState>
        )}
      </div>
    );
  } else if (!current?.papers.length) {
    body = (
      <div className="feed-empty">
        {current?.unclassified ? (
          <EmptyState role="alert" art={<Petri pose="upset" className="feed-error-petri" />} title={'Similar papers could not be classified'} actions={retryAction}>
            {'Their fields did not load in time. Try again in a moment.'}
          </EmptyState>
        ) : (
          <EmptyState role="status" art={<Petri pose="star" className="feed-error-petri" />} title={'No similar papers'} actions={closeAction}>
            {'Semantic Scholar has no recommendations for this paper yet.'}
          </EmptyState>
        )}
      </div>
    );
  } else {
    body = (
      <FeedContainer
        source={source}
        scrollKey={`similar:${anchor.id}`}
        onOpenPdf={onOpenPdf}
        onSaveToList={onSaveToList}
      />
    );
  }

  // Touch only: a mouse has the X and Escape, and a drag would fight text selection.
  // The pull is written straight to the layer's style: a React state per
  // pointer move re-rendered the whole feed inside it on every frame.
  const pullTo = (px: number) => layerRef.current?.style.setProperty('--similar-drag', `${px}px`);
  const startDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' || (event.target as Element).closest('button')) return;
    drag.current = { from: event.clientY, by: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current.by = Math.max(0, event.clientY - drag.current.from);
    pullTo(drag.current.by);
  };
  const endDrag = () => {
    if (!drag.current) return;
    const { by } = drag.current;
    drag.current = null;
    setDragging(false);
    if (by > DRAG_CLOSE_PX) {
      setDroppedBy('drag');
      setOpen(false);
    } else {
      pullTo(0);
    }
  };

  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => { if (!next) requestClose(); }}
      onOpenChangeComplete={(next) => { if (!next) onClosed(); }}
      modal
      disablePointerDismissal
    >
      <DialogContent
        ref={layerRef}
        className={`similar-layer${dragging ? ' is-dragging' : ''}`}
        overlayClassName="similar-scrim"
        showClose={false}
        initialFocus={titleRef}
        // Back to the button it grew from, even when the press left no focus
        // behind to restore (Safari does not focus a clicked button).
        finalFocus={() => (origin.isConnected ? origin : true)}
        aria-label={`Papers similar to ${anchor.title}`}
        data-dropped-by={routeLeft ? 'route' : droppedBy}
        style={{ '--similar-origin': originClip }}
        onScrollCapture={followScroll}
      >
        <header
          className="similar-head"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="similar-grab" aria-hidden="true" />
          <Button variant="ghost" size="icon" className="similar-close" onClick={requestClose} aria-label="Close similar papers" title="Close">
            <X size={18} aria-hidden="true" />
          </Button>
          <div className="similar-context">
            <span className="similar-kicker"><Intersect size={13} aria-hidden="true" />{'Similar to'}</span>
            <span ref={titleRef} className="similar-anchor" tabIndex={-1}>
              <ScientificText>{anchor.title}</ScientificText>
            </span>
          </div>
          {/* Keyed by phase, so each step of the wait arrives as a new word. */}
          <span key={phase} className="similar-status" data-pending={phase === 'finding' || phase === 'classifying' || undefined}>{status}</span>
        </header>
        <div className="similar-body">{body}</div>
        {/* Mounted with the layer, so the wait and its end are both spoken;
            a failure speaks through its own alert. */}
        <span className="visually-hidden" role="status">
          {phase === 'finding' ? 'Finding similar papers…'
            : phase === 'classifying' ? 'Classifying similar papers…'
              : phase === 'ready' && papers.length ? `${papers.length} similar ${papers.length === 1 ? 'paper' : 'papers'}` : ''}
        </span>
      </DialogContent>
    </Dialog>
  );
}
