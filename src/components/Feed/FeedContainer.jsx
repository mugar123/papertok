import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';

import PaperCard from './PaperCard';
import SkeletonCard from './SkeletonCard';
import {
  MOUNT_WINDOW_IDLE_TIMEOUT_MS,
  MOUNT_WINDOW_RADIUS,
  MOUNT_WINDOW_RESUME_RADIUS,
  MOUNT_WINDOW_SETTLE_MS,
  growMountWindow,
  inMountWindow,
  initialMountWindow,
  mountWindowCovers,
  resumeIndex,
} from '../../utils/feedMountWindow.js';
import AnimatedAtom from './AnimatedAtom';
import { FEED_DISPLAY_STATES, feedAtomVeilCopy, getFeedDisplayState } from '../../utils/feedLoadingState';
import { createFeedResumeMemory } from '../../utils/feedResumeMemory.js';
import './FeedContainer.css';

// Per-surface memory of the card each feed was left on: the Siguiendo feed
// shares this container with For You and must not clobber its place. The
// paper's id is what the restore actually follows (utils/feedMountWindow.js):
// the index is only as good as the order it was taken from, and Following's
// order can move between two visits. The memory writes through to
// sessionStorage once the scroll settles, so it outlives the reload the tab
// gives itself after a deploy (utils/feedResumeMemory.js).
const resumeMemory = createFeedResumeMemory();
const SCROLL_IDLE_DELAY_MS = 120;
const SCROLL_INTERACTION_SETTLE_MS = 220;

// The `<main>` landmark is opt-in (via the `landmark` prop) rather than baked
// into every return: GuestFeedPage already renders its own `<main>` around
// this component, so an unconditional one here would nest two landmarks and
// produce invalid HTML. Only the consumer that is the actual route root
// (App.jsx's `/`) passes `landmark`. The skeleton and main-feed branches are
// the only two states with real content worth landmark-and-heading, and they
// share this wrapper instead of duplicating the conditional.
/**
 * How the atom gives way to the paper.
 *
 * The atom screen and the feed were two return branches of this component,
 * so React swapped one for the other in a single frame: the atom, then a
 * paper composing in, with nothing between. The screen is now a veil laid
 * over the same container the cards mount into, and it leaves as the first
 * card composes: the ground fades over 0.42 s while the atom shrinks and
 * rises out of the way and the copy settles, on the curve everything on the
 * card arrives with. Labels rather than objects on the children: inside a
 * variant tree a child animates on the parent's label, not on an object of
 * its own, so the atom's `gone` plays the frame the veil's does.
 */
const ATOM_VEIL_VARIANTS = {
  shown: { opacity: 1 },
  gone: { opacity: 0, transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] } },
};
const ATOM_VARIANTS = {
  shown: { opacity: 1, scale: 1, y: 0 },
  gone: { opacity: 0, scale: 0.62, y: -16, transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] } },
};
const ATOM_COPY_VARIANTS = {
  shown: { opacity: 1, y: 0 },
  gone: { opacity: 0, y: 6, transition: { duration: 0.24, ease: [0.4, 0, 1, 1] } },
};
const ATOM_VEIL_REDUCED_VARIANTS = {
  shown: { opacity: 1 },
  gone: { opacity: 0, transition: { duration: 0.12 } },
};

function FeedLandmark({ landmark, children }) {
  if (!landmark) {
    return <div className="feed-wrapper">{children}</div>;
  }
  return (
    <main className="feed-wrapper" aria-label={landmark.label}>
      <h1 className="visually-hidden">{landmark.heading}</h1>
      {children}
    </main>
  );
}

/**
 * `source` swaps WHERE the papers come from while every interaction (like,
 * save, read, view tracking) keeps flowing into the recommendation profile
 * through useFeed. Shape: { papers, loading, error, hasMore, loadMore,
 * refresh, isRefreshing, emptyState, endCard, showFollowReason, onPaperViewed }.
 *
 * `endCard` is a node the source appends as one more snap item once the feed
 * has genuinely run out — same height, same snapping, same swipe. The guest
 * feed uses it to end on a sign-up card instead of on nothing.
 */
export default function FeedContainer({ onOpenPdf, onSaveToList, onOpenComments = null, source = null, scrollKey = 'forYou', landmark = null }) {
  const feed = useFeed();
  const { language, isEnglish } = useLanguage();
  const publicMode = Boolean(source?.publicMode);
  const onAuthRequired = source?.onAuthRequired;
  const analyticsSurface = source?.surface || (scrollKey === 'following' ? 'following' : 'feed');
  const {
    trackPdfOpened,
    likedPaperIds, savedPaperIds, readPaperIds, interactionIdFor, toggleLike, markNotInterested, markAsRead, unmarkAsRead,
    trackViewTime, trackSkip, trackSkips: trackSkippedPapers,
  } = feed;
  const papers = source ? source.papers : feed.papers;
  const loading = source ? source.loading : feed.loading;
  const error = source ? source.error : feed.error;
  const hasMore = source ? Boolean(source.hasMore) : feed.hasMore;
  const loadMore = useMemo(
    () => (source ? (source.loadMore || (() => {})) : feed.loadMore),
    [source, feed.loadMore],
  );
  const refreshFeed = useMemo(
    () => (source ? (source.refresh || (() => {})) : feed.refreshFeed),
    [source, feed.refreshFeed],
  );
  const isRefreshing = source ? Boolean(source.isRefreshing) : feed.isRefreshing;
  // Only once nothing more is coming: a page still loading or still pending
  // would put the ending in front of papers the guest has not seen yet.
  const endCard = source?.endCard ?? null;
  const showEndCard = Boolean(endCard) && papers.length > 0 && !loading && !hasMore;
  const prefersReducedMotion = useReducedMotion();

  const handleViewTime = useCallback((paper, seconds) => {
    if (publicMode) return;
    source?.onPaperViewed?.(paper);
    trackViewTime(paper, seconds);
  }, [publicMode, source, trackViewTime]);
  const feedRef = useRef(null);
  const sentinelRef = useRef(null);
  const [showLoader, setShowLoader] = useState(false);
  const [initialFeedReady, setInitialFeedReady] = useState(false);
  // The cards mounted right now: a window around the card this feed was left
  // on, grown outwards in idle chunks until it covers every paper. Mounting
  // the whole feed in the same commit as the tab switch was what blocked the
  // main thread for ~200 ms at a time and froze the transition.
  // Read by the scroll handler, which must not be re-created on every
  // papers change; refreshed after each commit, which is before any scroll.
  const papersRef = useRef(papers);
  useEffect(() => { papersRef.current = papers; }, [papers]);
  const [mountWindow, setMountWindow] = useState(
    () => {
      const saved = resumeMemory.get(scrollKey);
      return initialMountWindow({
        total: papers.length,
        anchorIndex: resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index }),
        radius: saved.paperId ? MOUNT_WINDOW_RESUME_RADIUS : MOUNT_WINDOW_RADIUS,
      });
    },
  );
  // When this container mounted: the first growth of the window waits out the
  // page transition from here (feedMountWindow.js says why). Stamped in an
  // effect, not during render — the clock is not a pure read — so `null`
  // means "this commit".
  const mountedAtRef = useRef(null);
  useEffect(() => {
    mountedAtRef.current = performance.now();
  }, []);
  // Papers that arrive after the first render (a first load, a source that
  // answers late) find an empty window: derive one anchored on the resumed
  // card, or it would grow from the top and leave that card a blank slot
  // until it got there. Derived, not set in an effect, so the first paint
  // with papers already has the right cards in it.
  const anchoredWindow = useMemo(() => {
    if (mountWindow.hi !== 0 || papers.length === 0) return mountWindow;
    const saved = resumeMemory.get(scrollKey);
    return initialMountWindow({
      total: papers.length,
      anchorIndex: resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index }),
      radius: saved.paperId ? MOUNT_WINDOW_RESUME_RADIUS : MOUNT_WINDOW_RADIUS,
    });
  }, [mountWindow, papers, scrollKey]);
  useEffect(() => {
    if (mountWindowCovers(anchoredWindow, papers.length)) return undefined;
    // `requestIdleCallback` where it exists, so a chunk never lands inside a
    // frame the transition or a scroll needs; a short timeout elsewhere. The
    // idle wait itself starts once the page transition has had its time: a
    // chunk scheduled straight after mount ran inside the entrance (idle, as
    // the browser saw it) and froze it for the length of the task.
    const schedule = typeof window.requestIdleCallback === 'function'
      ? (fn) => window.requestIdleCallback(fn, { timeout: MOUNT_WINDOW_IDLE_TIMEOUT_MS })
      : (fn) => setTimeout(fn, 32);
    const cancel = typeof window.cancelIdleCallback === 'function'
      ? (id) => window.cancelIdleCallback(id)
      : (id) => clearTimeout(id);
    const sinceMount = mountedAtRef.current === null ? 0 : performance.now() - mountedAtRef.current;
    let handle = null;
    const timer = setTimeout(() => {
      handle = schedule(() => setMountWindow(growMountWindow(anchoredWindow, papers.length)));
    }, Math.max(0, MOUNT_WINDOW_SETTLE_MS - sinceMount));
    return () => {
      clearTimeout(timer);
      if (handle !== null) cancel(handle);
    };
  }, [anchoredWindow, papers.length]);
  const initialLoadStartedRef = useRef(false);
  const scrollIdleTimerRef = useRef(null);
  const skipFlushTimerRef = useRef(null);
  const pendingSkippedPapersRef = useRef(new Map());
  const getInteractionState = useCallback((paper) => publicMode ? {} : ({
    isLiked: likedPaperIds.has(interactionIdFor(paper)),
    isSaved: savedPaperIds.has(interactionIdFor(paper)),
    isRead: readPaperIds?.has(interactionIdFor(paper)),
  }), [interactionIdFor, likedPaperIds, publicMode, readPaperIds, savedPaperIds]);

  const flushPendingSkips = useCallback(() => {
    if (publicMode) {
      pendingSkippedPapersRef.current.clear();
      return;
    }
    const skippedPapers = Array.from(pendingSkippedPapersRef.current.values());
    pendingSkippedPapersRef.current.clear();
    if (skippedPapers.length === 0) return;

    if (trackSkippedPapers) {
      void trackSkippedPapers(skippedPapers);
      return;
    }
    skippedPapers.forEach((paper) => void trackSkip(paper));
  }, [publicMode, trackSkip, trackSkippedPapers]);

  const schedulePendingSkipFlush = useCallback(() => {
    if (skipFlushTimerRef.current) clearTimeout(skipFlushTimerRef.current);
    skipFlushTimerRef.current = setTimeout(flushPendingSkips, SCROLL_INTERACTION_SETTLE_MS);
  }, [flushPendingSkips]);

  const handleSkip = useCallback((paper) => {
    if (publicMode) return;
    source?.onPaperViewed?.(paper);
    if (!paper?.id) return;
    pendingSkippedPapersRef.current.set(paper.id, paper);
    schedulePendingSkipFlush();
  }, [publicMode, schedulePendingSkipFlush, source]);

  // Restore scroll position instantly before browser paints. Must run only once
  // per mount: re-assigning scrollTop on later papers.length changes (infinite
  // scroll appends) cancels any in-flight momentum and makes scrolling stutter.
  const restoreAttemptedRef = useRef(false);
  useLayoutEffect(() => {
    if (restoreAttemptedRef.current || papers.length === 0) return;
    restoreAttemptedRef.current = true;
    const saved = resumeMemory.get(scrollKey);
    // A place restored from storage after a reload has an index and no pixel
    // offset; either says there is somewhere to go back to.
    if (feedRef.current && (saved.scrollTop > 0 || saved.index > 0)) {
      const el = feedRef.current;
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto'; // Force instant jump
      // The paper the reader was on, wherever it is in this order; each
      // snap item is one container height tall, so the card's index is its
      // offset. The raw offset only stands in when the height is unknown.
      const index = resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index });
      el.scrollTop = el.clientHeight > 0 ? index * el.clientHeight : saved.scrollTop;

      requestAnimationFrame(() => {
        el.style.scrollBehavior = prevBehavior;
      });
    }
  }, [papers, scrollKey]);

  useEffect(() => {
    if (loading) initialLoadStartedRef.current = true;
    if (papers.length > 0 || error || (initialLoadStartedRef.current && !loading)) {
      setInitialFeedReady(true);
    }
  }, [error, loading, papers.length]);

  // Only show the atom loader if loading takes more than 1.5s
  useEffect(() => {
    if (papers.length === 0 && loading && !error) {
      const timer = setTimeout(() => setShowLoader(true), 1500);
      return () => clearTimeout(timer);
    }
    const hideTimer = setTimeout(() => setShowLoader(false), 0);
    return () => clearTimeout(hideTimer);
  }, [papers.length, loading, error]);

  // Scroll to top when feed is refreshed manually or mode changes
  useEffect(() => {
    if (isRefreshing && feedRef.current) {
      feedRef.current.scrollTo({ top: 0, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
  }, [isRefreshing, prefersReducedMotion]);

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      if (skipFlushTimerRef.current) clearTimeout(skipFlushTimerRef.current);
      // Leaving mid-settle (a tab switch right after a fling) must not lose
      // the place the settle timer was about to write.
      resumeMemory.persist(scrollKey);
    };
  }, [scrollKey]);

  // Infinite scroll: observe sentinel element
  useEffect(() => {
    const root = feedRef.current;
    if (!sentinelRef.current || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      {
        root,
        // Two viewports of runway, not five: loadPapers' per-source fetch is
        // capped at FEED_SOURCE_RENDER_BUDGET_MS (4 s worst case, see
        // FeedContext.jsx) and a typical reader spends far longer than that on
        // two cards, so this still starts the next page well before the
        // sentinel's own card is reached. If it ever isn't enough, the
        // `loading && <SkeletonCard />` snap item below is the fallback, not a
        // dead end. Five viewports only bought DOM bloat on mobile.
        rootMargin: '0px 0px 200% 0px',
        threshold: 0,
      }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const isScrollingRef = useRef(false);

  // Wheel and trackpad input stay entirely native. CSS scroll snapping keeps
  // cards aligned without a non-passive listener blocking momentum scrolling.

  // Implement keyboard arrow navigation on desktop
  useEffect(() => {
    const handleKeyDown = (e) => {
      const container = feedRef.current;
      if (!container) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const activeTarget = e.target instanceof Element ? e.target : null;
        const isInteractive = activeTarget?.closest(
          'input, textarea, select, button, a, summary, [contenteditable="true"], [role="textbox"], [role="button"], [role="link"]',
        );
        const hasOpenModal = document.querySelector('[aria-modal="true"]');
        if (isInteractive || hasOpenModal) return;

        e.preventDefault();
        if (isScrollingRef.current) return;

        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const cardHeight = container.clientHeight;
        const currentScroll = container.scrollTop;
        const currentIndex = Math.round(currentScroll / cardHeight);
        const nextIndex = currentIndex + direction;

        const itemCount = papers.length + (loading ? 1 : 0) + (showEndCard ? 1 : 0);
        if (nextIndex >= 0 && nextIndex < itemCount) {
          isScrollingRef.current = true;
          container.scrollTo({
            top: nextIndex * cardHeight,
            behavior: prefersReducedMotion ? 'auto' : 'smooth'
          });

          setTimeout(() => {
            isScrollingRef.current = false;
          }, prefersReducedMotion ? 0 : 700);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [papers.length, loading, prefersReducedMotion, showEndCard]);

  const handleRefresh = useCallback(() => {
    refreshFeed();
  }, [refreshFeed]);

  const handleOpenPdf = useCallback((paper) => {
    if (!publicMode) trackPdfOpened(paper);
    onOpenPdf(paper);
  }, [onOpenPdf, publicMode, trackPdfOpened]);

  const handleSaveToList = useCallback((paper) => {
    onSaveToList(paper);
  }, [onSaveToList]);

  const handleScroll = useCallback((event) => {
    const container = event.currentTarget;
    const index = container.clientHeight > 0
      ? Math.round(container.scrollTop / container.clientHeight)
      : 0;
    resumeMemory.remember(scrollKey, {
      scrollTop: container.scrollTop,
      index,
      paperId: papersRef.current[index]?.id || resumeMemory.get(scrollKey).paperId,
    });
    if (!container.classList.contains('feed-container--scrolling')) {
      container.classList.add('feed-container--scrolling');
    }

    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(() => {
      container.classList.remove('feed-container--scrolling');
      // One storage write per settled scroll, not one per scroll event.
      resumeMemory.persist(scrollKey);
    }, SCROLL_IDLE_DELAY_MS);

    if (pendingSkippedPapersRef.current.size > 0) {
      schedulePendingSkipFlush();
    }
  }, [schedulePendingSkipFlush, scrollKey]);

  const displayState = getFeedDisplayState({
    hasPapers: papers.length > 0,
    loading,
    error,
    isRefreshing,
    showLoader,
    // A source says for itself whether it is still on its first load (the
    // Following feed does); the main feed derives it from its own history.
    initialLoadPending: (source ? Boolean(source.initialLoadPending) : !initialFeedReady) && !error,
    hasSourceEmptyState: Boolean(source?.emptyState),
  });
  const atomVeil = feedAtomVeilCopy({ displayState, loading, isRefreshing });

  if (displayState === FEED_DISPLAY_STATES.ERROR) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-icon">⚠️</div>
        <h2>{isEnglish ? 'Error loading papers' : 'Error cargando papers'}</h2>
        <p>{getUiErrorMessage(error, language, 'FEED_LOAD_FAILED')}</p>
        <button className="feed-retry-btn" onClick={handleRefresh}>
          {isEnglish ? 'Try again' : 'Reintentar'}
        </button>
      </div>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.SKELETON) {
    return (
      <FeedLandmark landmark={landmark}>
        <div className="feed-container">
          <div className="feed-snap-item"><SkeletonCard /></div>
        </div>
      </FeedLandmark>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.SOURCE_EMPTY) {
    // Alternative sources bring their own empty state; Siguiendo must never
    // fall back to the generic For You copy that asks users to broaden their interests.
    return <div className="feed-empty">{source.emptyState}</div>;
  }

  if (displayState === FEED_DISPLAY_STATES.EMPTY && !atomVeil) {
    return (
      <div className="feed-empty">
        <div className="atom-loader">
          <AnimatedAtom size={80} strokeWidth={1} className="atom-loader-icon" />
        </div>
        <h2>{isEnglish ? 'Searching for discoveries...' : 'Buscando descubrimientos...'}</h2>
        <p>
          {isEnglish
            ? 'There are no papers in your categories yet. Try broadening your interests.'
            : 'Aún no hay papers en tus categorías. Prueba a ampliar tus intereses.'}
        </p>
        <button className="feed-retry-btn" onClick={handleRefresh}>
          {isEnglish ? 'Explore again' : 'Explorar de nuevo'}
        </button>
      </div>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.FEED || atomVeil) {
  return (
    <FeedLandmark landmark={landmark}>
      <div className="feed-container" ref={feedRef} onScroll={handleScroll}>
        {papers.map((paper, index) => (
          !inMountWindow(anchoredWindow, index) ? (
            // Outside the mount window: a full-height slot, so the scroll
            // extent and the snap points are already those of the finished
            // feed. It becomes a card when the window reaches it.
            <div key={paper.id} className="feed-snap-item feed-snap-item--pending" aria-hidden="true" />
          ) : (
          <div key={paper.id} className="feed-snap-item">
            <PaperCard
              paper={paper}
              isLiked={!publicMode && likedPaperIds.has(interactionIdFor(paper))}
              isSaved={!publicMode && savedPaperIds.has(interactionIdFor(paper))}
              isRead={!publicMode && readPaperIds?.has(interactionIdFor(paper))}
              onLike={toggleLike}
              onNotInterested={markNotInterested}
              onMarkAsRead={markAsRead}
              onUnmarkAsRead={unmarkAsRead}
              trackViewTime={handleViewTime}
              trackSkip={handleSkip}
              onOpenPdf={handleOpenPdf}
              onSaveToList={handleSaveToList}
              onOpenComments={onOpenComments}
              getInteractionState={getInteractionState}
              showFollowReason={Boolean(source?.showFollowReason)}
              publicMode={publicMode}
              onAuthRequired={onAuthRequired}
              analyticsSurface={analyticsSurface}
              position={index + 1}
              // The scroll hint belongs to the first card only, and this prop is
              // the only thing that decides it now: a
              // `.feed-snap-item:not(:first-child) .pc-scroll-hint { display:
              // none }` CSS rule used to do the same job by DOM position, which
              // meant every other mounted card still rendered the hint and
              // relied on that rule (and, off screen, on `content-visibility`)
              // to keep it invisible. That rule is gone — first-card-only is
              // decided here, once, instead of being re-derived in CSS.
              hideScrollHint={index !== 0}
            />
          </div>
          )
        ))}

        {loading && (
          <div className="feed-snap-item">
            <SkeletonCard />
          </div>
        )}

        {showEndCard && (
          <div className="feed-snap-item feed-snap-item--end">{endCard}</div>
        )}

        {/* Sentinel for infinite scroll */}
        {hasMore && <div ref={sentinelRef} className="feed-sentinel" />}
      </div>

      {/* The wait, over the container rather than instead of it. While the
          papers are on their way this is the whole screen; the frame they
          land, the cards mount underneath and this recedes over them. */}
      <AnimatePresence>
        {atomVeil && (
          <motion.div
            key="atom-veil"
            className="feed-empty feed-empty--veil"
            role="status"
            aria-live="polite"
            aria-busy="true"
            variants={prefersReducedMotion ? ATOM_VEIL_REDUCED_VARIANTS : ATOM_VEIL_VARIANTS}
            initial={false}
            animate="shown"
            exit="gone"
          >
            <motion.div className="atom-loader" aria-hidden="true" variants={prefersReducedMotion ? undefined : ATOM_VARIANTS}>
              <AnimatedAtom size={80} strokeWidth={1} className="atom-loader-icon" />
            </motion.div>
            <motion.div className="feed-empty-copy" variants={prefersReducedMotion ? undefined : ATOM_COPY_VARIANTS}>
              <h2>
                {atomVeil === 'gathering'
                  ? (isEnglish ? 'Gathering papers...' : 'Sintetizando papers...')
                  : (isEnglish ? 'Searching for discoveries...' : 'Buscando descubrimientos...')}
              </h2>
              <p>
                {isEnglish
                  ? 'Connecting to scientific sources to bring you the latest research'
                  : 'Conectando con las fuentes para traer lo último en ciencia'}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </FeedLandmark>
  );
  }

  return null;
}
