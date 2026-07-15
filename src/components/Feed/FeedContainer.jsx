import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { useFeed } from '../../context/FeedContext';

import PaperCard from './PaperCard';
import SkeletonCard from './SkeletonCard';
import AnimatedAtom from './AnimatedAtom';
import {
  accumulateWheelGesture,
  shouldClampTrackpadMomentum,
  shouldUseNativeWheelScroll,
} from '../../utils/wheelNavigation';
import './FeedContainer.css';

let savedFeedScroll = 0;
const WHEEL_GESTURE_RESET_MS = 180;
const TRACKPAD_GESTURE_RESET_MS = 180;

export default function FeedContainer({ onOpenPdf, onSaveToList }) {
  const { 
    papers, loading, error, hasMore, loadMore, refreshFeed, isRefreshing, trackPdfOpened,
    likedPaperIds, savedPaperIds, readPaperIds, toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip
  } = useFeed();
  const feedRef = useRef(null);
  const sentinelRef = useRef(null);
  const [showLoader, setShowLoader] = useState(false);

  // Restore scroll position instantly before browser paints
  useLayoutEffect(() => {
    if (feedRef.current && papers.length > 0 && savedFeedScroll > 0) {
      const el = feedRef.current;
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto'; // Force instant jump
      el.scrollTop = savedFeedScroll;
      
      requestAnimationFrame(() => {
        el.style.scrollBehavior = prevBehavior;
      });
    }
  }, [papers.length]);

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
      feedRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [isRefreshing]);

  // Infinite scroll: observe sentinel element
  useEffect(() => {
    if (!sentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  const isScrollingRef = useRef(false);
  const wheelDeltaRef = useRef(0);
  const wheelResetTimerRef = useRef(null);
  const trackpadGestureRef = useRef({ startIndex: null, clamped: false });
  const trackpadResetTimerRef = useRef(null);

  // Implement mouse wheel scroll snapping on desktop
  useEffect(() => {
    const container = feedRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;

      const nestedScroller = e.target instanceof Element ? e.target.closest('.pc-abstract--open') : null;
      if (nestedScroller) {
        const canScrollDown = e.deltaY > 0 && nestedScroller.scrollTop + nestedScroller.clientHeight < nestedScroller.scrollHeight - 1;
        const canScrollUp = e.deltaY < 0 && nestedScroller.scrollTop > 1;
        if (canScrollDown || canScrollUp) return;
      }

      // Preserve direct, finger-following scrolling for normal trackpad movement.
      // A very fast swipe can otherwise cross several snap points before settling.
      if (shouldUseNativeWheelScroll(e.deltaMode)) {
        const cardHeight = container.clientHeight;
        const gesture = trackpadGestureRef.current;
        if (gesture.startIndex === null) {
          gesture.startIndex = Math.round(container.scrollTop / cardHeight);
        }

        if (trackpadResetTimerRef.current) clearTimeout(trackpadResetTimerRef.current);
        trackpadResetTimerRef.current = setTimeout(() => {
          trackpadGestureRef.current = { startIndex: null, clamped: false };
        }, TRACKPAD_GESTURE_RESET_MS);

        if (!shouldClampTrackpadMomentum(e.deltaY) && !gesture.clamped) return;

        e.preventDefault();
        if (gesture.clamped) return;

        gesture.clamped = true;
        const direction = e.deltaY > 0 ? 1 : -1;
        const nextIndex = gesture.startIndex + direction;
        if (nextIndex >= 0 && nextIndex < papers.length + (loading ? 1 : 0)) {
          isScrollingRef.current = true;
          container.scrollTo({ top: nextIndex * cardHeight, behavior: 'smooth' });
          setTimeout(() => {
            isScrollingRef.current = false;
          }, 450);
        }
        return;
      }

      e.preventDefault();

      // If currently scrolling/transitioning, lock wheel
      if (isScrollingRef.current) {
        return;
      }

      const deltaMultiplier = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? container.clientHeight
          : 1;
      const normalizedDelta = e.deltaY * deltaMultiplier;
      const gesture = accumulateWheelGesture(wheelDeltaRef.current, normalizedDelta);
      wheelDeltaRef.current = gesture.accumulatedDelta;

      if (wheelResetTimerRef.current) clearTimeout(wheelResetTimerRef.current);
      wheelResetTimerRef.current = setTimeout(() => {
        wheelDeltaRef.current = 0;
      }, WHEEL_GESTURE_RESET_MS);

      if (!gesture.direction) return;

      const direction = gesture.direction;
      const cardHeight = container.clientHeight;
      const currentScroll = container.scrollTop;
      const currentIndex = Math.round(currentScroll / cardHeight);
      const nextIndex = currentIndex + direction;

      if (nextIndex >= 0 && nextIndex < papers.length + (loading ? 1 : 0)) {
        isScrollingRef.current = true;
        container.scrollTo({
          top: nextIndex * cardHeight,
          behavior: 'smooth'
        });

        setTimeout(() => {
          isScrollingRef.current = false;
        }, 700);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (wheelResetTimerRef.current) clearTimeout(wheelResetTimerRef.current);
      if (trackpadResetTimerRef.current) clearTimeout(trackpadResetTimerRef.current);
    };
  }, [papers.length, loading]);

  // Implement keyboard arrow navigation on desktop
  useEffect(() => {
    const handleKeyDown = (e) => {
      const container = feedRef.current;
      if (!container) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (isScrollingRef.current) return;

        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const cardHeight = container.clientHeight;
        const currentScroll = container.scrollTop;
        const currentIndex = Math.round(currentScroll / cardHeight);
        const nextIndex = currentIndex + direction;

        if (nextIndex >= 0 && nextIndex < papers.length + (loading ? 1 : 0)) {
          isScrollingRef.current = true;
          container.scrollTo({
            top: nextIndex * cardHeight,
            behavior: 'smooth'
          });

          setTimeout(() => {
            isScrollingRef.current = false;
          }, 700);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [papers.length, loading]);

  const handleRefresh = useCallback(() => {
    refreshFeed();
  }, [refreshFeed]);

  const handleOpenPdf = useCallback((paper) => {
    trackPdfOpened(paper);
    onOpenPdf(paper);
  }, [onOpenPdf, trackPdfOpened]);

  const handleSaveToList = useCallback((paper) => {
    onSaveToList(paper);
  }, [onSaveToList]);

  if (error && papers.length === 0) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-icon">⚠️</div>
        <h2>Error cargando papers</h2>
        <p>{error}</p>
        <button className="feed-retry-btn" onClick={handleRefresh}>
          Reintentar
        </button>
      </div>
    );
  }

  if (papers.length === 0 && !error) {
    if (loading && !showLoader && !isRefreshing) {
      return (
        <div className="feed-wrapper">
          <div className="feed-container">
            <div className="feed-snap-item"><SkeletonCard /></div>
          </div>
        </div>
      );
    }
    return (
      <div className="feed-empty">
        <div className="atom-loader">
          <AnimatedAtom size={80} strokeWidth={1} className="atom-loader-icon" />
        </div>
        <h2>{loading || isRefreshing ? 'Sintetizando papers...' : 'Buscando descubrimientos...'}</h2>
        <p>{loading || isRefreshing ? 'Conectando con arXiv para traer lo último en ciencia' : 'Aún no hay papers en tus categorías. Prueba a ampliar tus intereses.'}</p>
        {!loading && (
          <button className="feed-retry-btn" onClick={handleRefresh}>
            Explorar de nuevo
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="feed-wrapper">
      <div className="feed-container" ref={feedRef} onScroll={(e) => savedFeedScroll = e.target.scrollTop}>
        {papers.map((paper) => (
          <div key={paper.id} className="feed-snap-item">
            <PaperCard
              paper={paper}
              isLiked={likedPaperIds.has(paper.id)}
              isSaved={savedPaperIds.has(paper.id)}
              isRead={readPaperIds?.has(paper.id)}
              onLike={toggleLike}
              onNotInterested={markNotInterested}
              onMarkAsRead={markAsRead}
              trackViewTime={trackViewTime}
              trackSkip={trackSkip}
              onOpenPdf={handleOpenPdf}
              onSaveToList={handleSaveToList}
            />
          </div>
        ))}

        {loading && (
          <div className="feed-snap-item">
            <SkeletonCard />
          </div>
        )}

        {/* Sentinel for infinite scroll */}
        {hasMore && <div ref={sentinelRef} className="feed-sentinel" />}
      </div>
    </div>
  );
}
