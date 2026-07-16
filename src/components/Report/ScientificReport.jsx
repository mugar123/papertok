import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useFeed } from '../../context/FeedContext';
import { getScientificReport } from '../../services/scientificReportService';
import { getScientificTrends } from '../../services/scientificTrendService';
import CustomDateSelector from './CustomDateSelector';
import ReportFilters from './ReportFilters';
import PaperCard from '../Feed/PaperCard';
import { CATEGORIES, getCategoryGradient, getCategoryLabel } from '../../data/categories';
import { Calendar, Award, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink, FileText, BarChart3, TrendingUp, X, Flame, Database } from 'lucide-react';
import ScientificText from '../ScientificText';
import 'katex/dist/katex.min.css';
import './ScientificReport.css';


function getHeroCategoryLabel(paper) {
  const category = typeof paper?.primaryCategory === 'string' ? paper.primaryCategory.trim() : '';
  if (!category) return 'Investigación científica';

  if (CATEGORIES[category]) return CATEGORIES[category].label;

  const categoryLabel = getCategoryLabel(category);
  return categoryLabel === category ? 'Investigación científica' : categoryLabel;
}

/* Animated number component — counts up from 0 */
function AnimatedNumber({ value, duration = 600 }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    const target = typeof value === 'number' ? value : parseInt(value, 10) || 0;
    if (target === 0) return undefined;

    let start = null;
    const step = (ts) => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setDisplay(Math.round(eased * target));
      if (progress < 1) ref.current = requestAnimationFrame(step);
    };
    ref.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(ref.current);
  }, [value, duration]);

  return <>{(value === 0 ? 0 : display).toLocaleString()}</>;
}

const SOURCE_STATUS_LABELS = {
  active: 'disponible',
  partial: 'parcial',
  unavailable: 'no disponible',
  'not-applicable': 'no aplicable',
  excluded: 'fuera por filtro',
};

function formatTrendPeriod(period) {
  if (!period?.fromStr || !period?.toStr) return '';
  const formatter = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
  const from = formatter.format(new Date(`${period.fromStr}T12:00:00`));
  const to = formatter.format(new Date(`${period.toStr}T12:00:00`));
  return from === to ? from : `${from} - ${to}`;
}

function ReportCoverage({ coverage }) {
  if (!coverage?.sources?.length) return null;

  const hasLimitedCoverage = coverage.countryLimited
    || coverage.sources.some(source => !['active', 'not-applicable'].includes(source.status));

  return (
    <div className={`sr-coverage ${hasLimitedCoverage ? 'limited' : ''}`}>
      <Database size={15} aria-hidden="true" />
      <div className="sr-coverage-content">
        <span className="sr-coverage-label">
          {coverage.countryLimited
            ? 'Cobertura por país: solo OpenAlex aporta afiliaciones normalizadas.'
            : 'Fuentes de esta edición:'}
        </span>
        <div className="sr-coverage-sources">
          {coverage.sources.map(source => (
            <span key={source.id} className={`sr-source-status ${source.status}`}>
              {source.label} · {SOURCE_STATUS_LABELS[source.status] || source.status}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ScientificReport({ onOpenPdf, onSaveToList }) {
  const [timeframe, setTimeframe] = useState('7d');
  const [filters, setFilters] = useState({ categories: [], countries: [] });
  const [report, setReport] = useState({ mainDiscovery: null, highlights: [] });
  const [trends, setTrends] = useState({ status: 'loading', items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customRange, setCustomRange] = useState(null);
  const [selectedPaper, setSelectedPaper] = useState(null);
  const reportRequestId = useRef(0);
  const trendsRef = useRef(null);

  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();

  const fetchReport = useCallback(async (tf, currentFilters, targetPage = 1, options = {}) => {
    const requestId = ++reportRequestId.current;
    setLoading(true);
    window.dispatchEvent(new Event('reportLoadingStart'));
    setError(null);
    let reportFinished = false;
    try {
      const trendPromise = options.refreshTrends
        ? getScientificTrends(tf, currentFilters, { forceRefresh: options.forceRefresh })
        : null;
      if (trendPromise) setTrends(current => ({ ...current, loading: true }));

      const data = await getScientificReport(tf, targetPage, currentFilters, {
        forceRefresh: options.forceRefresh,
        trends: trendsRef.current,
      });
      if (requestId === reportRequestId.current) {
        setReport(data);
        setLoading(false);
        window.dispatchEvent(new Event('reportLoadingEnd'));
        reportFinished = true;
      }

      if (trendPromise) {
        const nextTrends = await trendPromise;
        if (requestId === reportRequestId.current) {
          trendsRef.current = nextTrends;
          setTrends({ ...nextTrends, loading: false });
          try {
            const reranked = await getScientificReport(tf, targetPage, currentFilters, {
              trends: nextTrends,
            });
            if (requestId === reportRequestId.current) setReport(reranked);
          } catch (rerankError) {
            console.warn('Could not apply trend momentum to the loaded report:', rerankError);
          }
        }
      }
      return requestId === reportRequestId.current;
    } catch (err) {
      console.error('Error fetching report:', err);
      if (requestId === reportRequestId.current) {
        setError('No se pudo cargar el reporte. Reinténtalo.');
      }
      return false;
    } finally {
      if (!reportFinished && requestId === reportRequestId.current) {
        setLoading(false);
        window.dispatchEvent(new Event('reportLoadingEnd'));
      }
    }
  }, []);

  useEffect(() => () => {
    reportRequestId.current += 1;
  }, []);

  useEffect(() => {
    trendsRef.current = null;
    const requestId = setTimeout(() => {
      setTrends({ status: 'loading', items: [], loading: true });
      fetchReport(timeframe, filters, 1, { refreshTrends: true });
    }, 0);
    return () => clearTimeout(requestId);
  }, [timeframe, filters, fetchReport]);

  useEffect(() => {
    const handleGlobalRefresh = () => {
      fetchReport(timeframe, filters, 1, { forceRefresh: true, refreshTrends: true });
    };
    
    window.addEventListener('refreshScientificReport', handleGlobalRefresh);
    return () => window.removeEventListener('refreshScientificReport', handleGlobalRefresh);
  }, [timeframe, filters, fetchReport]);

  const getContextText = () => {
    if (typeof timeframe === 'object' && timeframe.type === 'custom') {
      if (timeframe.from === timeframe.to) return `${timeframe.from}`;
      return `${timeframe.from}  —  ${timeframe.to}`;
    }
    return { '24h': 'Hoy y ayer', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '1y': 'Último año', '10y': 'Última década' }[timeframe] || 'Últimos 7 días';
  };

  const handleShare = (paper) => {
    const url = paper.pdfUrl || paper.landingPageUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '');
    if (navigator.share) { navigator.share({ title: paper.title, url }); }
    else { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const allPapers = [report.mainDiscovery, ...(report.highlights || [])].filter(Boolean);
  const totalPapers = allPapers.length;
  const totalCitations = allPapers.reduce((sum, p) => sum + (p.citationCount || 0), 0);
  const oaCount = allPapers.filter(p => p.openAccess).length;
  const hasActiveFilters = (filters.categories?.length || 0) + (filters.countries?.length || 0) > 0;

  const hero = report.mainDiscovery;
  const heroGradient = hero ? getCategoryGradient(hero.primaryCategory || '') : 'var(--gradient-brand)';

  const timeOptions = [
    { id: '24h', label: 'Hoy y ayer' },
    { id: '7d', label: '7 días' },
    { id: '30d', label: '30 días' },
    { id: '1y', label: '1 año' },
    { id: '10y', label: '10 años' },
    { id: 'custom', label: 'Otro' },
  ];

  const closeOverlay = () => {
    setSelectedPaper(null);
  };

  const trendItems = trends.items || [];
  const currentTrendPeriod = formatTrendPeriod(trends.periods?.current);
  const previousTrendPeriod = formatTrendPeriod(trends.periods?.previous);

  return (
    <div className="sr">
      {/* Header */}
      <header className="sr-header">
        <div className="sr-header-top">
          <h1 className="sr-masthead">Reporte científico</h1>
          <div className="sr-header-actions">
            <span className="sr-edition">{getContextText()}</span>
          </div>
        </div>
        <nav className="sr-tabs" aria-label="Periodo del reporte">
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

      {/* Filters Panel */}
      <ReportFilters filters={filters} onChange={setFilters} />


      {loading && totalPapers === 0 ? (
        <div className="sr-state"><div className="sr-spinner" /><p>Compilando edición estable...</p></div>
      ) : error && totalPapers === 0 ? (
        <div className="sr-state"><p>{error}</p><button className="sr-retry" onClick={() => fetchReport(timeframe, filters, 1, { refreshTrends: true })}>Reintentar</button></div>
      ) : totalPapers === 0 ? (
        <div className="sr-empty-wrap">
          <ReportCoverage coverage={report.coverage} />
          <div className="sr-state sr-empty-state">
            <div className="sr-empty-icon"><FileText size={24} /></div>
            <h2>No encontramos papers para esta edición</h2>
            <p>
              {hasActiveFilters
                ? 'Prueba a ampliar el periodo o a retirar alguno de los filtros activos.'
                : 'No hay resultados disponibles en este periodo. Prueba con una edición más amplia.'}
            </p>
            <div className="sr-empty-actions">
              {hasActiveFilters && (
                <button className="sr-retry" onClick={() => setFilters({ categories: [], countries: [] })}>
                  Limpiar filtros
                </button>
              )}
              {timeframe !== '10y' && (
                <button
                  className="sr-retry"
                  onClick={() => {
                    setTimeframe(timeframe === '30d' ? '1y' : '30d');
                    setCustomRange(null);
                    setShowCustomPicker(false);
                  }}
                >
                  {timeframe === '30d' ? 'Ampliar a 1 año' : 'Ampliar a 30 días'}
                </button>
              )}
              {timeframe === '10y' && !hasActiveFilters && (
                <button className="sr-retry" onClick={() => fetchReport(timeframe, filters, 1, { forceRefresh: true, refreshTrends: true })}>
                  Reintentar
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`sr-body ${loading ? 'updating' : ''}`}
          key={typeof timeframe === 'string' ? timeframe : JSON.stringify(timeframe)}
        >

          {loading && <div className="sr-update-line" aria-label="Actualizando reporte" />}

          <ReportCoverage coverage={report.coverage} />

          {/* Stats Bar */}
          <div className="sr-stats-bar">
            <div className="sr-stat" title="Papers incluidos en esta selección editorial">
              <BarChart3 size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number"><AnimatedNumber value={totalPapers} /></span>
                <span className="sr-stat-label">Seleccionados</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title="Suma de citas de los papers seleccionados">
              <TrendingUp size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number"><AnimatedNumber value={totalCitations} duration={800} /></span>
                <span className="sr-stat-label">Citas selección</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title="Papers Open Access dentro de la selección">
              <Unlock size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">{oaCount}/{totalPapers}</span>
                <span className="sr-stat-label">OA selección</span>
              </div>
            </div>
          </div>

          <section className={`sr-real-trends ${trends.loading ? 'updating' : ''}`} aria-label="Tendencias científicas">
            <div className="sr-trends-heading">
              <span><TrendingUp size={15} /> Temas en crecimiento</span>
              {currentTrendPeriod && previousTrendPeriod && (
                <small>
                  {trends.provisional ? 'Datos provisionales · ' : ''}{currentTrendPeriod} comparado con {previousTrendPeriod}
                </small>
              )}
            </div>
            {trendItems.length > 0 ? (
              <div className="sr-trend-list">
                {trendItems.map(item => (
                  <div
                    className="sr-trend-item"
                    key={item.id}
                    title={`${item.currentCount} trabajos en el periodo actual y ${item.previousCount} en el anterior. Confianza ${item.confidence}.`}
                  >
                    <span className="sr-trend-name">{item.label}</span>
                    <strong>+{item.changePercent}% de presencia</strong>
                    <small>{item.currentCount} trabajos; antes {item.previousCount}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sr-trends-state">
                {trends.loading || trends.status === 'loading'
                  ? 'Calculando cambios frente al periodo anterior...'
                  : trends.status === 'unavailable'
                    ? 'Las tendencias no están disponibles ahora; la selección de papers sigue activa.'
                    : 'Aún no hay volumen suficiente para detectar una tendencia fiable.'}
              </p>
            )}
          </section>

          {/* These describe the selected edition; they are not presented as measured trends. */}
          {trends.status !== 'active' && report.featuredConcepts?.length > 0 && (
            <div className="sr-trending-topics">
              <span className="sr-trending-label">
                <Flame size={14} className="sr-flame-icon" />
                Temas de esta selección:
              </span>
              <div className="sr-trending-pills">
                {report.featuredConcepts.map((concept) => (
                  <span key={concept} className="sr-trending-pill">{concept}</span>
                ))}
              </div>
            </div>
          )}

          {/* Hero */}
          {hero && (
            <section className="sr-hero" style={{ '--hero-glow': heroGradient }}>
              <div className="sr-hero-glow" />
              <div className="sr-hero-inner">
                <div className="sr-hero-kicker">
                  <span className="sr-kicker-cat">{getHeroCategoryLabel(hero).toUpperCase()}</span>
                  <span className="sr-kicker-sep" />
                  {hero.journal && <span className="sr-kicker-venue">{hero.journal}</span>}
                  <span className="sr-kicker-year"><Calendar size={13} /> {hero.year}</span>
                </div>
                <h2 className="sr-hero-title"><ScientificText>{hero.title}</ScientificText></h2>
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
                <blockquote className="sr-hero-abstract"><ScientificText>{hero.abstract}</ScientificText></blockquote>
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
                      style={{ animationDelay: `${0.3 + i * 0.08}s` }}
                    >
                      <div className="sr-bento-accent" style={{ background: accent }} />
                      <div className="sr-bento-body">
                        <div className="sr-bento-top">
                          <span className="sr-bento-cat" style={{ background: accent, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                            {cat.split('.')[0]}
                          </span>
                          <span className="sr-bento-year">{paper.year}</span>
                        </div>
                        <h3 className="sr-bento-title"><ScientificText>{paper.title}</ScientificText></h3>
                        {isWide && <p className="sr-bento-abstract"><ScientificText>{paper.abstract}</ScientificText></p>}
                        <div className="sr-bento-bottom">
                          <div className="sr-bento-tags">
                            {paper.openAccess && <span className="sr-micro oa"><Unlock size={11} /> Open Access</span>}
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
      <AnimatePresence>
        {selectedPaper && (
          <motion.div 
            className="sr-paper-overlay" 
            onClick={closeOverlay}
            initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            animate={{ opacity: 1, backdropFilter: 'blur(12px)' }}
            exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
            transition={{ duration: 0.3 }}
          >
            <motion.div 
              className="sr-paper-overlay-inner" 
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.85, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.85, y: 40 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <button className="sr-overlay-close" onClick={closeOverlay}>
                <X size={20} />
              </button>
              <div className="sr-paper-card-wrapper">
                <PaperCard
                  paper={selectedPaper}
                  isLiked={likedPaperIds.has(selectedPaper.id)}
                  isSaved={savedPaperIds.has(selectedPaper.id)}
                  isRead={readPaperIds.has(selectedPaper.id)}
                  onLike={() => toggleLike(selectedPaper)}
                  onNotInterested={() => { markNotInterested(selectedPaper); closeOverlay(); }}
                  onMarkAsRead={() => markAsRead(selectedPaper)}
                  trackViewTime={trackViewTime}
                  trackSkip={trackSkip}
                  onOpenPdf={onOpenPdf}
                  onSaveToList={onSaveToList}
                  hideScrollHint
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
