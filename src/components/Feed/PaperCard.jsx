import { useState, useRef, useCallback, useMemo } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getCategoryLabel, getCategoryGradient, CATEGORIES } from '../../data/categories';
import { Share2, Clock, FileText, Check, Atom, Monitor, Calculator, Dna, BarChart2, TrendingUp, Zap, CircleDollarSign, Brain, Cpu, Database, Orbit, Microscope, FlaskConical, Network, Sigma, Binary, Activity, BadgeCheck, Eye, CheckCircle2 } from 'lucide-react';
import AnimatedAtom from './AnimatedAtom';
import Latex from 'react-latex-next';
import './PaperCard.css';

// Pool of icons for the background constellation per area
const AREA_BG_ICONS = {
  physics: [AnimatedAtom, Orbit, Zap, Activity, FlaskConical, Microscope],
  cs: [Monitor, Cpu, Database, Brain, Network, Binary],
  math: [Calculator, Sigma, Activity, Orbit, Brain, Network],
  'q-bio': [Dna, Microscope, FlaskConical, Activity, Brain, Database],
  stat: [BarChart2, TrendingUp, Sigma, Activity, Database, Brain],
  econ: [TrendingUp, BarChart2, CircleDollarSign, Activity, Network, Sigma],
  eess: [Zap, Monitor, Activity, Cpu, Network, Orbit],
  'q-fin': [CircleDollarSign, TrendingUp, BarChart2, Network, Sigma, Activity],
};

export default function PaperCard({ paper, onOpenPdf, onSaveToList }) {
  const { toggleLike, markNotInterested, markAsRead, likedPaperIds, savedPaperIds, readPaperIds } = useFeed();
  const [expanded, setExpanded] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isMarkingRead, setIsMarkingRead] = useState(false);
  const lastTap = useRef(0);

  const isLiked = likedPaperIds.has(paper.id);
  const isSaved = savedPaperIds.has(paper.id);
  const isRead = readPaperIds?.has(paper.id) || isMarkingRead;

  const handleMarkAsRead = (e) => {
    e.stopPropagation();
    setIsMarkingRead(true);
    setTimeout(() => {
      markAsRead(paper);
    }, 400); // give time for animation before unmounting
  };

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
      if (diffDays >= 365) return date.toLocaleDateString('es-ES', { month: 'short', day: 'numeric', year: 'numeric' });
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

  // Generate scattered background icons (stable per paper id)
  const bgIcons = useMemo(() => {
    // Find the area key for this paper
    const cat = paper.primaryCategory || '';
    let areaKey = 'physics';
    for (const [key, area] of Object.entries(CATEGORIES)) {
      if (area.subcategories && area.subcategories[cat]) {
        areaKey = key;
        break;
      }
    }
    const iconPool = AREA_BG_ICONS[areaKey] || AREA_BG_ICONS.physics;
    // Seed RNG based on paper id for consistency
    let seed = 0;
    for (let i = 0; i < (paper.id || '').length; i++) seed += paper.id.charCodeAt(i);
    const seededRandom = (i) => {
      const x = Math.sin(seed + i * 127.1) * 43758.5453;
      return x - Math.floor(x);
    };
    return Array.from({ length: 12 }).map((_, i) => ({
      id: i,
      Icon: iconPool[i % iconPool.length],
      x: 5 + seededRandom(i * 2) * 90,          // 5%-95%
      y: 5 + seededRandom(i * 2 + 1) * 60,       // top 5-65% (above content)
      size: 18 + seededRandom(i * 3) * 40,        // 18-58px
      opacity: 0.03 + seededRandom(i * 4) * 0.06, // 0.03-0.09
      delay: seededRandom(i * 5) * 6,             // 0-6s
      duration: 10 + seededRandom(i * 6) * 8,     // 10-18s
      rotate: seededRandom(i * 7) * 360,          // 0-360deg
    }));
  }, [paper.id, paper.primaryCategory]);

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

      {/* Floating category icon constellation */}
      <div className="pc-bg-constellation">
        {bgIcons.map((item) => (
          <span
            key={item.id}
            className="pc-bg-icon"
            style={{
              '--bg-x': `${item.x}%`,
              '--bg-y': `${item.y}%`,
              '--bg-delay': `${item.delay}s`,
              '--bg-duration': `${item.duration}s`,
              '--bg-rotate': `${item.rotate}deg`,
              '--bg-opacity': item.Icon === AnimatedAtom ? Math.max(item.opacity, 0.10) : item.opacity,
            }}
          >
            <item.Icon size={item.size} strokeWidth={1} />
          </span>
        ))}
      </div>

      {/* Animated mesh grid lines */}
      <svg className="pc-mesh" viewBox="0 0 400 400" preserveAspectRatio="none">
        <line x1="0" y1="80" x2="400" y2="120" className="pc-mesh-line" style={{ '--mesh-delay': '0s' }} />
        <line x1="50" y1="0" x2="350" y2="200" className="pc-mesh-line" style={{ '--mesh-delay': '1s' }} />
        <line x1="400" y1="0" x2="0" y2="300" className="pc-mesh-line" style={{ '--mesh-delay': '2s' }} />
        <line x1="200" y1="0" x2="100" y2="400" className="pc-mesh-line" style={{ '--mesh-delay': '3s' }} />
        <line x1="0" y1="200" x2="400" y2="350" className="pc-mesh-line" style={{ '--mesh-delay': '0.5s' }} />
        <line x1="300" y1="0" x2="380" y2="400" className="pc-mesh-line" style={{ '--mesh-delay': '1.5s' }} />
        <circle cx="80" cy="90" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '0s' }} />
        <circle cx="320" cy="140" r="2.5" className="pc-mesh-dot" style={{ '--mesh-delay': '1s' }} />
        <circle cx="200" cy="60" r="1.5" className="pc-mesh-dot" style={{ '--mesh-delay': '2s' }} />
        <circle cx="150" cy="220" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '3s' }} />
        <circle cx="350" cy="280" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '0.5s' }} />
        <circle cx="50" cy="300" r="1.5" className="pc-mesh-dot" style={{ '--mesh-delay': '1.5s' }} />
      </svg>

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
          <div className="pc-author-names" style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatAuthors(paper.authors)}</span>
            {(paper.doi || paper.journalRef) && (
              <BadgeCheck 
                size={14} 
                className="pc-verified-badge" 
                style={{ color: '#1da1f2', flexShrink: 0, cursor: 'help' }} 
                title="Este artículo está verificado"
              />
            )}
          </div>
          {/* Verification Ticker moved to the right of authors */}
          {(paper.doi || paper.journalRef) && (
            <div 
              className={`pc-journal-ticker ${paper.doi ? 'pc-journal-ticker--clickable' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (paper.doi) window.open(`https://doi.org/${paper.doi}`, '_blank');
              }}
            >
              <BadgeCheck size={14} className="pc-journal-ticker-icon" />
              <div className="pc-journal-ticker-text-wrapper">
                <div className="pc-journal-ticker-text">
                  <span>{paper.journalRef ? `Publicado en ${paper.journalRef}` : 'Peer-reviewed'} {paper.doi && `• DOI: ${paper.doi}`}</span>
                </div>
              </div>
            </div>
          )}
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

        <button className={`pc-side-btn ${isRead ? 'pc-side-btn--read' : ''}`} onClick={handleMarkAsRead}>
          <div className="pc-side-icon">
            {isRead ? <CheckCircle2 size={24} color="#10b981" /> : <Eye size={24} />}
          </div>
          <span>Leer</span>
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
