import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { getScientificReport } from '../../services/scientificReportService';
import { getScientificTrends } from '../../services/scientificTrendService';
import { findOpenAccessCopy } from '../../services/unpaywallService';
import { accessTagForPaper, reviewTagForPaper } from '../../utils/paperStatus.js';
import CustomDateSelector from './CustomDateSelector';
import ReportFilters from './ReportFilters';
import PaperCard from '../Feed/PaperCard';
import ResearchForme from './ResearchForme';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import PaperOverlay from '../Feed/PaperOverlay';
import { CATEGORIES, getCategoryLabel } from '../../data/categories';
import { resolvePaperTopic } from '../../utils/topicNavigation';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { safeDoiUrl, safeExternalUrl } from '../../utils/externalUrl.js';
import { Calendar, Award, Share2, Check, BadgeCheck, Unlock, Lock, ExternalLink, FileText, BarChart3, TrendingUp, Flame, Database, Sparkles, ArrowRight, ArrowLeft } from 'lucide-react';
import ScientificText from '../ScientificText';
import 'katex/dist/katex.min.css';
import './ScientificReport.css';

/** The same glyph per status the feed card uses, keyed the same way. */
const STATUS_TAG_ICONS = {
  preprint: FileText,
  verified: BadgeCheck,
  open: Unlock,
  openCopy: Unlock,
  subscription: Lock,
};

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

/**
 * The yellow rule under the period you are reading.
 *
 * The same element and the same curve as the navbar's feed indicator, because
 * it is the same gesture one level down: a row of siblings where one is
 * chosen. It was `border-bottom-color` on `.sr-tab.active`, and a border
 * belongs to its element — it can appear and vanish, never travel. Sharing one
 * `layoutId` makes it one rule that moves.
 *
 * The tween is bounded on purpose (see `RULE_TRAVEL` in `Navbar.jsx`): a
 * spring's tail leaves the rule drifting the last few pixels long after the
 * move reads as over.
 */
const PERIOD_RULE_TRAVEL = { duration: 0.28, ease: [0.4, 0, 0.2, 1] };

function ActivePeriodRule({ reduced }) {
  return (
    <motion.span
      className="sr-tab-rule"
      layoutId="sr-active-period"
      aria-hidden="true"
      transition={reduced ? { duration: 0 } : PERIOD_RULE_TRAVEL}
    />
  );
}

/**
 * One measurement in the sidebar, with its own skeleton.
 *
 * The two branches carry keys because they are both `<span>`s in the same
 * slot: without them React keeps the node and only swaps its class, the
 * element never mounts, and `srValueIn` — a CSS animation, which runs on mount
 * and nowhere else — never plays. With them the bone leaves, the value
 * arrives, and it arrives fading up while `AnimatedNumber` counts it out.
 */
function StatValue({ loading, width = '64%', children }) {
  if (loading) {
    return <span key="bone" className="sr-bone sr-bone--stat" style={{ width }} />;
  }
  return <span key="value" className="sr-stat-value">{children}</span>;
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

/* Reading order of the entrance, not DOM order: the sidebar is first in the DOM
   so screen readers announce the measurements before the stories, but on screen
   the lead story and the stats bar start together. */
const ENTER = { hero: 0, stats: 0, trends: 1, topics: 2, coverage: 3, label: 1, cards: 2 };

/**
 * The lead story while the next edition compiles.
 *
 * Without this the hero was the one thing left standing at full strength once
 * the rest of the page had gone grey — and worse, standing there showing the
 * *previous* edition's paper as though it were the answer to the period the
 * reader had just asked for. It joins the same grey vocabulary as the forme and
 * the trends, in its own shape, so the whole edition reads as being replaced.
 */
function LeadStorySkeleton() {
  return (
    <section className="sr-hero sr-hero--skeleton sr-enter" style={{ '--enter-order': ENTER.hero }} aria-hidden="true">
      <div className="sr-hero-glow" />
      <div className="sr-hero-inner">
        <span className="sr-bone sr-bone--lead" />
        <div className="sr-hero-main">
          <span className="sr-bone sr-bone--kicker" />
          <span className="sr-bone sr-bone--hero-title" />
          <span className="sr-bone sr-bone--hero-title sr-bone--short" />
          <span className="sr-bone sr-bone--authors" />
          <div className="sr-hero-tags">
            <span className="sr-bone sr-bone--tag" />
            <span className="sr-bone sr-bone--tag" />
            <span className="sr-bone sr-bone--tag" />
          </div>
          <div className="sr-hero-actions">
            <span className="sr-bone sr-bone--btn" />
            <span className="sr-bone sr-bone--btn" />
          </div>
        </div>
        <div className="sr-hero-abstract">
          {[0, 1, 2, 3, 4, 5].map(line => (
            <span key={line} className={`sr-bone sr-bone--dek${line === 5 ? ' sr-bone--short' : ''}`} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ReportCoverage({ coverage, enterOrder }) {
  const { language, isEnglish } = useLanguage();
  if (!coverage?.sources?.length) return null;

  const hasLimitedCoverage = coverage.countryLimited
    || coverage.sources.some(source => !['active', 'not-applicable'].includes(source.status));

  return (
    <div
      className={`sr-coverage ${hasLimitedCoverage ? 'limited' : ''} ${enterOrder == null ? '' : 'sr-enter'}`}
      style={enterOrder == null ? undefined : { '--enter-order': enterOrder }}
    >
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
    /* Turning to another selection reads a slice of an ordering that is already
       ranked and cached, so it normally resolves in a frame or two and the
       loading treatment would be a flash of grey for nothing. It is armed on a
       delay instead — the same 320 ms the rest of the app waits before it
       admits to a placeholder — so a cold corpus still says something. */
    let quietTimer = null;
    const goLoud = () => {
      if (requestId !== reportRequestId.current) return;
      setLoading(true);
    };
    if (options.quiet) quietTimer = setTimeout(goLoud, 320);
    else goLoud();
    const stopWaiting = () => { if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; } };
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
        selection: options.selection,
      });
      if (requestId === reportRequestId.current) {
        stopWaiting();
        setReport(data);
        setLoading(false);
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
              selection: options.selection,
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
      stopWaiting();
      if (!reportFinished && requestId === reportRequestId.current) {
        setLoading(false);
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

  /* Which selection is on the page, read from what was actually built rather
     than from what was asked for: a period that shrank hands back the last
     selection it has, and the chrome has to agree with the papers. */
  const currentSelection = report.selection || 1;
  const totalSelections = report.selectionCount || 1;

  const goToSelection = useCallback((next) => {
    fetchReport(timeframe, filters, 1, { selection: next, quiet: true }).then(() => {
      /* The reader pressed this at the foot of the page; leaving them there
         would drop them into the middle of a selection they have not started.
         All the way to the top, not just to the lead story: a new selection is
         a new front page, and the nameplate says which one they are on. */
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [fetchReport, timeframe, filters]);

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
  // Same resolution as the forme below it and as the card it opens.
  const heroGradient = hero ? areaAccentForPaper(hero) : 'var(--gradient-brand)';
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
  const maxTrendChange = trendItems.reduce(
    (largest, item) => Math.max(largest, Number(item.changePercent) || 0),
    0,
  );
  const currentTrendPeriod = formatTrendPeriod(trends.periods?.current, locale);
  const previousTrendPeriod = formatTrendPeriod(trends.periods?.previous, locale);

  return (
    <main className="sr" aria-busy={loading}>
      {/* Nameplate */}
      <header className="sr-header">
        <div className="sr-header-top">
          <div className="sr-masthead-block">
            <span className="sr-eyebrow">
              <Sparkles size={12} />
              {isEnglish ? 'Scientific edition for this period' : 'Edición científica del periodo'}
              {/* Only where there is somewhere to go: a period thin enough for
                  one selection must not offer a count of one. */}
              {totalSelections > 1 && (
                <>
                  <span className="sr-eyebrow-sep" aria-hidden="true">·</span>
                  <span className="sr-eyebrow-count">
                    {isEnglish
                      ? `Selection ${currentSelection} of ${totalSelections}`
                      : `Tanda ${currentSelection} de ${totalSelections}`}
                  </span>
                </>
              )}
            </span>
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
          <span className="sr-tabs-label">{isEnglish ? 'Edition' : 'Edición'}</span>
          {timeOptions.map((o) => {
            const isActive = Boolean(timeframe === o.id || (o.id === 'custom' && customRange));
            return (
              <button
                key={o.id}
                className={`sr-tab ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (o.id === 'custom') setShowCustomPicker(p => !p);
                  else { setTimeframe(o.id); setCustomRange(null); setShowCustomPicker(false); }
                }}
              >
                {o.label}
                {isActive && <ActivePeriodRule reduced={prefersReducedMotion} />}
              </button>
            );
          })}
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
        /* No key, and no `AnimatePresence`. The body used to be keyed on the
           ids of the edition it was showing, inside `mode="wait"`, so every
           new edition made the whole thing — sidebar included — fade out to
           nothing and then fade back in from nothing: a blank page between two
           editions. And it happened twice per period change, because
           `fetchReport` publishes the edition, waits for the trends and then
           publishes it again re-ranked. The regions still make their own
           entrances off `sr-enter`; they are keyed by paper, so they mount
           when their paper is new and stay put when it is not. */
        <motion.div
          className={`sr-body ${loading ? 'updating' : ''}`}
          initial={false}
          animate={{ opacity: loading ? 0.76 : 1 }}
          transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22 }}
        >

          <div className="sr-layout">
          <aside className="sr-aside">
          {/* The measurements. While the next edition compiles they go to
              bones like everything else on the page — they used to be the one
              block still asserting numbers, and the numbers were the previous
              period's. The icons, the labels and the meter's track stay: they
              are the sidebar's furniture, not the edition's data, the same way
              the trends keep their heading and skeleton only the list. */}
          <div className="sr-stats-bar sr-enter" style={{ '--enter-order': ENTER.stats }}>
            <div className="sr-stat" title={isEnglish ? 'Papers included in this editorial selection' : 'Papers incluidos en esta selección editorial'}>
              <BarChart3 size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">
                  <StatValue loading={loading}><AnimatedNumber value={totalPapers} locale={locale} /></StatValue>
                </span>
                <span className="sr-stat-label">{isEnglish ? 'Selected' : 'Seleccionados'}</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title={isEnglish ? 'Total citations of selected papers' : 'Suma de citas de los papers seleccionados'}>
              <TrendingUp size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">
                  <StatValue loading={loading} width="72%"><AnimatedNumber value={totalCitations} duration={800} locale={locale} /></StatValue>
                </span>
                <span className="sr-stat-label">{isEnglish ? 'Selection citations' : 'Citas selección'}</span>
              </div>
            </div>
            <div className="sr-stat-divider" />
            <div className="sr-stat" title={isEnglish ? 'Open Access papers in the selection' : 'Papers Open Access dentro de la selección'}>
              <Unlock size={16} />
              <div className="sr-stat-info">
                <span className="sr-stat-number">
                  <StatValue loading={loading} width="58%">{oaCount}/{totalPapers}</StatValue>
                </span>
                <span className="sr-stat-label">{isEnglish ? 'Selection OA' : 'OA selección'}</span>
                {/* The ratio is easier to read as a proportion than as a fraction. */}
                <span
                  className={`sr-stat-meter${loading ? ' sr-stat-meter--waiting' : ''}`}
                  style={{ '--fill': `${!loading && totalPapers > 0 ? Math.round((oaCount / totalPapers) * 100) : 0}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>
          </div>

          <section
            className={`sr-real-trends sr-enter ${trends.loading ? 'updating' : ''}`}
            style={{ '--enter-order': ENTER.trends }}
            aria-label={isEnglish ? 'Scientific trends' : 'Tendencias científicas'}
          >
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
                    <span
                      className="sr-trend-bar"
                      style={{ '--fill': `${maxTrendChange > 0 ? Math.max(6, Math.round((item.changePercent / maxTrendChange) * 100)) : 0}%` }}
                      aria-hidden="true"
                    />
                    <strong>+{item.changePercent}%</strong>
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
            <div className="sr-trending-topics sr-enter" style={{ '--enter-order': ENTER.topics }}>
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

          <ReportCoverage coverage={report.coverage} enterOrder={ENTER.coverage} />
          </aside>

          <div className="sr-main">
          {/* Hero. While the next edition compiles it gives way to its own
              skeleton rather than standing there showing the previous one. */}
          {loading && hero && <LeadStorySkeleton />}
          {!loading && hero && (
            <section className="sr-hero sr-enter" style={{ '--hero-glow': heroGradient, '--enter-order': ENTER.hero }}>
              <div className="sr-hero-glow" />
              <div className="sr-hero-inner">
                <span className="sr-lead-label">{isEnglish ? 'Lead story' : 'Portada'}</span>
                <div className="sr-hero-main">
                <div className="sr-hero-kicker">
                  <span className="sr-kicker-cat">{(areaLabelForPaper(hero, { english: isEnglish }) || getHeroCategoryLabel(hero, language)).toUpperCase()}</span>
                  <span className="sr-kicker-sep" />
                  {hero.journal && <span className="sr-kicker-venue">{hero.journal}</span>}
                  <span className="sr-kicker-year"><Calendar size={13} /> {hero.year}</span>
                </div>
                <h2 className="sr-hero-title"><ScientificText>{hero.title}</ScientificText></h2>
                <p className="sr-hero-authors">
                  {hero.authors?.slice(0, 4).map(a => a.name || a).join(', ')}
                  {hero.authors?.length > 4 && ' et al.'}
                </p>
                {/* The same two facts the feed card states, resolved by the same
                    module: this hero and the card had each grown their own copy
                    of the tests and had already drifted over what counts as a
                    preprint. The DOI is no longer nested inside the "not a
                    preprint" branch either — arXiv mints DOIs, and a preprint
                    that has one was losing its only link to the record. */}
                <div className="sr-hero-tags">
                  {[
                    reviewTagForPaper(hero, { english: isEnglish }),
                    accessTagForPaper(hero, { english: isEnglish, openCopyFound: Boolean(heroOpenCopy) }),
                  ].filter(Boolean).map(tag => {
                    const Glyph = STATUS_TAG_ICONS[tag.key];
                    return (
                      <span key={tag.key} className="sr-tag" data-tone={tag.tone} title={tag.hint}>
                        <Glyph size={12} /> {tag.label}
                      </span>
                    );
                  })}
                  {hero.citationCount > 0 && <span className="sr-tag"><Award size={12} /> {hero.citationCount} {isEnglish ? 'citations' : 'citas'}</span>}
                  {safeDoiUrl(hero.doi) && <a href={safeDoiUrl(hero.doi)} target="_blank" rel="noopener noreferrer" className="sr-tag sr-tag--link" onClick={e => e.stopPropagation()} title={isEnglish ? 'Open the DOI record' : 'Abrir el registro DOI'}><ExternalLink size={12} /> DOI</a>}
                </div>
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
                <blockquote className="sr-hero-abstract">
                  {hasUsableAIAbstract(hero.abstract)
                    ? <ScientificText>{hero.abstract}</ScientificText>
                    : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
                </blockquote>
              </div>
            </section>
          )}

          {/* The forme: the selection set as a newspaper section front. The
              composition is planned from the edition's own identity, so one
              edition always lays out the same way and the next one differs. */}
          {report.highlights?.length > 0 && (
            <section className="sr-highlights">
              <h2 className="sr-section-label sr-enter" style={{ '--enter-order': ENTER.label }}>
                {isEnglish ? 'Other highlighted research' : 'Otras investigaciones destacadas'}
              </h2>
              <ResearchForme
                papers={report.highlights}
                editionKey={reportContentKey}
                loading={loading}
                onSelect={setSelectedPaper}
                enterFrom={ENTER.cards}
                isEnglish={isEnglish}
              />
            </section>
          )}

          {/* The turn. A reader who reaches the foot of a selection has read
              everything this period ranked highest; the question is only
              whether there is more of it. */}
          {totalSelections > 1 && !loading && (
            <section className={`sr-turn ${currentSelection >= totalSelections ? 'is-exhausted' : ''}`}>
              <span className="sr-turn-kicker">
                {currentSelection >= totalSelections
                  ? (isEnglish ? 'End of the last selection' : 'Fin de la última tanda')
                  : (isEnglish ? `End of selection ${currentSelection}` : `Fin de la tanda ${currentSelection}`)}
              </span>
              {currentSelection >= totalSelections ? (
                <>
                  <p className="sr-turn-line">
                    {isEnglish
                      ? 'That is every paper this period had to rank. To read more, widen the period or clear a filter.'
                      : 'Eso es todo lo que este periodo tenía que ordenar. Para leer más, amplía el periodo o quita un filtro.'}
                  </p>
                  <div className="sr-turn-row">
                    {currentSelection > 1 && (
                      <button className="sr-btn" onClick={() => goToSelection(currentSelection - 1)}>
                        <ArrowLeft size={15} />
                        {isEnglish ? `Selection ${currentSelection - 1}` : `Tanda ${currentSelection - 1}`}
                      </button>
                    )}
                    {broaderTimeframe && (
                      <button
                        className="sr-btn"
                        onClick={() => { setTimeframe(broaderTimeframe); setCustomRange(null); setShowCustomPicker(false); }}
                      >
                        {isEnglish ? 'Widen the period' : 'Ampliar el periodo'}
                      </button>
                    )}
                    <span className="sr-turn-note">
                      {isEnglish
                        ? `${totalSelections} selections · ${report.corpusSize || 0} candidates ranked`
                        : `${totalSelections} tandas · ${report.corpusSize || 0} candidatos ordenados`}
                    </span>
                    {currentSelection > 2 && (
                      <button className="sr-turn-back" onClick={() => goToSelection(1)}>
                        {isEnglish ? 'Back to selection 1' : 'Volver a la tanda 1'}
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="sr-turn-line">
                    {isEnglish
                      ? `You have read the ${currentSelection * (report.editions?.perSelection || 11)} papers this period ranked highest.`
                      : `Has leído los ${currentSelection * (report.editions?.perSelection || 11)} papers mejor situados de este periodo.`}
                  </p>
                  <div className="sr-turn-row">
                    {/* Stepping back one, beside the step forward. A reader who
                        turned the page by mistake should not have to go all the
                        way to the start to undo it. */}
                    {currentSelection > 1 && (
                      <button className="sr-btn" onClick={() => goToSelection(currentSelection - 1)}>
                        <ArrowLeft size={15} />
                        {isEnglish ? `Selection ${currentSelection - 1}` : `Tanda ${currentSelection - 1}`}
                      </button>
                    )}
                    <button className="sr-btn primary" onClick={() => goToSelection(currentSelection + 1)}>
                      {isEnglish ? `Read selection ${currentSelection + 1}` : `Leer la tanda ${currentSelection + 1}`}
                      <ArrowRight size={15} />
                    </button>
                    <span className="sr-turn-note">
                      {isEnglish
                        ? `${totalSelections} selections in this period · ${report.corpusSize || 0} candidates ranked`
                        : `${totalSelections} tandas en este periodo · ${report.corpusSize || 0} candidatos ordenados`}
                    </span>
                    {currentSelection > 2 && (
                      <button className="sr-turn-back" onClick={() => goToSelection(1)}>
                        {isEnglish ? 'Back to selection 1' : 'Volver a la tanda 1'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
          </div>
          </div>

        </motion.div>
      )}

      {/* Opening a paper takes the screen, with a back arrow in the corner —
          the same move the explorer and search already made. */}
      <PaperOverlay
        open={Boolean(selectedPaper)}
        onClose={closeOverlay}
        isEnglish={isEnglish}
        label={isEnglish ? 'Paper details' : 'Detalles del paper'}
      >
        {selectedPaper && (
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
        )}
      </PaperOverlay>

    </main>
  );
}
