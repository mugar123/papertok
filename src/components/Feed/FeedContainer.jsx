import { useRef, useEffect, useCallback, useState } from 'react';
import { useFeed } from '../../context/FeedContext';
import AnimatedAtom from './AnimatedAtom';
import PaperCard from './PaperCard';
import SkeletonCard from './SkeletonCard';
import AuthorPanel from './AuthorPanel';
import './FeedContainer.css';

export default function FeedContainer({ onOpenPdf, onSaveToList }) {
  const { 
    papers, loading, error, hasMore, loadMore, refreshFeed, isRefreshing, trackPdfOpened,
    likedPaperIds, savedPaperIds, readPaperIds, toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip
  } = useFeed();
  const feedRef = useRef(null);
  const sentinelRef = useRef(null);
  const [showLoader, setShowLoader] = useState(false);
  const [activeAuthors, setActiveAuthors] = useState(null);

  // Only show the atom loader if loading takes more than 1.5s
  useEffect(() => {
    if (papers.length === 0 && loading && !error) {
      const timer = setTimeout(() => setShowLoader(true), 1500);
      return () => clearTimeout(timer);
    }
    setShowLoader(false);
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

  const handleOpenAuthors = useCallback((authors) => {
    setActiveAuthors(authors);
  }, []);

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
      <div className="feed-container" ref={feedRef}>
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
              onOpenAuthors={handleOpenAuthors}
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

      {activeAuthors && (
        <AuthorPanel 
          authors={activeAuthors} 
          onClose={() => setActiveAuthors(null)} 
          onOpenPdf={(paper) => {
            trackPdfOpened(paper);
            setActiveAuthors(null);
            onOpenPdf(paper);
          }} 
        />
      )}
    </div>
  );
}
