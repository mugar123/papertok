import { useState, useEffect, useRef } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getScientificReport } from '../../services/scientificReportService';
import { getCategoryGradient } from '../../data/categories';
import { FileText, Calendar, Award, BookOpen, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink } from 'lucide-react';
import './ScientificReport.css';

export default function ScientificReport({ onOpenPdf, onSaveToList }) {
  const [timeframe, setTimeframe] = useState('7d');
  const [report, setReport] = useState({ mainDiscovery: null, highlights: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const {
    likedPaperIds,
    savedPaperIds,
    readPaperIds,
    toggleLike,
    markNotInterested,
    markAsRead,
    trackViewTime,
    trackSkip
  } = useFeed();

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    getScientificReport(timeframe)
      .then((data) => {
        if (isMounted) {
          setReport(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Error fetching report:', err);
        if (isMounted) {
          setError('No se pudo cargar el reporte científico. Por favor, reinténtalo.');
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [timeframe]);

  const getTimeframeLabel = () => {
    switch (timeframe) {
      case '24h': return 'del día';
      case '7d': return 'de la semana';
      case '30d': return 'del mes';
      case '1y': return 'del año';
      case '10y': return 'de la década';
      default: return 'de la semana';
    }
  };

  const getTimeframeContextText = () => {
    switch (timeframe) {
      case '24h': return 'Mostrando los descubrimientos científicos más relevantes publicados durante las últimas 24 horas.';
      case '7d': return 'Mostrando los descubrimientos científicos más relevantes publicados durante la última semana.';
      case '30d': return 'Mostrando los descubrimientos científicos más relevantes publicados durante el último mes.';
      case '1y': return 'Mostrando los descubrimientos científicos más relevantes publicados durante el último año.';
      case '10y': return 'Mostrando los descubrimientos científicos más relevantes publicados durante la última década.';
      default: return 'Mostrando los descubrimientos científicos más relevantes publicados durante la última semana.';
    }
  };

  const handleShareHero = (paper) => {
    const url = paper.pdfUrl || paper.landingPageUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '');
    if (navigator.share) {
      navigator.share({ title: paper.title, url });
    } else {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const mainPaper = report.mainDiscovery;
  const gradient = mainPaper ? getCategoryGradient(mainPaper.primaryCategory || '') : 'var(--gradient-brand)';

  return (
    <div className="report-page">
      {/* Time Selector Container */}
      <div className="report-header">
        <div className="report-selector-pill glass-strong">
          {[
            { id: '24h', label: '24 h' },
            { id: '7d', label: '7 días' },
            { id: '30d', label: '30 días' },
            { id: '1y', label: '1 año' },
            { id: '10y', label: '10 años' }
          ].map((option) => (
            <button
              key={option.id}
              className={`report-selector-tab ${timeframe === option.id ? 'active' : ''}`}
              onClick={() => setTimeframe(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="report-context-text">{getTimeframeContextText()}</p>
      </div>

      {loading ? (
        <div className="report-loading-container">
          <div className="report-spinner" />
          <p>Compilando edición estable del reporte...</p>
        </div>
      ) : error ? (
        <div className="report-error-container">
          <p>{error}</p>
          <button className="report-retry-btn" onClick={() => setTimeframe(timeframe)}>
            Reintentar
          </button>
        </div>
      ) : (
        <div className="report-content">
          {/* Main Discovery Section */}
          {mainPaper && (
            <div className="report-hero-section">
              <h2 className="report-section-title">Descubrimiento {getTimeframeLabel()}</h2>
              <div 
                className="report-hero-card glass-strong"
                style={{ '--hero-gradient': gradient }}
              >
                {/* Decorative background overlay */}
                <div className="report-hero-bg" />
                <div className="report-hero-bg-overlay" />

                <div className="report-hero-body">
                  {/* Badges and metadata */}
                  <div className="report-hero-meta">
                    <span className="report-hero-badge report-hero-badge--primary">
                      {mainPaper.primaryCategory ? mainPaper.primaryCategory.toUpperCase() : 'CIENCIA'}
                    </span>
                    <span className="report-hero-meta-item">
                      <Calendar size={14} />
                      {mainPaper.year}
                    </span>
                    {mainPaper.citationCount > 0 && (
                      <span className="report-hero-meta-item">
                        <Award size={14} />
                        {mainPaper.citationCount} Citas
                      </span>
                    )}
                  </div>

                  {/* Title */}
                  <h1 className="report-hero-title">{mainPaper.title}</h1>

                  {/* Authors */}
                  <div className="report-hero-authors">
                    {mainPaper.authors?.map((a, i) => (
                      <span key={i} className="report-hero-author">
                        {a.name || a}
                        {i < Math.min(mainPaper.authors.length, 3) - 1 ? ', ' : ''}
                      </span>
                    ))}
                    {mainPaper.authors?.length > 3 && <span> et al.</span>}
                  </div>

                  {/* Journal or publication venue */}
                  {mainPaper.journal && (
                    <div className="report-hero-journal">
                      <BookOpen size={14} />
                      <span>{mainPaper.journal}</span>
                    </div>
                  )}

                  {/* Badges block */}
                  <div className="report-hero-badges-row">
                    {mainPaper.publicationType === 'preprint' || mainPaper.publicationStatus === 'preprint' ? (
                      <span className="report-badge report-badge-preprint">
                        <FileText size={12} /> Preprint
                      </span>
                    ) : (
                      <>
                        <span className="report-badge report-badge-verified">
                          <BadgeCheck size={12} /> Verified
                        </span>
                        {mainPaper.doi && (
                          <a 
                            href={`https://doi.org/${mainPaper.doi}`} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="report-badge report-badge-doi"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink size={12} /> DOI
                          </a>
                        )}
                      </>
                    )}

                    {mainPaper.openAccess ? (
                      <span className="report-badge report-badge-oa">
                        <Unlock size={12} /> Open Access
                      </span>
                    ) : (
                      <span className="report-badge report-badge-sub">
                        <Lock size={12} /> Subscription
                      </span>
                    )}
                  </div>

                  {/* Full official abstract */}
                  <div className="report-hero-abstract">
                    <p>{mainPaper.abstract}</p>
                  </div>

                  {/* Action buttons */}
                  <div className="report-hero-actions">
                    <button
                      className="pc-read-btn"
                      onClick={() => {
                        const hasValidPdf = mainPaper.pdfUrl && (mainPaper.pdfUrl.includes('arxiv.org') || mainPaper.pdfUrl.toLowerCase().endsWith('.pdf'));
                        if (mainPaper.arxivId || hasValidPdf) {
                          onOpenPdf(mainPaper);
                        } else if (mainPaper.pdfUrl || mainPaper.landingPageUrl) {
                          window.open(mainPaper.pdfUrl || mainPaper.landingPageUrl, '_blank');
                        }
                      }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <span>{(!mainPaper.pdfUrl && !mainPaper.arxivId) ? 'Abrir fuente' : 'Leer artículo'}</span>
                    </button>

                    <button
                      className="pc-read-btn pc-read-btn--secondary"
                      onClick={() => handleShareHero(mainPaper)}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      {copied ? <><Check size={16} /> Copiado</> : <><Share2 size={16} /> Compartir</>}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Highlighted Papers Section */}
          {report.highlights?.length > 0 && (
            <div className="report-highlights-section">
              <h2 className="report-section-title">Otras Investigaciones Destacadas</h2>
              <div className="report-highlights-list-editorial">
                {report.highlights.map((paper, index) => (
                  <div 
                    key={paper.id} 
                    className="report-highlight-card glass-strong"
                    onClick={() => {
                      const hasValidPdf = paper.pdfUrl && (paper.pdfUrl.includes('arxiv.org') || paper.pdfUrl.toLowerCase().endsWith('.pdf'));
                      if (paper.arxivId || hasValidPdf) {
                        onOpenPdf(paper);
                      } else if (paper.pdfUrl || paper.landingPageUrl) {
                        window.open(paper.pdfUrl || paper.landingPageUrl, '_blank');
                      }
                    }}
                  >
                    <div className="report-highlight-number">
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div className="report-highlight-content">
                      <div className="report-highlight-meta">
                        <span className="rh-category">
                          {paper.primaryCategory ? paper.primaryCategory.toUpperCase() : 'CIENCIA'}
                        </span>
                        <span className="rh-bullet">•</span>
                        <span>{paper.year}</span>
                        {paper.journal && (
                          <>
                            <span className="rh-bullet">•</span>
                            <span>{paper.journal}</span>
                          </>
                        )}
                      </div>
                      
                      <h3 className="report-highlight-title">{paper.title}</h3>
                      
                      <div className="report-highlight-authors">
                        {paper.authors?.slice(0, 3).map(a => a.name || a).join(', ')}
                        {paper.authors?.length > 3 ? ' et al.' : ''}
                      </div>
                      
                      <p className="report-highlight-abstract">
                        {paper.abstract}
                      </p>
                      
                      <div className="report-highlight-footer">
                        <div className="rh-badges">
                          {paper.openAccess && (
                            <span className="rh-badge rh-badge-oa">
                              <Unlock size={10} /> OA
                            </span>
                          )}
                          {paper.citationCount > 0 && (
                            <span className="rh-badge rh-badge-cites">
                              <Award size={10} /> {paper.citationCount} citas
                            </span>
                          )}
                        </div>
                        <span className="rh-read-btn">
                          Leer artículo 
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12h14M12 5l7 7-7 7"/>
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
