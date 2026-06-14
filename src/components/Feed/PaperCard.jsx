import { useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getCategoryLabel, getCategoryGradient, CATEGORIES } from '../../data/categories';
import { Share2, Clock, FileText, Check } from 'lucide-react';
import Latex from 'react-latex-next';
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
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now - date;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays === 0) return 'Hoy';
      if (diffDays === 1) return 'Ayer';
      if (diffDays < 7) return `Hace ${diffDays} días`;
      if (diffDays < 30) return `Hace ${Math.floor(diffDays / 7)} sem`;
      return date.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' });
    } catch { return ''; }
  };

  const formatAuthors = (authors) => {
    if (!authors || authors.length === 0) return '';
    if (authors.length <= 2) return authors.join(' & ');
    return `${authors[0]} et al.`;
  };

  const getReadTime = (text) => {
    if (!text) return 1;
    const words = text.split(/\s+/).length;
    return Math.max(1, Math.ceil(words / 200));
  };

  // Get area info for the gradient background
  const getAreaInfo = () => {
    const cat = paper.primaryCategory || '';
    const prefix = cat.split('.')[0].split('-')[0];
    for (const [key, area] of Object.entries(CATEGORIES)) {
      if (area.subcategories && area.subcategories[cat]) {
        return area;
      }
      // Try prefix match
      const subcatKeys = Object.keys(area.subcategories || {});
      if (subcatKeys.some(k => k.startsWith(prefix))) {
        return area;
      }
    }
    return { icon: FileText, gradient: 'linear-gradient(135deg, #667eea, #764ba2)' };
  };

  const areaInfo = getAreaInfo();

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isLiked) {
        toggleLike(paper);
        setShowHeart(true);
        setTimeout(() => setShowHeart(false), 1200);
      }
    }
    lastTap.current = now;
  }, [isLiked, toggleLike, paper]);

  const handleLike = (e) => {
    e.stopPropagation();
    toggleLike(paper);
    if (!isLiked) {
      setShowHeart(true);
      setTimeout(() => setShowHeart(false), 1200);
    }
  };

  const handleShare = async (e) => {
    e.stopPropagation();
    const url = `https://arxiv.org/abs/${paper.arxivId}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: paper.title, url });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      window.open(url, '_blank');
    }
  };

  const handleNotInterested = (e) => {
    e.stopPropagation();
    markNotInterested(paper);
  };

  const categoryLabel = getCategoryLabel(paper.primaryCategory);
  const readTime = getReadTime(paper.summary);

  return (
    <div className="pc" onClick={handleDoubleTap}>
      {/* Immersive gradient background */}
      <div className="pc-bg" style={{ background: areaInfo.gradient }} />
      <div className="pc-bg-overlay" />

      {/* Floating category icon */}
      <div className="pc-area-icon"><areaInfo.icon size={80} strokeWidth={1.5} /></div>

      {/* Content area - bottom aligned like TikTok */}
      <div className="pc-body">
        {/* Meta row */}
        <div className="pc-meta">
          <span className="pc-category-pill">{categoryLabel}</span>
          <span className="pc-meta-dot">·</span>
          <span className="pc-date">{formatDate(paper.published)}</span>
          <span className="pc-meta-dot">·</span>
          <span className="pc-readtime" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Clock size={12} /> {readTime} min
          </span>
        </div>

        {/* Title */}
        <h2 className="pc-title">
          <Latex>{paper.title}</Latex>
        </h2>

        {/* Authors */}
        <div className="pc-authors">
          <div className="pc-author-avatars">
            {(paper.authors || []).slice(0, 3).map((author, i) => (
              <div key={i} className="pc-author-avatar" style={{ '--i': i }}>
                {author.charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
          <span className="pc-author-names">{formatAuthors(paper.authors)}</span>
        </div>

        {/* Abstract */}
        <div
          className={`pc-abstract ${expanded ? 'pc-abstract--open' : ''}`}
          onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        >
          <p><Latex>{paper.summary}</Latex></p>
          {!expanded && paper.summary && paper.summary.length > 200 && (
            <div className="pc-abstract-fade" />
          )}
        </div>

        {!expanded && paper.summary && paper.summary.length > 200 && (
          <button className="pc-expand-btn" onClick={(e) => { e.stopPropagation(); setExpanded(true); }}>
            Leer más ↓
          </button>
        )}
        {expanded && (
          <button className="pc-expand-btn" onClick={(e) => { e.stopPropagation(); setExpanded(false); }}>
            Mostrar menos ↑
          </button>
        )}

        {/* arXiv ID */}
        <span className="pc-arxiv-id">arXiv:{paper.arxivId}</span>

        {/* Bottom action bar */}
        <div className="pc-action-bar">
          <button className="pc-read-btn" onClick={(e) => { e.stopPropagation(); onOpenPdf(); }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            Leer Paper
          </button>
          <button
            className="pc-read-btn pc-read-btn--secondary"
            onClick={(e) => { e.stopPropagation(); handleShare(e); }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {copied ? <><Check size={16} /> Copiado</> : <><Share2 size={16} /> Compartir</>}
          </button>
        </div>
      </div>

      {/* Side actions (TikTok style) */}
      <div className="pc-side-actions">
        <button className={`pc-side-btn ${isLiked ? 'pc-side-btn--liked' : ''}`} onClick={handleLike}>
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isLiked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </div>
          <span>Me gusta</span>
        </button>

        <button className={`pc-side-btn ${isSaved ? 'pc-side-btn--saved' : ''}`} onClick={(e) => { e.stopPropagation(); onSaveToList(); }}>
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <span>Guardar</span>
        </button>

        <button className="pc-side-btn pc-side-btn--skip" onClick={handleNotInterested}>
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <span>Pasar</span>
        </button>
      </div>

      {/* Double-tap heart */}
      {showHeart && (
        <div className="pc-heart-burst">
          <svg viewBox="0 0 24 24" fill="#ff2d55" width="90" height="90">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <div className="pc-heart-ring" />
        </div>
      )}

      {/* Scroll hint on first card */}
      <div className="pc-scroll-hint">
        <div className="pc-scroll-hint-arrow">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>
    </div>
  );
}
