import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Crosshair,
  GitBranch,
  List,
  Lock,
  Network,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { getCitationGraph, getCitationGraphDoi } from '../../services/citationGraphService';
import { getRelatedPapers } from '../../services/relatedPapersService';
import { buildCitationMapLayout } from '../../utils/citationMap.js';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import {
  buildRelatedPaperEntries,
  getRelatedPaperIdentity,
} from '../../utils/relatedPaperTransition.js';
import ScientificText from '../ScientificText';
import { Toggle } from '../ui/toggle.jsx';
import { useLanguage } from '../../context/LanguageContext';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '../ui/drawer.jsx';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';

const INITIAL_GRAPH = {
  references: [],
  citations: [],
  counts: { references: 0, citations: 0 },
  source: '',
  partial: false,
  degraded: false,
};

/**
 * Centring on a neighbour is a move inside one space, not a change of screen:
 * the node travels up to the rule while everything else fades, and the new
 * neighbourhood is drawn around it. `LEAVE` is how long that trip takes;
 * `PLACEHOLDER` is how long the sheet waits, after the node lands, before it
 * admits it is waiting — with the answer in the service cache the skeleton
 * never appears at all.
 */
const WALK = { SETTLE: 40, LEAVE: 440, REVEAL: 1200, PLACEHOLDER: 320 };

/**
 * A neighbourhood that has an answer, whatever the answer is. Absent means the
 * request is still out. `error` belongs here too: the effect re-runs whenever
 * `graphs` changes, so treating a failure as unanswered would spin a hot retry
 * loop against a Worker route that reserves nine OpenAlex calls a time. The
 * retry is closing the sheet and opening it again.
 */
const SETTLED = new Set(['ready', 'empty', 'error']);

function formatCount(value, locale = 'es-ES') {
  return new Intl.NumberFormat(locale).format(Math.max(0, Number(value) || 0));
}

/** The node label has room for one word: the first author's family name. */
function nodeAuthorLabel(paper) {
  const first = paper?.authors?.[0];
  const name = String(first?.name || first || '').trim();
  if (name) return name.split(/\s+/).pop();
  return String(paper?.title || '').split(/\s+/)[0] || '';
}

function shortTitle(title, max) {
  const text = String(title || '').trim();
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function LoadingState({ label }) {
  return (
    <div className="related-state related-loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="related-skeletons" aria-hidden="true">
        {[0, 1].map(index => <span className="related-skeleton" key={index} style={{ '--skeleton-index': index }} />)}
      </div>
    </div>
  );
}

/**
 * A Base UI Drawer (ui/drawer.jsx): a bottom sheet a thumb can swipe away.
 * PaperCard mounts the sheet and unmounts it on `onClose`, so the sheet owns
 * its open state: every way out — the X, Escape, the scrim, a swipe, a paper
 * chosen from the list — takes `open` down, the primitive plays the exit
 * (the drawer's slide, or the settle-and-fade of `is-selecting-paper` in
 * PaperCard.css) and only then, from `onOpenChangeComplete(false)`, is the
 * parent told: `onSelectPaper` when a paper is waiting, `onClose` otherwise.
 * The primitive also owns the focus trap, Escape and the restore.
 */
export default function RelatedPapersSheet({ paper, onClose, onPreparePaper, onSelectPaper }) {
  const { isEnglish, locale } = useLanguage();
  const [open, setOpen] = useState(true);
  const hasGraphIdentifier = Boolean(getCitationGraphDoi(paper));
  const [mode, setMode] = useState(hasGraphIdentifier ? 'graph' : 'similar');
  const [view, setView] = useState('map');
  const [trail, setTrail] = useState([paper]);
  const [graphs, setGraphs] = useState({});
  const [papers, setPapers] = useState([]);
  const [relatedStatus, setRelatedStatus] = useState(hasGraphIdentifier ? 'idle' : 'loading');
  const [isSelectionReady, setIsSelectionReady] = useState(false);
  const [selectedPaperKey, setSelectedPaperKey] = useState(null);
  const [focusedKey, setFocusedKey] = useState(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [phase, setPhase] = useState('idle');
  const [travel, setTravel] = useState(null);
  const [hasTravelled, setHasTravelled] = useState(false);
  const [previousCenterX, setPreviousCenterX] = useState(0);
  const [hasSlid, setHasSlid] = useState(true);
  const [placeholderFor, setPlaceholderFor] = useState('');

  const closingRef = useRef(false);
  const mountedRef = useRef(false);
  const pendingSelectionRef = useRef(null);
  const closeButtonRef = useRef(null);
  const walkTimersRef = useRef([]);
  const walkingRef = useRef(false);
  const resizeRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const onPreparePaperRef = useRef(onPreparePaper);
  const onSelectPaperRef = useRef(onSelectPaper);
  const relatedRequestedRef = useRef(!hasGraphIdentifier);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onPreparePaperRef.current = onPreparePaper; }, [onPreparePaper]);
  useEffect(() => { onSelectPaperRef.current = onSelectPaper; }, [onSelectPaper]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingSelectionRef.current = null;
      walkTimersRef.current.forEach(clearTimeout);
      resizeRef.current?.disconnect();
    };
  }, []);

  const later = useCallback((ms, action) => {
    walkTimersRef.current.push(setTimeout(() => {
      if (mountedRef.current) action();
    }, ms));
  }, []);

  const finishClose = useCallback(() => {
    if (!mountedRef.current || !closingRef.current) return;
    closingRef.current = false;
    onCloseRef.current();
  }, []);

  const finishSelection = useCallback(() => {
    if (!mountedRef.current) return;
    const pendingSelection = pendingSelectionRef.current;
    if (!pendingSelection) return;
    pendingSelectionRef.current = null;
    closingRef.current = false;
    onSelectPaperRef.current(pendingSelection.paper);
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingSelectionRef.current = null;
    setIsSelectionReady(false);
    setOpen(false);
  }, []);

  const requestPaper = useCallback((relatedPaper, paperKey) => {
    if (closingRef.current) return;
    onPreparePaperRef.current?.(relatedPaper);
    pendingSelectionRef.current = { paper: relatedPaper, key: paperKey };
    closingRef.current = true;
    setSelectedPaperKey(paperKey);
    setIsSelectionReady(true);
    setOpen(false);
  }, []);

  // The primitive has finished the exit — the parent hears of it here and
  // nowhere else. A paper chosen from the sheet is handed over; anything
  // else was a dismissal.
  const handleOpenChangeComplete = useCallback((nextOpen) => {
    if (nextOpen) return;
    if (pendingSelectionRef.current) finishSelection();
    else finishClose();
  }, [finishClose, finishSelection]);

  const center = trail[trail.length - 1];
  const centerDoi = getCitationGraphDoi(center);
  const centerEntry = centerDoi ? graphs[centerDoi] : null;
  const graph = centerEntry?.data || INITIAL_GRAPH;
  const graphStatus = centerDoi ? (centerEntry?.status || 'loading') : 'unavailable';

  /**
   * No ref remembers which neighbourhoods were asked for. StrictMode mounts,
   * tears down and mounts again, and a guard like that would hand the request
   * to the run whose result the teardown throws away — the sheet would wait
   * for an answer nobody was going to deliver. The service holds one request
   * per neighbourhood and a day of cache, so asking again is free.
   */
  useEffect(() => {
    if (!centerDoi || SETTLED.has(graphs[centerDoi]?.status)) return undefined;
    let cancelled = false;
    getCitationGraph(center).then(result => {
      if (cancelled || !mountedRef.current) return;
      const data = result || INITIAL_GRAPH;
      const empty = !data.references.length && !data.citations.length;
      setGraphs(previous => ({ ...previous, [centerDoi]: { status: empty ? 'empty' : 'ready', data } }));
    }).catch(error => {
      if (cancelled || !mountedRef.current) return;
      console.error('No se pudo cargar el grafo de citas', error);
      setGraphs(previous => ({ ...previous, [centerDoi]: { status: 'error' } }));
    });
    return () => { cancelled = true; };
  }, [center, centerDoi, graphs]);

  /**
   * A placeholder that appears before the answer has had a chance to arrive
   * reads as slowness the app invented. Nothing is drawn for the first
   * `PLACEHOLDER` milliseconds; a cached neighbourhood beats the timer.
   */
  useEffect(() => {
    if (graphStatus !== 'loading') return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setPlaceholderFor(centerDoi);
    }, WALK.PLACEHOLDER);
    return () => clearTimeout(timer);
  }, [graphStatus, centerDoi]);
  const showPlaceholder = graphStatus === 'loading' && placeholderFor === centerDoi;

  useEffect(() => {
    if (mode !== 'similar' || relatedRequestedRef.current) return undefined;
    relatedRequestedRef.current = true;
    let cancelled = false;
    setRelatedStatus('loading');
    getRelatedPapers(paper).then(results => {
      if (cancelled) return;
      setPapers(results);
      setRelatedStatus(results.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setRelatedStatus('error');
    });
    return () => { cancelled = true; };
  }, [mode, paper]);

  useEffect(() => {
    if (hasGraphIdentifier) return undefined;
    let cancelled = false;
    getRelatedPapers(paper).then(results => {
      if (cancelled) return;
      setPapers(results);
      setRelatedStatus(results.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setRelatedStatus('error');
    });
    return () => { cancelled = true; };
  }, [hasGraphIdentifier, paper]);

  const measurePlot = useCallback((node) => {
    resizeRef.current?.disconnect();
    resizeRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect || !mountedRef.current) return;
      setBox({ width: Math.round(rect.width), height: Math.round(rect.height) });
    });
    observer.observe(node);
    resizeRef.current = observer;
  }, []);

  const layout = useMemo(() => buildCitationMapLayout({
    width: box.width,
    height: box.height,
    center,
    references: graph.references,
    citations: graph.citations,
  }), [box.width, box.height, center, graph]);

  const focusedNode = useMemo(
    () => layout.nodes.find(node => node.key === focusedKey) || null,
    [layout.nodes, focusedKey],
  );
  const listEntries = useMemo(() => ({
    references: buildRelatedPaperEntries(graph.references),
    citations: buildRelatedPaperEntries(graph.citations),
  }), [graph]);
  const focusedListPaper = useMemo(() => {
    if (focusedNode) return focusedNode.paper;
    const all = [...listEntries.references, ...listEntries.citations];
    return all.find(entry => `list:${entry.key}` === focusedKey)?.paper || null;
  }, [focusedNode, listEntries, focusedKey]);

  const appendToTrail = useCallback((next) => {
    setTrail(previous => {
      const identity = getRelatedPaperIdentity(next);
      const seen = previous.findIndex(item => getRelatedPaperIdentity(item) === identity);
      // A citation graph has cycles; a trail of breadcrumbs must not.
      return seen >= 0 ? previous.slice(0, seen + 1) : [...previous, next];
    });
  }, []);

  const requestCentre = useCallback((targetPaper, origin, currentCenterX) => {
    if (walkingRef.current || closingRef.current) return;
    if (!getCitationGraphDoi(targetPaper)) return;
    walkTimersRef.current.forEach(clearTimeout);
    walkTimersRef.current = [];
    setView('map');

    if (prefersReducedMotion || !origin) {
      appendToTrail(targetPaper);
      setFocusedKey(null);
      return;
    }

    walkingRef.current = true;
    setPhase('leaving');
    setTravel({ x: origin.x, y: origin.y, accent: areaAccentForPaper(targetPaper) });
    setHasTravelled(false);
    later(WALK.SETTLE, () => setHasTravelled(true));
    later(WALK.LEAVE, () => {
      // The mark slides from where the centre stood to the column its new
      // citation count earns, so the departing position is captured here.
      setPreviousCenterX(currentCenterX);
      setHasSlid(false);
      appendToTrail(targetPaper);
      setFocusedKey(null);
      setTravel(null);
      setPhase('arriving');
      later(WALK.SETTLE, () => setHasSlid(true));
      later(WALK.REVEAL, () => {
        setPhase('idle');
        walkingRef.current = false;
      });
    });
  }, [appendToTrail, later, prefersReducedMotion]);

  const goBackTo = useCallback((index) => {
    if (walkingRef.current) return;
    walkTimersRef.current.forEach(clearTimeout);
    walkTimersRef.current = [];
    setPhase('idle');
    setTravel(null);
    setHasSlid(true);
    setFocusedKey(null);
    // Going back is not a discovery: it does not get the travelling animation.
    setTrail(previous => (index < previous.length - 1 ? previous.slice(0, index + 1) : previous));
  }, []);

  const isWalking = trail.length > 1;
  const previousCentre = isWalking ? trail[trail.length - 2] : null;
  const previousIdentity = previousCentre ? getRelatedPaperIdentity(previousCentre) : '';
  const isLeaving = phase === 'leaving';
  const isArriving = phase === 'arriving';

  const graphEmptyLabel = isWalking
    ? (isEnglish
      ? 'OpenCitations has no links for this work. That happens with very recent papers, and with anything published where nobody deposits their citations.'
      : 'OpenCitations no tiene enlaces para este trabajo. Pasa con lo muy reciente, y también con lo que se publicó donde nadie deposita sus citas.')
    : (isEnglish
      ? 'No linked references or later works were found for this paper.'
      : 'No se encontraron referencias ni trabajos posteriores enlazados para este paper.');

  const visibleStatus = mode === 'graph' ? graphStatus : relatedStatus;
  const similarEntries = useMemo(() => buildRelatedPaperEntries(papers), [papers]);
  const sourceLabel = graph.source === 'opencitations' ? 'OpenCitations' : 'OpenCitations + OpenAlex';
  const isSelectingPaper = Boolean(selectedPaperKey) && isSelectionReady;
  const isMap = mode === 'graph' && view === 'map';
  const isList = mode === 'graph' && view === 'list';
  // Only the short states shrink the sheet: a map that is still loading keeps
  // its frame, because the frame is what the loading state is made of.
  const sheetStatus = visibleStatus === 'loading' && mode === 'graph' ? 'ready' : visibleStatus;

  /**
   * The list shows every paper the sheet fetched; the map can only show as
   * many as its band has 24px slots for (`citationMap.js`). Sharing one
   * headline number between them would make one of the two views lie, so
   * `context` picks which count `shown` reports — the fetch, for the list
   * that draws all of it, or `layout.shown`, for the map that may not.
   */
  const bandCaption = (relation, context = 'map') => {
    // Nothing is known until the neighbourhood lands, and "0 of 0" on both
    // bands is how a sheet that is merely waiting looks broken.
    if (graphStatus !== 'ready') return '—';
    const fetched = relation === 'reference' ? graph.references.length : graph.citations.length;
    const shown = context === 'list'
      ? fetched
      : (relation === 'reference' ? layout.shown.references : layout.shown.citations);
    const total = relation === 'reference' ? graph.counts.references : graph.counts.citations;
    const totalLabel = formatCount(Math.max(total, shown), locale);
    if (relation === 'reference') {
      return isEnglish ? `${shown} most cited of ${totalLabel}` : `${shown} más citadas de ${totalLabel}`;
    }
    return isEnglish ? `${shown} most recent of ${totalLabel}` : `${shown} más recientes de ${totalLabel}`;
  };

  const renderNode = (node) => {
    const isFocused = focusedKey === node.key;
    const accent = areaAccentForPaper(node.paper);
    const descending = isArriving && getRelatedPaperIdentity(node.paper) === previousIdentity;
    const travelling = isLeaving && travel;
    const classes = ['graph-node'];
    if (isFocused) classes.push('is-focused');
    if (travelling) classes.push(isFocused ? 'is-travelling' : 'is-fading');
    else if (descending) classes.push(node.relation === 'reference' ? 'is-arriving-up' : 'is-arriving-down');
    else classes.push('is-entering');

    const style = {
      top: `${node.y - node.rowHeight / 2}px`,
      height: `${node.rowHeight}px`,
      '--node-delay': `${node.delay}ms`,
      '--node-accent': accent,
    };
    if (node.side === 'left') style.right = `${box.width - node.x - 22}px`;
    else style.left = `${node.x - 22}px`;

    const citations = node.paper.citationCountKnown
      ? `${formatCount(node.paper.citationCount, locale)} ${isEnglish ? 'citations' : 'citas'}`
      : (isEnglish ? 'citations unknown' : 'citas desconocidas');

    return (
      <Toggle
        key={node.key}
        className={classes.join(' ')}
        data-side={node.side}
        data-relation={node.relation}
        style={style}
        onClick={() => setFocusedKey(isFocused ? null : node.key)}
        disabled={Boolean(selectedPaperKey) || isLeaving}
        pressed={isFocused}
        aria-label={`${node.paper.title} · ${node.paper.year} · ${citations}`}
      >
        <span className="graph-node-dot" aria-hidden="true"><i /></span>
        <span className="graph-node-label" aria-hidden="true">
          <b>{nodeAuthorLabel(node.paper)}</b> {`’${String(node.paper.year).slice(2)}`}
        </span>
      </Toggle>
    );
  };

  const renderPeek = () => {
    const peekPaper = focusedListPaper;
    if (!peekPaper) return null;
    const accent = areaAccentForPaper(peekPaper);
    const fieldLabel = areaLabelForPaper(peekPaper, { english: isEnglish });
    const canCentre = Boolean(getCitationGraphDoi(peekPaper));
    const focusedEntry = focusedNode
      || [...listEntries.references, ...listEntries.citations].find(entry => `list:${entry.key}` === focusedKey);
    const openKey = focusedNode ? focusedNode.key : focusedKey;

    return (
      <div className={`graph-peek ${isLeaving ? 'is-leaving' : ''}`}>
        <div className="graph-peek-meta">
          <span className="graph-peek-field" style={{ color: accent }}>{fieldLabel}</span>
          <span className="graph-peek-dot" aria-hidden="true">·</span>
          <span>{peekPaper.year}</span>
          <span className="graph-peek-dot" aria-hidden="true">·</span>
          <span>
            {peekPaper.citationCountKnown
              ? `${formatCount(peekPaper.citationCount, locale)} ${isEnglish ? 'citations' : 'citas'}`
              : (isEnglish ? 'citations unknown' : 'citas desconocidas')}
          </span>
          {peekPaper.openAccess && (
            <span className="graph-peek-open">
              <Lock size={11} aria-hidden="true" />
              {isEnglish ? 'Open access' : 'Acceso abierto'}
            </span>
          )}
          <button
            type="button"
            className="graph-peek-close"
            onClick={() => setFocusedKey(null)}
            aria-label={isEnglish ? 'Close details' : 'Cerrar ficha'}
          >
            <X size={15} />
          </button>
        </div>
        <strong className="graph-peek-title"><ScientificText>{peekPaper.title}</ScientificText></strong>
        <small className="graph-peek-authors">
          {peekPaper.authors.slice(0, 4).map(author => author.name || author).join(', ')}
        </small>
        <div className="graph-peek-actions">
          <button
            type="button"
            className="graph-peek-open-action"
            onClick={() => requestPaper(peekPaper, openKey || getRelatedPaperIdentity(peekPaper))}
            disabled={Boolean(selectedPaperKey)}
          >
            {isEnglish ? 'Open' : 'Abrir'}
          </button>
          <button
            type="button"
            className="graph-peek-centre"
            onClick={() => requestCentre(peekPaper, focusedNode, layout.centerX)}
            disabled={!canCentre || Boolean(selectedPaperKey) || phase !== 'idle'}
            title={canCentre
              ? undefined
              : (isEnglish ? 'This work has no DOI to follow' : 'Este trabajo no tiene DOI que seguir')}
          >
            <Crosshair size={15} aria-hidden="true" />
            {isEnglish ? 'Centre here' : 'Centrar aquí'}
          </button>
          {focusedEntry?.paper?.doi && (
            <span className="graph-peek-doi">{`doi:${focusedEntry.paper.doi}`}</span>
          )}
        </div>
      </div>
    );
  };

  const renderMap = () => (
    <div className="graph-map">
      <div className="graph-band-head">
        <span className="graph-band-name">{isEnglish ? 'Before · what it cites' : 'Antes · lo que cita'}</span>
        <span className="graph-band-count">
          {bandCaption('reference')}
          {layout.omitted.references > 0 && (
            <button type="button" className="graph-omitted" onClick={() => setView('list')}>
              {isEnglish ? `+${layout.omitted.references} in the list` : `+${layout.omitted.references} en la lista`}
            </button>
          )}
        </span>
      </div>

      <div className="graph-plot" ref={measurePlot}>
        {layout.ready && (
          <>
            <svg className="graph-lines" width={box.width} height={box.height} aria-hidden="true">
              {layout.ticks.map(tick => (
                <line key={`tick-${tick.value}`} className="graph-grid" x1={tick.x} y1="0" x2={tick.x} y2={box.height} />
              ))}
              {layout.nodes.map(node => (
                <line
                  key={`edge-${node.key}`}
                  className={`graph-edge ${focusedKey === node.key ? 'is-focused' : ''} ${focusedKey && focusedKey !== node.key ? 'is-dimmed' : ''} ${isLeaving ? 'is-gone' : ''}`}
                  x1={layout.centerX}
                  y1={layout.ruleY}
                  x2={node.x}
                  y2={node.y}
                  style={{ '--edge-delay': `${node.edgeDelay}ms` }}
                />
              ))}
            </svg>

            <div className="graph-rule" style={{ top: `${layout.ruleY}px`, transformOrigin: `${layout.centerX}px 50%` }} />
            <div
              className={`graph-mark ${isLeaving ? 'is-gone' : ''} ${isArriving ? 'is-sliding' : ''}`}
              style={{
                left: `${(isArriving && !hasSlid ? previousCenterX : layout.centerX) - 8}px`,
                top: `${layout.ruleY - 8}px`,
              }}
            />
            <span
              className={`graph-chip ${isLeaving ? 'is-gone' : ''}`}
              data-side={layout.centerX > box.width - 180 ? 'left' : 'right'}
              style={layout.centerX > box.width - 180
                ? { right: `${box.width - layout.centerX + 16}px`, top: `${layout.ruleY}px` }
                : { left: `${layout.centerX + 16}px`, top: `${layout.ruleY}px` }}
            >
              {isWalking
                ? `${isEnglish ? 'Centre' : 'Centro'} · ${center.year}`
                : `${isEnglish ? 'This paper' : 'Este paper'} · ${center.year}`}
            </span>

            {graphStatus === 'ready' && layout.nodes.map(renderNode)}

            {graphStatus === 'loading' && showPlaceholder && Array.from({ length: 12 }, (_, index) => {
              const above = index < 6;
              const columns = 6;
              const spread = Math.max(0, box.width - 60);
              return (
                <span
                  key={`skeleton-${index}`}
                  className="graph-skeleton"
                  aria-hidden="true"
                  style={{
                    left: `${30 + ((index % columns) + 0.5) / columns * spread + (above ? 0 : 24)}px`,
                    top: `${above
                      ? layout.bands.references.top + 18 + (index % columns) * 20
                      : layout.bands.citations.top + 14 + (index % columns) * 20}px`,
                    '--skeleton-delay': `${index * 70}ms`,
                  }}
                />
              );
            })}

            {travel && (
              <span
                className="graph-travel"
                aria-hidden="true"
                style={{
                  left: `${travel.x}px`,
                  top: `${hasTravelled ? layout.ruleY : travel.y}px`,
                  background: hasTravelled ? 'var(--accent-primary)' : travel.accent,
                  transform: `scale(${hasTravelled ? 1.45 : 1.28})`,
                }}
              />
            )}
          </>
        )}
      </div>

      <div className="graph-band-head">
        <span className="graph-band-name">{isEnglish ? 'After · what cites it' : 'Después · quien lo cita'}</span>
        <span className="graph-band-count">
          {bandCaption('citation')}
          {layout.omitted.citations > 0 && (
            <button type="button" className="graph-omitted" onClick={() => setView('list')}>
              {isEnglish ? `+${layout.omitted.citations} in the list` : `+${layout.omitted.citations} en la lista`}
            </button>
          )}
        </span>
      </div>

      <div className="graph-axis">
        {layout.ticks.length > 0 && layout.ticks[0].x > 110 && (
          <span className="graph-axis-name">{isEnglish ? 'Citations received' : 'Citas recibidas'}</span>
        )}
        {layout.ticks.map(tick => (
          <span key={`label-${tick.value}`} className="graph-axis-tick" style={{ left: `${tick.x}px` }}>{tick.label}</span>
        ))}
      </div>
    </div>
  );

  const renderList = () => (
    <div className="related-list" key={`list-${trail.length}`}>
      {[
        { relation: 'reference', entries: listEntries.references },
        { relation: 'citation', entries: listEntries.citations },
      ].map(({ relation, entries }) => (entries.length ? (
        <div key={relation}>
          <div className="graph-list-head">
            <span className="graph-band-name">
              {relation === 'reference'
                ? (isEnglish ? 'Before · what it cites' : 'Antes · lo que cita')
                : (isEnglish ? 'After · what cites it' : 'Después · quien lo cita')}
            </span>
            <span className="graph-band-count">{bandCaption(relation, 'list')}</span>
          </div>
          {entries.map(({ paper: related, key }, index) => {
            const listKey = `list:${key}`;
            return (
              <Toggle
                key={key}
                className={`related-item ${focusedKey === listKey ? 'is-selected' : ''}`}
                style={{ '--related-index': index }}
                onClick={() => setFocusedKey(focusedKey === listKey ? null : listKey)}
                disabled={Boolean(selectedPaperKey)}
                pressed={focusedKey === listKey}
              >
                <span
                  className={`graph-list-dot ${relation === 'reference' ? 'is-hollow' : 'is-filled'}`}
                  style={{ '--node-accent': areaAccentForPaper(related) }}
                  aria-hidden="true"
                />
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>
                    {related.authors.slice(0, 2).map(author => author.name || author).join(', ')}
                    {related.year ? ` · ${related.year}` : ''}
                    {related.citationCountKnown ? ` · ${related.citationCount} ${isEnglish ? 'citations' : 'citas'}` : ''}
                  </small>
                </span>
                <ChevronRight size={18} />
              </Toggle>
            );
          })}
        </div>
      ) : null))}
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}
      onOpenChangeComplete={handleOpenChangeComplete}
    >
      <DrawerContent
        render={<section />}
        className={`related-sheet related-sheet--graph related-sheet--${sheetStatus} ${isSelectingPaper ? 'is-selecting-paper' : ''}`}
        overlayClassName="related-overlay"
        aria-modal="true"
        aria-busy={visibleStatus === 'loading'}
        // The X, not the first tabbable thing (the map/list switch): a
        // keyboard user who opened the sheet by mistake leaves it at once.
        initialFocus={closeButtonRef}
      >
        <div className="related-grabber" aria-hidden="true" />
        <header className="related-header">
          <div>
            <Network size={18} />
            <DrawerTitle render={<h3 />}>{isEnglish ? 'Paper connections' : 'Conexiones del paper'}</DrawerTitle>
          </div>
          <div className="related-header-actions">
            {mode === 'graph' && (
              <>
                {/* Single-select, and a press on the pressed one reports []:
                    the view never goes to "neither". */}
                <ToggleGroup
                  className="graph-view-toggle"
                  value={[view]}
                  onValueChange={([next]) => { if (next) setView(next); }}
                  aria-label={isEnglish ? 'Graph view' : 'Vista del grafo'}
                >
                  <ToggleGroupItem
                    value="map"
                    size="icon"
                    className="graph-view-button"
                    aria-label={isEnglish ? 'Map view' : 'Ver como mapa'}
                    title={isEnglish ? 'Map' : 'Mapa'}
                  >
                    <Network size={17} />
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="list"
                    size="icon"
                    className="graph-view-button"
                    aria-label={isEnglish ? 'List view' : 'Ver como lista'}
                    title={isEnglish ? 'List' : 'Lista'}
                  >
                    <List size={17} />
                  </ToggleGroupItem>
                </ToggleGroup>
                <span className="related-header-divider" aria-hidden="true" />
              </>
            )}
            <DrawerClose
              ref={closeButtonRef}
              aria-label={isEnglish ? 'Close' : 'Cerrar'}
              title={isEnglish ? 'Close' : 'Cerrar'}
            >
              <X size={20} />
            </DrawerClose>
          </div>
        </header>

        {/* ui/tabs.jsx, in the pill shape the sheet has always drawn: the
            content below is switched by `mode` rather than held in panels,
            because most of it is shared between the two. */}
        <Tabs value={mode} onValueChange={(next) => setMode(next)}>
          <TabsList variant="pill" className="related-mode-tabs" aria-label={isEnglish ? 'Connection type' : 'Tipo de conexión'}>
            <TabsTrigger value="graph" disabled={!hasGraphIdentifier || Boolean(selectedPaperKey)}>
              <GitBranch size={16} />{isEnglish ? 'Graph' : 'Grafo'}
            </TabsTrigger>
            <TabsTrigger value="similar" disabled={Boolean(selectedPaperKey)}>
              <Sparkles size={16} />{isEnglish ? 'Similar' : 'Similares'}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'graph' && (
          <div className="graph-trail" aria-label={isEnglish ? 'Path through the graph' : 'Recorrido por el grafo'}>
            {isWalking && (
              <button
                type="button"
                className="graph-trail-back"
                onClick={() => goBackTo(trail.length - 2)}
                aria-label={isEnglish ? 'Back' : 'Atrás'}
                title={isEnglish ? 'Back' : 'Atrás'}
              >
                <ArrowLeft size={15} />
              </button>
            )}
            <span className="graph-trail-label">
              {isWalking ? (isEnglish ? 'Path' : 'Recorrido') : (isEnglish ? 'This paper' : 'Este paper')}
            </span>
            <div className="graph-trail-steps">
              {trail.map((step, index) => {
                const last = index === trail.length - 1;
                return (
                  <span className="graph-trail-step" key={getRelatedPaperIdentity(step) || index}>
                    {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
                    <button
                      type="button"
                      className={`graph-crumb ${last ? 'is-current' : ''}`}
                      onClick={() => goBackTo(index)}
                      aria-current={last ? 'true' : undefined}
                    >
                      {shortTitle(step.title, last ? 40 : 22)}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {mode === 'graph' && graph.degraded && graphStatus === 'ready' && (
          <p className="graph-degraded" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            {isEnglish
              ? 'Incomplete neighbourhood — one source did not answer, and this is what the other could give.'
              : 'Vecindario incompleto — una fuente no respondió, y esto es lo que la otra pudo dar.'}
          </p>
        )}

        {isMap && (graphStatus === 'ready' || graphStatus === 'loading') && renderMap()}
        {isList && graphStatus === 'ready' && renderList()}

        {mode === 'similar' && visibleStatus === 'loading' && (
          <LoadingState label={isEnglish ? 'Finding connections...' : 'Buscando conexiones...'} />
        )}
        {visibleStatus === 'unavailable' && (
          <div className="related-state">
            {isEnglish ? 'The bibliographic graph needs a valid DOI.' : 'El grafo bibliográfico necesita un DOI válido.'}
          </div>
        )}
        {visibleStatus === 'empty' && (
          <div className="related-state graph-state">
            <p>
              {mode === 'graph'
                ? graphEmptyLabel
                : (isEnglish ? 'No recommendations are available for this paper.' : 'No hay recomendaciones disponibles para este paper.')}
            </p>
            {mode === 'graph' && isWalking && (
              <button type="button" className="graph-back-button" onClick={() => goBackTo(trail.length - 2)}>
                <ArrowLeft size={15} aria-hidden="true" />
                {isEnglish ? 'Back to' : 'Volver a'} {shortTitle(previousCentre?.title, 24)}
              </button>
            )}
          </div>
        )}
        {visibleStatus === 'error' && (
          <div className="related-state">
            {isEnglish
              ? 'These connections could not be loaded right now. The rest of PaperTok will continue to work normally.'
              : 'No se pudieron cargar estas conexiones ahora. El resto de PaperTok seguirá funcionando con normalidad.'}
          </div>
        )}

        {mode === 'similar' && visibleStatus === 'ready' && (
          <div className="related-list" key="similar">
            {similarEntries.map(({ paper: related, key }, index) => (
              <button
                key={key}
                type="button"
                className={`related-item ${selectedPaperKey === key ? 'is-selected' : ''}`}
                style={{ '--related-index': index }}
                onClick={() => requestPaper(related, key)}
                disabled={Boolean(selectedPaperKey)}
              >
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>
                    {related.authors.slice(0, 2).map(author => author.name || author).join(', ')}
                    {related.year ? ` · ${related.year}` : ''}
                    {related.citationCountKnown ? ` · ${related.citationCount} ${isEnglish ? 'citations' : 'citas'}` : ''}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
        )}

        {mode === 'graph' && renderPeek()}

        {mode === 'graph' && graphStatus === 'ready' && (
          <div className="knowledge-source">
            <span>{sourceLabel}</span>
            <span>{isEnglish ? 'One hop · cached 24 h' : 'Un salto · en caché 24 h'}</span>
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}
