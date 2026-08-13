import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { getScientificReport } from '../../services/scientificReportService';
import { getScientificTrends } from '../../services/scientificTrendService';
import { findOpenAccessCopy } from '../../services/unpaywallService';
import CustomDateSelector from './CustomDateSelector';
import ReportFilters from './ReportFilters';
import PaperCard from '../Feed/PaperCard';
import { CATEGORIES, getCategoryGradient, getCategoryLabel } from '../../data/categories';
import { resolvePaperTopic } from '../../utils/topicNavigation';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { safeDoiUrl, safeExternalUrl } from '../../utils/externalUrl.js';
import { Calendar, Award, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink, FileText, BarChart3, TrendingUp, X, Flame, Database, Sparkles } from 'lucide-react';
import ScientificText from '../ScientificText';
import 'katex/dist/katex.min.css';
import './ScientificReport.css';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';

function getHeroCategoryLabel(paper, language = 'es') {
  const category = typeof paper?.primaryCategory === 'string' ? paper.primaryCategory.trim() : '';
  const fallback = language === 'en' ? 'Scientific research' : 'Investigación científica';
  if (!category) return fallback;

  if (CATEGORIES[category]) {
    return language === 'en' ? CATEGORIES[category].labelEn : CATEGORIES[category].label;
  }

  const categoryLabel = getCategoryLabel(category, language);
  return categoryLabel === category ? fallback : categoryLabel;
}

function getLocalizedTopicLabel(value, language = 'es') {
  return resolvePaperTopic(value, language)?.label || value;
}

/* Animated number component — counts up from 0 */
function AnimatedNumber({ value, duration = 600, locale = 'es-ES' }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const target = typeof value === 'number' ? value : parseInt(value, 10) || 0;
    if (prefersReducedMotion || target === 0) {
      ref.current = requestAnimationFrame(() => setDisplay(target));
      return () => cancelAnimationFrame(ref.current);
    }

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
  }, [value, duration, prefersReducedMotion]);

  return <>{(value === 0 ? 0 : display).toLocaleString(locale)}</>;
}

const SOURCE_STATUS_LABELS = {
  es: {
    active: 'disponible',
    partial: 'parcial',
    unavailable: 'no disponible',
    'not-applicable': 'no aplicable',
    excluded: 'fuera por filtro',
  },
  en: {
    active: 'available',
    partial: 'partial',
    unavailable: 'unavailable',
    'not-applicable': 'not applicable',
    excluded: 'excluded by filter',
  },
};

function formatTrendPeriod(period, locale = 'es-ES') {
  if (!period?.fromStr || !period?.toStr) return '';
  const formatter = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const from = formatter.format(new Date(`${period.fromStr}T12:00:00`));
  const to = formatter.format(new Date(`${period.toStr}T12:00:00`));
  return from === to ? from : `${from} - ${to}`;
}

function ReportCoverage({ coverage }) {
  const { language, isEnglish } = useLanguage();
  if (!coverage?.sources?.length) return null;

  const hasLimitedCoverage = coverage.countryLimited
    || coverage.sources.some(source => !['active', 'not-applicable'].includes(source.status));

  return (
    <div className={`sr-coverage ${hasLimitedCoverage ? 'limited' : ''}`}>
      <Database size={15} aria-hidden="true" />
      <div className="sr-coverage-content">
        <span className="sr-coverage-label">
          {coverage.countryLimited
            ? (isEnglish
              ? 'Country coverage: only OpenAlex provides normalized affiliations.'
              : 'Cobertura por país: solo OpenAlex aporta afiliaciones normalizadas.')
            : (isEnglish ? 'Sources in this edition:' : 'Fuentes de esta edición:')}
        </span>
        <div className="sr-coverage-sources">
          {coverage.sources.map(source => (
            <span key={source.id} className={`sr-source-status ${source.status}`}>
              {source.label} · {SOURCE_STATUS_LABELS[language][source.status] || source.status}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ScientificReport({ onOpenPdf, onSaveToList }) {
  const { language, isEnglish, locale } = useLanguage();
  const prefersReducedMotion = useReducedMotion();
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
  const [heroAccess, setHeroAccess] = useState({ paperId: null, copy: null });
  const reportRequestId = useRef(0);
  const trendsRef = useRef(null);
  const closeOverlay = useCallback(() => setSelectedPaper(null), []);
  const paperDialogRef = useDialogFocus(Boolean(selectedPaper), closeOverlay);

  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();
  const getInteractionState = useCallback((paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);

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
        setError('REPORT_LOAD_FAILED');
        if (options.refreshTrends) {
          trendsRef.current = null;
          setTrends({ status: 'unavailable', items: [], loading: false });
        }
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
    reportRequestId.current += 1;
    const timerId = setTimeout(() => {
      setTrends(current => ({
        ...current,
        status: current.items?.length ? current.status : 'loading',
        loading: true,
      }));
      fetchReport(timeframe, filters, 1, { refreshTrends: true });
    }, 0);
    return () => {
      clearTimeout(timerId);
      reportRequestId.current += 1;
    };
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
    const labels = isEnglish
      ? { '24h': 'Today and yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days', '1y': 'Last year', '10y': 'Last decade' }
      : { '24h': 'Hoy y ayer', '7d': 'Últimos 7 días', '30d': 'Últimos 30 días', '1y': 'Último año', '10y': 'Última década' };
    return labels[timeframe] || labels['7d'];
  };

  const handleShare = (paper) => {
    const url = safeExternalUrl(paper.pdfUrl)
      || safeExternalUrl(paper.landingPageUrl)
      || (paper.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}` : '');
    if (navigator.share) { navigator.share({ title: paper.title, url }); }
    else { navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); }
  };

  const allPapers = [report.mainDiscovery, ...(report.highlights || [])].filter(Boolean);
  const totalPapers = allPapers.length;
  const totalCitations = allPapers.reduce((sum, p) => sum + (p.citationCount || 0), 0);
  const heroOpenCopy = heroAccess.paperId === report.mainDiscovery?.id ? heroAccess.copy : null;
  const oaCount = allPapers.filter(p => p.openAccess || (p.id === report.mainDiscovery?.id && heroOpenCopy)).length;
  const hasActiveFilters = (filters.categories?.length || 0) + (filters.countries?.length || 0) > 0;
  const hasUnavailableSource = report.coverage?.sources?.some(source => source.status === 'unavailable');
  const broaderTimeframe = typeof timeframe === 'string'
    ? { '24h': '7d', '7d': '30d', '30d': '1y', '1y': '10y' }[timeframe]
    : null;

  const hero = report.mainDiscovery;
  const accessibleHero = heroOpenCopy ? { ...hero, ...heroOpenCopy, openAccess: true } : hero;
  const heroGradient = hero ? getCategoryGradient(hero.primaryCategory || '') : 'var(--gradient-brand)';
  const reportContentKey = [
    hero?.id || 'no-hero',
    ...(report.highlights || []).map(paper => paper.id),
  ].join('|');

  useEffect(() => {
    let active = true;
    if (!hero?.doi || hero.openAccess || hero.pdfUrl) return () => { active = false; };
    findOpenAccessCopy(hero.doi).then(openCopy => {
      if (active && openCopy) setHeroAccess({ paperId: hero.id, copy: openCopy });
    });
    return () => { active = false; };
  }, [hero?.doi, hero?.id, hero?.openAccess, hero?.pdfUrl]);

  const timeOptions = [
    { id: '24h', label: isEnglish ? 'Today and yesterday' : 'Hoy y ayer' },
    { id: '7d', label: isEnglish ? '7 days' : '7 días' },
    { id: '30d', label: isEnglish ? '30 days' : '30 días' },
    { id: '1y', label: isEnglish ? '1 year' : '1 año' },
    { id: '10y', label: isEnglish ? '10 years' : '10 años' },
    { id: 'custom', label: isEnglish ? 'Custom' : 'Otro' },
  ];

  const trendItems = trends.items || [];
  const currentTrendPeriod = formatTrendPeriod(trends.periods?.current, locale);
  const previousTrendPeriod = formatTrendPeriod(trends.periods?.previous, locale);

  return (
    <main className="sr" aria-busy={loading}>
      {/* Header */}
      <header className="sr-header">
        <div className="sr-header-top">
          <div className="sr-masthead-block">
            <span className="sr-eyebrow"><Sparkles size={13} /> {isEnglish ? 'Scientific edition for this period' : 'Edición científica del periodo'}</span>
            <h1 className="sr-masthead">Research</h1>
          </div>
          <div className="sr-header-actions">
            <span className="sr-edition">
              <Calendar size={12} />
              {getContextText()}
            </span>
          </div>
        </div>

        <nav className="sr-tabs" aria-label={isEnglish ? 'Edition period' : 'Periodo de la edición'}>
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

      <AnimatePresence initial={false}>
      {showCustomPicker && (
        <motion.div
          className="sr-custom-date-slot"
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
          animate={{ opacity: 1, height: 'auto', y: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -4 }}
          transition={prefersReducedMotion
            ? { duration: 0 }
            : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        >
        <CustomDateSelector
          value={customRange}
          onApply={(rangeObj) => { setCustomRange(rangeObj); setTimeframe(rangeObj); setShowCustomPicker(false); }}
          onCancel={() => setShowCustomPicker(false)}
        />
        </motion.div>
      )}
      </AnimatePresence>

      <ReportFilters filters={filters} onChange={setFilters} loading={loading} />

      {error && totalPapers > 0 && (
        <div className="sr-inline-error" role="alert">
          <span>
            {isEnglish
              ? 'The filters could not be updated. The previous edition is still shown.'
              : 'No se pudieron actualizar los filtros. Se mantiene visible la edición anterior.'}
          </span>
          <button
            type="button"
            onClick={() => fetchReport(timeframe, filters, 1, { forceRefresh: true, refreshTrends: true })}
          >
            {isEnglish ? 'Retry' : 'Reintentar'}
          </button>
        </div>
      )}

      {loading && totalPapers === 0 ? (
        <div className="sr-state"><div className="sr-spinner" /><p>{isEnglish ? 'Compiling the edition...' : 'Compilando la edición...'}</p></div>
      ) : error && totalPapers === 0 ? (
        <div className="sr-state">
          <p>{getUiErrorMessage(error, language, 'REPORT_LOAD_FAILED')}</p>
          <button className="sr-retry" onClick={() => fetchReport(timeframe, filters, 1, { refreshTrends: true })}>
            {isEnglish ? 'Try again' : 'Reintentar'}
          </button>
        </div>
      ) : totalPapers === 0 ? (
        <div className="sr-empty-wrap">
          <ReportCoverage coverage={report.coverage} />
          <div className="sr-state sr-empty-state">
            <div className="sr-empty-icon"><FileText size={24} /></div>
            <h2>{isEnglish ? 'No papers were found for this edition' : 'No encontramos papers para esta edición'}</h2>
            <p>
              {hasActiveFilters
                ? (isEnglish
                  ? 'Try broadening the period or removing one of the active filters.'
                  : 'Prueba a ampliar el periodo o a retirar alguno de los filtros activos.')
                : (isEnglish
                  ? 'No results are available for this period. Try a broader edition.'
                  : 'No hay resultados disponibles en este periodo. Prueba con una edición más amplia.')}
            </p>
            <div className="sr-empty-actions">
              {hasActiveFilters && (
                <button className="sr-retry" onClick={() => setFilters({ categories: [], countries: [] })}>
                  {isEnglish ? 'Clear filters' : 'Limpiar filtros'}
                </button>
              )}
              {broaderTimeframe && (
                <button
                  className="sr-retry"
                  onClick={() => {
                    setTimeframe(broaderTimeframe);
                    setCustomRange(null);
                    setShowCustomPicker(false);
                  }}
                >
                  {isEnglish ? 'Broaden period' : 'Ampliar periodo'}
                </button>
              )}
              {(hasUnavailableSource || !broaderTimeframe) && (
                <button className="sr-retry" onClick={() => fetchReport(timeframe, filters, 1, { forceRefresh: true, refreshTrends: true })}>
                  {isEnglish ? 'Try again' : 'Reintentar'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
        <motion.div
          className={`sr-body ${loading ? 'updating' : ''}`}
          key={reportContentKey}
          initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
          animate={{ opacity: loading ? 0.76 : 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22 }}
        >

          {loading && <div className="sr-update-line" aria-label={isEnglish ? 'Updating the edition' : 'Actualizando la edición'} />}

          <ReportCoverage coverage={report.coverage} />

          {/* Stats Bar */}
          <div className="sr-stats-bar">
            <div className="sr-stat" title={isEnglish ? 'Papers included in this editorial selection' : 'Papers incluidos en esta selección editorial'}>
              <BarChart3 size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number"><AnimatedNumber value={totalPapers} locale={locale} /></span>
                <span className="sr-stat-label">{isEnglish ? 'Selected' : 'Seleccionados'}</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title={isEnglish ? 'Total citations of selected papers' : 'Suma de citas de los papers seleccionados'}>
              <TrendingUp size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number"><AnimatedNumber value={totalCitations} duration={800} locale={locale} /></span>
                <span className="sr-stat-label">{isEnglish ? 'Selection citations' : 'Citas selección'}</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title={isEnglish ? 'Open Access papers in the selection' : 'Papers Open Access dentro de la selección'}>
              <Unlock size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">{oaCount}/{totalPapers}</span>
                <span className="sr-stat-label">{isEnglish ? 'Selection OA' : 'OA selección'}</span>
              </div>
            </div>
          </div>

          <section className={`sr-real-trends ${trends.loading ? 'updating' : ''}`} aria-label={isEnglish ? 'Scientific trends' : 'Tendencias científicas'}>
            <div className="sr-trends-heading">
              <span><TrendingUp size={15} /> {isEnglish ? 'Growing topics' : 'Temas en crecimiento'}</span>
              {currentTrendPeriod && previousTrendPeriod && (
                <small>
                  {trends.provisional ? (isEnglish ? 'Provisional data · ' : 'Datos provisionales · ') : ''}
                  {currentTrendPeriod} {isEnglish ? 'compared with' : 'comparado con'} {previousTrendPeriod}
                </small>
              )}
            </div>
            {trends.loading ? (
              <div className="sr-trend-list sr-trend-list--loading" role="status" aria-label={isEnglish ? 'Calculating trends' : 'Calculando tendencias'}>
                {[0, 1, 2, 3, 4].map(index => (
                  <span key={index} className="sr-trend-skeleton" />
                ))}
              </div>
            ) : trendItems.length > 0 ? (
              <div className="sr-trend-list">
                {trendItems.map((item, index) => (
                  <div
                    className="sr-trend-item sr-trend-item--enter"
                    key={`${trends.periods?.current?.fromStr || 'current'}-${item.id}`}
                    style={{ '--trend-order': index }}
                    title={isEnglish
                      ? `${item.currentCount} works in the current period and ${item.previousCount} in the previous one. Confidence ${item.confidence}.`
                      : `${item.currentCount} trabajos en el periodo actual y ${item.previousCount} en el anterior. Confianza ${item.confidence}.`}
                  >
                    <span className="sr-trend-name">{getLocalizedTopicLabel(item.label, language)}</span>
                    <strong>+{item.changePercent}% {isEnglish ? 'presence' : 'de presencia'}</strong>
                    <small>{item.currentCount} {isEnglish ? 'works; previously' : 'trabajos; antes'} {item.previousCount}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="sr-trends-state">
                {trends.status === 'unavailable'
                    ? (isEnglish
                      ? 'Trends are unavailable right now; the paper selection remains active.'
                      : 'Las tendencias no están disponibles ahora; la selección de papers sigue activa.')
                    : (isEnglish
                      ? 'There is not enough volume yet to detect a reliable trend.'
                      : 'Aún no hay volumen suficiente para detectar una tendencia fiable.')}
              </p>
            )}
          </section>

          {/* These describe the selected edition; they are not presented as measured trends. */}
          {trends.status !== 'active' && report.featuredConcepts?.length > 0 && (
            <div className="sr-trending-topics">
              <span className="sr-trending-label">
                <Flame size={14} className="sr-flame-icon" />
                {isEnglish ? 'Topics in this selection:' : 'Temas de esta selección:'}
              </span>
              <div className="sr-trending-pills">
                {report.featuredConcepts.map((concept) => (
                  <span key={concept} className="sr-trending-pill">{getLocalizedTopicLabel(concept, language)}</span>
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
                  <span className="sr-kicker-cat">{getHeroCategoryLabel(hero, language).toUpperCase()}</span>
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
                      {safeDoiUrl(hero.doi) && <a href={safeDoiUrl(hero.doi)} target="_blank" rel="noopener noreferrer" className="sr-tag doi" onClick={e => e.stopPropagation()}><ExternalLink size={12} /> DOI</a>}
                    </>
                  )}
                  {accessibleHero.openAccess
                    ? <span className="sr-tag oa"><Unlock size={12} /> {heroOpenCopy ? (isEnglish ? 'Open version available' : 'Versión abierta disponible') : 'Open Access'}</span>
                    : <span className="sr-tag sub"><Lock size={12} /> {isEnglish ? 'Subscription' : 'Suscripción'}</span>}
                  {hero.citationCount > 0 && <span className="sr-tag cites"><Award size={12} /> {hero.citationCount} {isEnglish ? 'citations' : 'citas'}</span>}
                </div>
                <blockquote className="sr-hero-abstract">
                  {hasUsableAIAbstract(hero.abstract)
                    ? <ScientificText>{hero.abstract}</ScientificText>
                    : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
                </blockquote>
                <div className="sr-hero-actions">
                  <button className="sr-btn primary" onClick={() => setSelectedPaper(accessibleHero)}>
                    {isEnglish ? 'View details' : 'Ver detalle'}
                  </button>
                  <button className="sr-btn ghost" onClick={() => handleShare(accessibleHero)}>
                    {copied
                      ? <><Check size={15} /> {isEnglish ? 'Copied' : 'Copiado'}</>
                      : <><Share2 size={15} /> {isEnglish ? 'Share' : 'Compartir'}</>}
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Bento Highlights */}
          {report.highlights?.length > 0 && (
            <section className="sr-highlights">
              <h2 className="sr-section-label">{isEnglish ? 'Other highlighted research' : 'Otras investigaciones destacadas'}</h2>
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
                        {isWide && (
                          <p className="sr-bento-abstract">
                            {hasUsableAIAbstract(paper.abstract)
                              ? <ScientificText>{paper.abstract}</ScientificText>
                              : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
                          </p>
                        )}
                        <div className="sr-bento-bottom">
                          <div className="sr-bento-tags">
                            {paper.openAccess && <span className="sr-micro oa"><Unlock size={11} /> Open Access</span>}
                            {paper.citationCount > 0 && <span className="sr-micro">{paper.citationCount} {isEnglish ? 'citations' : 'citas'}</span>}
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

        </motion.div>
        </AnimatePresence>
      )}

      {/* Paper Detail Overlay */}
      <AnimatePresence>
        {selectedPaper && (
          <motion.div 
            ref={paperDialogRef}
            className="sr-paper-overlay" 
            onClick={closeOverlay}
            role="dialog"
            aria-modal="true"
            aria-label={isEnglish ? 'Paper details' : 'Detalles del paper'}
            tabIndex={-1}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, backdropFilter: 'blur(0px)' }}
            animate={prefersReducedMotion ? { opacity: 1 } : { opacity: 1, backdropFilter: 'blur(12px)' }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, backdropFilter: 'blur(0px)' }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.3 }}
          >
            <motion.div 
              className="sr-paper-overlay-inner" 
              onClick={(e) => e.stopPropagation()}
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 40 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, y: 40 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <button data-dialog-initial-focus className="sr-overlay-close" onClick={closeOverlay} aria-label={isEnglish ? 'Close paper' : 'Cerrar paper'}>
                <X size={20} />
              </button>
              <div className="sr-paper-card-wrapper">
                <PaperCard
                  paper={selectedPaper}
                  isLiked={likedPaperIds.has(selectedPaper.id)}
                  isSaved={savedPaperIds.has(selectedPaper.id)}
                  isRead={readPaperIds.has(selectedPaper.id)}
                  onLike={toggleLike}
                  onNotInterested={(paper) => { markNotInterested(paper); closeOverlay(); }}
                  onMarkAsRead={markAsRead}
                  trackViewTime={trackViewTime}
                  trackSkip={trackSkip}
                  onOpenPdf={onOpenPdf}
                  onSaveToList={onSaveToList}
                  getInteractionState={getInteractionState}
                  hideScrollHint
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
