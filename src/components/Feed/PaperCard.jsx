import { useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getCategoryLabel, getCategoryGradient } from '../../data/categories';
import './PaperCard.css';

export default function PaperCard({ paper, onOpenPdf, onSaveToList }) {
  const { toggleLike, markNotInterested, likedPaperIds, savedPaperIds } = useFeed();
  const [expanded, setExpanded] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastTap = useRef(0);

  const isLiked = likedPaperIds.has(paper.id);
  const isSaved = savedPaperIds.has(paper.id);

  const formatDate = (dateStr) => {
    try {
      return new Date(dateStr).toLocaleDateString('es-ES', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatAuthors = (authors) => {
    if (authors.length <= 3) return authors.join(', ');
    return `${authors.slice(0, 3).join(', ')} et al.`;
  };

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isLiked) {
        toggleLike(paper);
        setShowHeart(true);
        setTimeout(() => setShowHeart(false), 1000);
      }
    }
    lastTap.current = now;
  }, [isLiked, toggleLike, paper]);

  const handleLike = () => {
    toggleLike(paper);
    if (!isLiked) {
      setShowHeart(true);
      setTimeout(() => setShowHeart(false), 1000);
    }
  };

  const handleShare = async () => {
    const url = `https://arxiv.org/abs/${paper.arxivId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.open(url, '_blank');
    }
  };

  const handleNotInterested = () => {
    markNotInterested(paper);
  };

  const categoryLabel = getCategoryLabel(paper.primaryCategory);
  const gradient = getCategoryGradient(paper.primaryCategory);

  return (
    <div className="paper-card" onClick={handleDoubleTap}>
      {/* Gradient header accent */}
      <div className="paper-card-gradient" style={{ background: gradient }} />

      {/* Top bar */}
      <div className="paper-card-top">
        <span className="paper-card-badge" style={{ background: gradient }}>
          {categoryLabel}
        </span>
        <span className="paper-card-date">{formatDate(paper.published)}</span>
      </div>

      {/* Content */}
      <div className="paper-card-content">
        <h2 className="paper-card-title">{paper.title}</h2>

        <p className="paper-card-authors">
          por {formatAuthors(paper.authors)}
        </p>

        <div className={`paper-card-abstract ${expanded ? 'paper-card-abstract--expanded' : ''}`}>
          <p>{paper.summary}</p>
        </div>

        {!expanded && paper.summary.length > 300 && (
          <button
            className="paper-card-expand"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            Leer más...
          </button>
        )}
        {expanded && (
          <button
            className="paper-card-expand"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(false);
            }}
          >
            Mostrar menos
          </button>
        )}

        {paper.arxivId && (
          <span className="paper-card-id">arXiv: {paper.arxivId}</span>
        )}
      </div>

      {/* Action buttons - right side TikTok style */}
      <div className="paper-card-actions">
        <button
          className={`action-btn action-btn--like ${isLiked ? 'action-btn--active' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleLike(); }}
          title="Me gusta"
        >
          <svg viewBox="0 0 24 24" fill={isLiked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <span className="action-label">Me gusta</span>
        </button>

        <button
          className={`action-btn action-btn--save ${isSaved ? 'action-btn--active' : ''}`}
          onClick={(e) => { e.stopPropagation(); onSaveToList(); }}
          title="Guardar"
        >
          <svg viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <span className="action-label">Guardar</span>
        </button>

        <button
          className="action-btn action-btn--read"
          onClick={(e) => { e.stopPropagation(); onOpenPdf(); }}
          title="Leer PDF"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <span className="action-label">Leer</span>
        </button>

        <button
          className="action-btn action-btn--notinterested"
          onClick={(e) => { e.stopPropagation(); handleNotInterested(); }}
          title="No me interesa"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          <span className="action-label">No interesa</span>
        </button>

        <button
          className={`action-btn action-btn--share ${copied ? 'action-btn--copied' : ''}`}
          onClick={(e) => { e.stopPropagation(); handleShare(); }}
          title="Compartir"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          <span className="action-label">{copied ? '¡Copiado!' : 'Compartir'}</span>
        </button>
      </div>

      {/* Double-tap heart overlay */}
      {showHeart && (
        <div className="paper-card-heart-overlay">
          <svg viewBox="0 0 24 24" fill="var(--accent-like)" width="80" height="80">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
      )}
    </div>
  );
}
