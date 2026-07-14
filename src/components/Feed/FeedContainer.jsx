import { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { useFeed } from '../../context/FeedContext';

import PaperCard from './PaperCard';
import SkeletonCard from './SkeletonCard';
import AnimatedAtom from './AnimatedAtom';
import './FeedContainer.css';

let savedFeedScroll = 0;

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

  // Implement mouse wheel scroll snapping on desktop
  useEffect(() => {
    const container = feedRef.current;
    if (!container) return;

    const handleWheel = (e) => {
      // If currently scrolling/transitioning, lock wheel
      if (isScrollingRef.current) {
        e.preventDefault();
        return;
      }

      // Filter out small tracks/vibrations
      if (Math.abs(e.deltaY) < 15) return;

      e.preventDefault();

      const direction = e.deltaY > 0 ? 1 : -1;
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
