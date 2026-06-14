import { useRef, useEffect, useCallback, useState } from 'react';
import { useFeed } from '../../context/FeedContext';
import PaperCard from './PaperCard';
import SkeletonCard from './SkeletonCard';
import './FeedContainer.css';

export default function FeedContainer({ onOpenPdf, onSaveToList }) {
  const { papers, loading, error, hasMore, loadMore, refreshFeed } = useFeed();
  const feedRef = useRef(null);
  const sentinelRef = useRef(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

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
    setIsRefreshing(true);
    refreshFeed();
    setTimeout(() => setIsRefreshing(false), 1000);
  }, [refreshFeed]);

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

  if (!loading && papers.length === 0) {
    return (
      <div className="feed-empty">
        <div className="feed-empty-icon">📭</div>
        <h2>No hay papers aún</h2>
        <p>Prueba a ampliar tus categorías de interés</p>
        <button className="feed-retry-btn" onClick={handleRefresh}>
          Recargar feed
        </button>
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
              onOpenPdf={() => onOpenPdf(paper)}
              onSaveToList={() => onSaveToList(paper)}
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

      {/* Floating refresh button */}
      <button
        className={`feed-refresh-btn glass ${isRefreshing ? 'feed-refresh-btn--spinning' : ''}`}
        onClick={handleRefresh}
        title="Recargar feed"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2v6h-6" />
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M3 22v-6h6" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
      </button>
    </div>
  );
}
