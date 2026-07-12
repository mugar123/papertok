import { useState, useEffect } from 'react';
import { useFeed } from '../../context/FeedContext';
import { getScientificReport } from '../../services/scientificReportService';
import CustomDateSelector from './CustomDateSelector';
import { getCategoryGradient } from '../../data/categories';
import { Calendar, Award, BookOpen, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink, FileText, ArrowRight } from 'lucide-react';
import './ScientificReport.css';

export default function ScientificReport({ onOpenPdf, onSaveToList }) {
  const [timeframe, setTimeframe] = useState('7d');
  const [report, setReport] = useState({ mainDiscovery: null, highlights: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customRange, setCustomRange] = useState(null);

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

    return () => { isMounted = false; };
  }, [timeframe]);

  const getContextText = () => {
    if (typeof timeframe === 'object' && timeframe.type === 'custom') {
      if (timeframe.from === timeframe.to) return `Resultados del ${timeframe.from}`;
      return `Resultados entre ${timeframe.from} y ${timeframe.to}`;
    }
    const map = {
      '24h': 'Las últimas 24 horas',
      '7d':  'Los últimos 7 días',
      '30d': 'Los últimos 30 días',
      '1y':  'El último año',
      '10y': 'La última década',
    };
    return map[timeframe] || 'Los últimos 7 días';
  };

  const handleShare = (paper) => {
    const url = paper.pdfUrl || paper.landingPageUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '');
    if (navigator.share) {
      navigator.share({ title: paper.title, url });
    } else {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const openPaper = (paper) => {
    const hasValidPdf = paper.pdfUrl && (paper.pdfUrl.includes('arxiv.org') || paper.pdfUrl.toLowerCase().endsWith('.pdf'));
    if (paper.arxivId || hasValidPdf) {
      onOpenPdf(paper);
    } else if (paper.pdfUrl || paper.landingPageUrl) {
      window.open(paper.pdfUrl || paper.landingPageUrl, '_blank');
    }
  };

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
      {/* ── Header ── */}
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
                if (o.id === 'custom') { setShowCustomPicker(p => !p); }
                else { setTimeframe(o.id); setCustomRange(null); setShowCustomPicker(false); }
              }}
            >
              {o.label}
            </button>
          ))}
        </nav>
      </header>

      {showCustomPicker && (
        <CustomDateSelector
          onApply={(rangeObj) => { setCustomRange(rangeObj); setTimeframe(rangeObj); setShowCustomPicker(false); }}
          onCancel={() => setShowCustomPicker(false)}
        />
      )}

      {/* ── States ── */}
      {loading ? (
        <div className="sr-state">
          <div className="sr-spinner" />
          <p>Compilando edición estable del reporte...</p>
        </div>
      ) : error ? (
        <div className="sr-state">
          <p>{error}</p>
          <button className="sr-retry" onClick={() => setTimeframe(timeframe)}>Reintentar</button>
        </div>
      ) : (
        <div className="sr-body">
          {/* ── Hero ── */}
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
                      {hero.doi && (
                        <a href={`https://doi.org/${hero.doi}`} target="_blank" rel="noopener noreferrer" className="sr-tag doi" onClick={e => e.stopPropagation()}>
                          <ExternalLink size={12} /> DOI
                        </a>
                      )}
                    </>
                  )}
                  {hero.openAccess
                    ? <span className="sr-tag oa"><Unlock size={12} /> Open Access</span>
                    : <span className="sr-tag sub"><Lock size={12} /> Subscription</span>
                  }
                  {hero.citationCount > 0 && <span className="sr-tag cites"><Award size={12} /> {hero.citationCount} citas</span>}
                </div>

                <blockquote className="sr-hero-abstract">{hero.abstract}</blockquote>

                <div className="sr-hero-actions">
                  <button className="sr-btn primary" onClick={() => openPaper(hero)}>
                    {(!hero.pdfUrl && !hero.arxivId) ? 'Abrir fuente' : 'Leer artículo'}
                  </button>
                  <button className="sr-btn ghost" onClick={() => handleShare(hero)}>
                    {copied ? <><Check size={15} /> Copiado</> : <><Share2 size={15} /> Compartir</>}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* ── Highlights ── */}
          {report.highlights?.length > 0 && (
            <section className="sr-highlights">
              <h2 className="sr-section-label">Otras Investigaciones Destacadas</h2>
              <div className="sr-list">
                {report.highlights.map((paper, i) => {
                  const cat = (paper.categories && paper.categories[0]) || paper.primaryCategory || 'General';
                  const accent = getCategoryGradient(cat);

                  return (
                    <article key={paper.id} className="sr-card" onClick={() => openPaper(paper)}>
                      <div className="sr-card-accent" style={{ background: accent }} />
                      <div className="sr-card-body">
                        <div className="sr-card-top">
                          <span className="sr-card-cat" style={{ background: accent, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                            {cat.split('.')[0]}
                          </span>
                          {paper.journal && <span className="sr-card-venue">{paper.journal}</span>}
                          <span className="sr-card-year">{paper.year}</span>
                        </div>

                        <h3 className="sr-card-title">{paper.title}</h3>
                        <p className="sr-card-abstract">{paper.abstract}</p>

                        <div className="sr-card-bottom">
                          <div className="sr-card-tags">
                            {paper.openAccess && <span className="sr-micro-tag oa"><Unlock size={11} /> Open Access</span>}
                            {paper.citationCount > 0 && <span className="sr-micro-tag">{paper.citationCount} citas</span>}
                          </div>
                          <span className="sr-card-read">Leer <ArrowRight size={14} /></span>
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
    </div>
  );
}
