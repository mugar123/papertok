import { useState, useEffect } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getScientificReport } from '../../services/scientificReportService';
import CustomDateSelector from './CustomDateSelector';
import PaperCard from '../Feed/PaperCard';
import { getCategoryGradient } from '../../data/categories';
import { Calendar, Award, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink, FileText, ArrowRight, BarChart3, TrendingUp, X } from 'lucide-react';
import './ScientificReport.css';

export default function ScientificReport({ onOpenPdf, onSaveToList }) {
  const [timeframe, setTimeframe] = useState('7d');
  const [report, setReport] = useState({ mainDiscovery: null, highlights: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customRange, setCustomRange] = useState(null);
  const [selectedPaper, setSelectedPaper] = useState(null);

  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip
  } = useFeed();

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);
    getScientificReport(timeframe)
      .then((data) => { if (isMounted) { setReport(data); setLoading(false); } })
      .catch((err) => {
        console.error('Error fetching report:', err);
        if (isMounted) { setError('No se pudo cargar el reporte. Reinténtalo.'); setLoading(false); }
      });
    return () => { isMounted = false; };
  }, [timeframe]);

  const getContextText = () => {
    if (typeof timeframe === 'object' && timeframe.type === 'custom') {
      if (timeframe.from === timeframe.to) return `${timeframe.from}`;
      return `${timeframe.from}  —  ${timeframe.to}`;
    }
    return { '24h': 'Últimas 24 horas', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '1y': 'Último año', '10y': 'Última década' }[timeframe] || 'Últimos 7 días';
  };

  const handleShare = (paper) => {
    const url = paper.pdfUrl || paper.landingPageUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '');
    if (navigator.share) { navigator.share({ title: paper.title, url }); }
    else { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const openPaper = (paper) => {
    const hasValidPdf = paper.pdfUrl && (paper.pdfUrl.includes('arxiv.org') || paper.pdfUrl.toLowerCase().endsWith('.pdf'));
    if (paper.arxivId || hasValidPdf) onOpenPdf(paper);
    else if (paper.pdfUrl || paper.landingPageUrl) window.open(paper.pdfUrl || paper.landingPageUrl, '_blank');
  };

  // Compute stats from report data
  const allPapers = [report.mainDiscovery, ...(report.highlights || [])].filter(Boolean);
  const totalPapers = allPapers.length;
  const totalCitations = allPapers.reduce((sum, p) => sum + (p.citationCount || 0), 0);
  const oaCount = allPapers.filter(p => p.openAccess).length;

  const hero = report.mainDiscovery;
  const heroGradient = hero ? getCategoryGradient(hero.primaryCategory || '') : 'var(--gradient-brand)';

  const timeOptions = [
    { id: '24h', label: '24 h' },
    { id: '7d', label: '7 días' },
    { id: '30d', label: '30 días' },
    { id: '1y', label: '1 año' },
    { id: '10y', label: '10 años' },
    { id: 'custom', label: 'Otro' },
  ];

  return (
    <div className="sr">
      {/* Header */}
      <header className="sr-header">
        <div className="sr-header-top">
          <h1 className="sr-masthead">Scientific Report</h1>
          <span className="sr-edition">{getContextText()}</span>
        </div>
        <nav className="sr-tabs">
          {timeOptions.map((o) => (
            <button
              key={o.id}
              className={`sr-tab ${timeframe === o.id || (o.id === 'custom' && customRange) ? 'active' : ''}`}
              onClick={() => {
                if (o.id === 'custom') setShowCustomPicker(p => !p);
                else { setTimeframe(o.id); setCustomRange(null); setShowCustomPicker(false); }
              }}
            >{o.label}</button>
          ))}
        </nav>
      </header>

      {showCustomPicker && (
        <CustomDateSelector
          onApply={(rangeObj) => { setCustomRange(rangeObj); setTimeframe(rangeObj); setShowCustomPicker(false); }}
          onCancel={() => setShowCustomPicker(false)}
        />
      )}

      {loading ? (
        <div className="sr-state"><div className="sr-spinner" /><p>Compilando edición estable...</p></div>
      ) : error ? (
        <div className="sr-state"><p>{error}</p><button className="sr-retry" onClick={() => setTimeframe(timeframe)}>Reintentar</button></div>
      ) : (
        <div className="sr-body">

          {/* Stats Bar */}
          <div className="sr-stats-bar">
            <div className="sr-stat">
              <BarChart3 size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">{totalPapers}</span>
                <span className="sr-stat-label">Artículos seleccionados</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat">
              <TrendingUp size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">{totalCitations.toLocaleString()}</span>
                <span className="sr-stat-label">Citas totales</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat">
              <Unlock size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">{oaCount}/{totalPapers}</span>
                <span className="sr-stat-label">Open Access</span>
              </div>
            </div>
          </div>

          {/* Hero */}
          {hero && (
            <section className="sr-hero" style={{ '--hero-glow': heroGradient }}>
              <div className="sr-hero-glow" />
              <div className="sr-hero-inner">
                <div className="sr-hero-kicker">
                  <span className="sr-kicker-cat">{(hero.primaryCategory || 'Ciencia').toUpperCase()}</span>
                  <span className="sr-kicker-sep" />
                  {hero.journal && <span className="sr-kicker-venue">{hero.journal}</span>}
                  <span className="sr-kicker-year"><Calendar size={13} /> {hero.year}</span>
                </div>
                <h2 className="sr-hero-title">{hero.title}</h2>
                <p className="sr-hero-authors">
                  {hero.authors?.slice(0, 4).map(a => a.name || a).join(', ')}
                  {hero.authors?.length > 4 && ' et al.'}
                </p>
                <div className="sr-hero-tags">
                  {hero.publicationType === 'preprint' || hero.publicationStatus === 'preprint' ? (
                    <span className="sr-tag preprint"><FileText size={12} /> Preprint</span>
                  ) : (
                    <>
                      <span className="sr-tag verified"><BadgeCheck size={12} /> Verified</span>
                      {hero.doi && <a href={`https://doi.org/${hero.doi}`} target="_blank" rel="noopener noreferrer" className="sr-tag doi" onClick={e => e.stopPropagation()}><ExternalLink size={12} /> DOI</a>}
                    </>
                  )}
                  {hero.openAccess
                    ? <span className="sr-tag oa"><Unlock size={12} /> Open Access</span>
                    : <span className="sr-tag sub"><Lock size={12} /> Subscription</span>}
                  {hero.citationCount > 0 && <span className="sr-tag cites"><Award size={12} /> {hero.citationCount} citas</span>}
                </div>
                <blockquote className="sr-hero-abstract">{hero.abstract}</blockquote>
                <div className="sr-hero-actions">
                  <button className="sr-btn primary" onClick={() => setSelectedPaper(hero)}>Ver detalle</button>
                  <button className="sr-btn ghost" onClick={() => handleShare(hero)}>
                    {copied ? <><Check size={15} /> Copiado</> : <><Share2 size={15} /> Compartir</>}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Bento Highlights */}
          {report.highlights?.length > 0 && (
            <section className="sr-highlights">
              <h2 className="sr-section-label">Otras Investigaciones Destacadas</h2>
              <div className="sr-bento">
                {report.highlights.map((paper, i) => {
                  const cat = (paper.categories && paper.categories[0]) || paper.primaryCategory || 'General';
                  const accent = getCategoryGradient(cat);
                  // Pattern: wide, narrow, narrow, wide, narrow, narrow...
                  const isWide = i % 3 === 0;

                  return (
                    <article
                      key={paper.id}
                      className={`sr-bento-card ${isWide ? 'wide' : 'narrow'}`}
                      onClick={() => setSelectedPaper(paper)}
                    >
                      <div className="sr-bento-accent" style={{ background: accent }} />
                      <div className="sr-bento-body">
                        <div className="sr-bento-top">
                          <span className="sr-bento-cat" style={{ background: accent, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                            {cat.split('.')[0]}
                          </span>
                          <span className="sr-bento-year">{paper.year}</span>
                        </div>
                        <h3 className="sr-bento-title">{paper.title}</h3>
                        {isWide && <p className="sr-bento-abstract">{paper.abstract}</p>}
                        <div className="sr-bento-bottom">
                          <div className="sr-bento-tags">
                            {paper.openAccess && <span className="sr-micro oa"><Unlock size={11} /> OA</span>}
                            {paper.citationCount > 0 && <span className="sr-micro">{paper.citationCount} citas</span>}
                            {paper.journal && <span className="sr-micro venue">{paper.journal}</span>}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* Paper Detail Overlay */}
      {selectedPaper && (
        <div className="sr-paper-overlay" onClick={() => setSelectedPaper(null)}>
          <div className="sr-paper-overlay-inner" onClick={(e) => e.stopPropagation()}>
            <button className="sr-overlay-close" onClick={() => setSelectedPaper(null)}>
              <X size={20} />
            </button>
            <div className="sr-paper-card-wrapper">
              <PaperCard
                paper={selectedPaper}
                isLiked={likedPaperIds.has(selectedPaper.id)}
                isSaved={savedPaperIds.has(selectedPaper.id)}
                isRead={readPaperIds.has(selectedPaper.id)}
                onLike={() => toggleLike(selectedPaper.id)}
                onNotInterested={() => { markNotInterested(selectedPaper.id); setSelectedPaper(null); }}
                onMarkAsRead={() => markAsRead(selectedPaper.id)}
                trackViewTime={(t) => trackViewTime(selectedPaper.id, t)}
                trackSkip={() => trackSkip(selectedPaper.id)}
                onOpenPdf={onOpenPdf}
                onSaveToList={onSaveToList}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
