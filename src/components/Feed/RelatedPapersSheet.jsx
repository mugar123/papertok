import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowsClockwise,
  CaretRight,
  Crosshair,
  GitBranch,
  Graph,
  LockOpen,
  Sparkle,
  Stack,
  Warning,
  X,
} from '@phosphor-icons/react';
import { useReducedMotion } from 'framer-motion';
import { getCitationGraph, getCitationGraphDoi } from '../../services/citationGraphService';
import { getRelatedPapers } from '../../services/relatedPapersService';
import { isSignInRequiredError } from '../../utils/signInRequired.js';
import { CITATION_MAP_GEOMETRY, buildCitationMapLayout } from '../../utils/citationMap.js';
import { STAR_PATH } from '../../utils/starPath.js';
import { areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import {
  buildRelatedPaperEntries,
  getRelatedPaperIdentity,
} from '../../utils/relatedPaperTransition.js';
import ScientificText from '../ScientificText';
import { Toggle } from '../ui/toggle.jsx';
import { EmptyState } from '../ui/empty-state.jsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.jsx';
import useClipTooltip from '../../hooks/useClipTooltip.js';
import { Button } from '../ui/button.jsx';
import Petri from '../Onboarding/Petri.jsx';
import { useLanguage } from '../../context/LanguageContext';
import { usePopupOpenOnMount } from '../../hooks/usePopupOpenOnMount.js';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '../ui/drawer.jsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.jsx';
import useIsPhone from '../../hooks/useIsPhone.js';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.jsx';

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
// `signin`: the Worker routes behind both views are session-only, and a
// missing or expired session is not a provider failure worth an «ahora».
const SETTLED = new Set(['ready', 'empty', 'error', 'signin']);

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

/** A step of the walked path, shortened to fit: the whole title is its name,
    and resting on it shows that title, but only when the step is cut —
    shortened here or ellipsed by its width (a phone's narrower crumb). */
function PathCrumb({ title, max, current, onSelect }) {
  const text = shortTitle(title, max);
  const { ref, ...tooltip } = useClipTooltip(text !== String(title || '').trim());
  return (
    <Tooltip {...tooltip}>
      <TooltipTrigger
        render={(
          <button
            ref={ref}
            type="button"
            className={`graph-crumb ${current ? 'is-current' : ''}`}
            onClick={onSelect}
            aria-current={current ? 'true' : undefined}
            aria-label={title}
          />
        )}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
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
 * A centred Base UI Dialog (ui/dialog.jsx) on a wider screen, and a Drawer
 * (ui/drawer.jsx) on a phone: a bottom sheet a thumb can swipe away, the same
 * split the save window makes.
 * PaperCard mounts the sheet and unmounts it on `onClose`, so the sheet owns
 * its open state — mounted closed and opened on the next frame, which is the
 * price of arriving instead of appearing (`usePopupOpenOnMount`: the drawer's
 * whole entrance lives in `data-starting-style`, and Base UI does not give
 * that to a popup that was already open on its first render). Every way out
 * — the X, Escape, the scrim, a swipe, a paper chosen from the list — takes
 * `open` down, the primitive plays the exit (the drawer's slide, or the
 * settle-and-fade of `is-selecting-paper` in PaperCard.css) and only then,
 * from `onOpenChangeComplete(false)`, is the parent told: `onSelectPaper`
 * when a paper is waiting, `onClose` otherwise. The primitive also owns the
 * focus trap, Escape and the restore.
 *
 * `inline` is the third form: no popup at all, the panel the rail's
 * Connections tile puts where the card's abstract was. The tile is its name
 * and its way back, so it draws no title and no X, and with no exit to wait
 * for, a chosen paper reaches the parent at once.
 */
function InlineRoot({ children }) {
  return children;
}

export default function RelatedPapersSheet({ paper, inline = false, onClose, onPreparePaper, onSelectPaper }) {
  const { locale } = useLanguage();
  const { open, setOpen } = usePopupOpenOnMount();
  const isPhone = useIsPhone();
  const Root = inline ? InlineRoot : isPhone ? Drawer : Dialog;
  const Content = inline ? 'section' : isPhone ? DrawerContent : DialogContent;
  const Title = isPhone ? DrawerTitle : DialogTitle;
  const Close = isPhone ? DrawerClose : DialogClose;
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
  // The node (or its edge) under a mouse: lifted, its edge inked, the rest
  // stepped back. Touch has no hover; a tap focuses instead.
  const [hoveredKey, setHoveredKey] = useState(null);
  const hoverProps = (key) => ({
    onPointerEnter: (event) => { if (event.pointerType === 'mouse') setHoveredKey(key); },
    onPointerLeave: () => setHoveredKey(current => (current === key ? null : current)),
  });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [phase, setPhase] = useState('idle');
  const [travel, setTravel] = useState(null);
  const [hasTravelled, setHasTravelled] = useState(false);
  const [previousCenter, setPreviousCenter] = useState({ x: 0, y: 0 });
  const [hasSlid, setHasSlid] = useState(true);
  const [placeholderFor, setPlaceholderFor] = useState('');
  // Back on a map already drawn (from the list, or from Similar): it is the
  // same map, so it stands rather than arriving again. A new centre clears it.
  const [isMapReturning, setIsMapReturning] = useState(false);
  // A list arrives with the panel only: one reached by switching (Graph and
  // Similar, map and list) just stands there.
  const [hasSwitched, setHasSwitched] = useState(false);

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

  // A picked paper's preview closes on a press anywhere else, as a popover
  // would. Presses on the preview, or on another star, line or row (which
  // pick their own paper), are left to their own handlers.
  useEffect(() => {
    if (!focusedKey) return undefined;
    const dismiss = (event) => {
      if (event.target instanceof Element
        && event.target.closest('.graph-peek, .graph-node, .graph-edge-hit, .related-item')) return;
      setFocusedKey(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [focusedKey]);

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
  }, [setOpen]);

  const requestPaper = useCallback((relatedPaper, paperKey) => {
    if (closingRef.current) return;
    onPreparePaperRef.current?.(relatedPaper);
    pendingSelectionRef.current = { paper: relatedPaper, key: paperKey };
    closingRef.current = true;
    setSelectedPaperKey(paperKey);
    setIsSelectionReady(true);
    setOpen(false);
    // Inline there is no exit to wait for.
    if (inline) finishSelection();
  }, [setOpen, inline, finishSelection]);

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
      console.error('Could not load the citation graph', error);
      setGraphs(previous => ({ ...previous, [centerDoi]: { status: isSignInRequiredError(error) ? 'signin' : 'error' } }));
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
  // A failed neighbourhood is forgotten, so the fetch above asks again.
  const retryGraph = () => setGraphs((previous) => {
    const next = { ...previous };
    delete next[centerDoi];
    return next;
  });

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
      setRelatedStatus(isSignInRequiredError(error) ? 'signin' : 'error');
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
      setRelatedStatus(isSignInRequiredError(error) ? 'signin' : 'error');
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
    setIsMapReturning(false);
    setTrail(previous => {
      const identity = getRelatedPaperIdentity(next);
      const seen = previous.findIndex(item => getRelatedPaperIdentity(item) === identity);
      // A citation graph has cycles; a trail of breadcrumbs must not.
      return seen >= 0 ? previous.slice(0, seen + 1) : [...previous, next];
    });
  }, []);

  const requestCentre = useCallback((targetPaper, origin, currentCenter) => {
    if (walkingRef.current || closingRef.current) return;
    if (!getCitationGraphDoi(targetPaper)) return;
    setIsMapReturning(false);
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
      // The mark slides from where the centre stood to the spot its new year
      // and citation count earn, so the departing position is captured here.
      setPreviousCenter(currentCenter);
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
    setIsMapReturning(false);
    setTrail(previous => (index < previous.length - 1 ? previous.slice(0, index + 1) : previous));
  }, []);

  const isWalking = trail.length > 1;
  const previousCentre = isWalking ? trail[trail.length - 2] : null;
  const previousIdentity = previousCentre ? getRelatedPaperIdentity(previousCentre) : '';
  const isLeaving = phase === 'leaving';
  const isArriving = phase === 'arriving';

  const graphEmptyLabel = isWalking
    ? ('OpenCitations has no links for this work. That happens with very recent papers, and with anything published where nobody deposits their citations.')
    : ('No linked references or later works were found for this paper.');

  const visibleStatus = mode === 'graph' ? graphStatus : relatedStatus;
  const similarEntries = useMemo(() => buildRelatedPaperEntries(papers), [papers]);
  const isSelectingPaper = Boolean(selectedPaperKey) && isSelectionReady;
  // Which side of the dot the label sits on. Decided from the settled column,
  // so it commits once and the slide below carries the crossing.
  const chipOnLeft = layout.chipSide === 'left';
  const isMap = mode === 'graph' && view === 'map';
  const isList = mode === 'graph' && view === 'list';
  // Only the short states shrink the sheet: a map that is still loading keeps
  // its frame, because the frame is what the loading state is made of.
  const sheetStatus = visibleStatus === 'loading' && mode === 'graph' ? 'ready' : visibleStatus;

  const renderNode = (node) => {
    const isFocused = focusedKey === node.key;
    const accent = areaAccentForPaper(node.paper);
    const descending = isArriving && getRelatedPaperIdentity(node.paper) === previousIdentity;
    const travelling = isLeaving && travel;
    const classes = ['graph-node'];
    if (isFocused) classes.push('is-focused');
    if (hoveredKey === node.key) classes.push('is-hovered');
    if (node.labelHidden) classes.push('is-label-hidden');
    if (travelling) classes.push(isFocused ? 'is-travelling' : 'is-fading');
    else if (descending) classes.push(node.relation === 'reference' ? 'is-arriving-up' : 'is-arriving-down');
    else classes.push('is-entering');

    const style = {
      top: `${node.y - CITATION_MAP_GEOMETRY.minGap / 2}px`,
      height: `${CITATION_MAP_GEOMETRY.minGap}px`,
      '--node-delay': `${node.delay}ms`,
      '--node-accent': accent,
    };
    // The star's 24px cell is centred on the node's point.
    if (node.side === 'left') style.right = `${box.width - node.x - 12}px`;
    else style.left = `${node.x - 12}px`;

    const citations = node.paper.citationCountKnown
      ? `${formatCount(node.paper.citationCount, locale)} ${'citations'}`
      : ('citations unknown');

    // The label is a surname and a year; resting on the star names the
    // paper. A picked star's preview already does, so its tooltip stays off.
    return (
      <Tooltip key={node.key} disabled={isFocused}>
        <TooltipTrigger
          render={(
            <Toggle
              className={classes.join(' ')}
              {...hoverProps(node.key)}
              data-side={node.side}
              data-relation={node.relation}
              style={style}
              onClick={() => setFocusedKey(isFocused ? null : node.key)}
              disabled={Boolean(selectedPaperKey) || isLeaving}
              pressed={isFocused}
              aria-label={`${node.paper.title} · ${node.paper.year} · ${citations}`}
            />
          )}
        >
          <span className="graph-node-dot" aria-hidden="true">
            <svg className="graph-node-star" viewBox="0 0 24 24"><path d={STAR_PATH} /></svg>
          </span>
          <span className="graph-node-label" aria-hidden="true">
            <b>{nodeAuthorLabel(node.paper)}</b> {node.paper.year}
          </span>
        </TooltipTrigger>
        <TooltipContent>{node.paper.title}</TooltipContent>
      </Tooltip>
    );
  };

  const renderPeek = () => {
    const peekPaper = focusedListPaper;
    if (!peekPaper) return null;
    const accent = areaAccentForPaper(peekPaper);
    const fieldLabel = areaLabelForPaper(peekPaper);
    const canCentre = Boolean(getCitationGraphDoi(peekPaper));
    const focusedEntry = focusedNode
      || [...listEntries.references, ...listEntries.citations].find(entry => `list:${entry.key}` === focusedKey);
    const openKey = focusedNode ? focusedNode.key : focusedKey;

    return (
      <div className={`graph-peek ${isLeaving ? 'is-leaving' : ''}`}>
        <div className="graph-peek-head">
          <strong className="graph-peek-title"><ScientificText>{peekPaper.title}</ScientificText></strong>
          <button
            type="button"
            className="graph-peek-close"
            onClick={() => setFocusedKey(null)}
            aria-label={'Close details'}
          >
            <X size={15} />
          </button>
        </div>
        {/* Under the title, the card's chips (PaperCard.css `.pc-chip`): the
            field in its own ink, the year and count neutral, open access in
            green. */}
        <div className="graph-peek-meta">
          {fieldLabel && (
            <span className="pc-chip graph-peek-field" style={{ '--chip-accent': accent }}>{fieldLabel}</span>
          )}
          {peekPaper.year && <span className="pc-chip">{peekPaper.year}</span>}
          <span className="pc-chip">
            {peekPaper.citationCountKnown
              ? `${formatCount(peekPaper.citationCount, locale)} ${'citations'}`
              : ('citations unknown')}
          </span>
          {peekPaper.openAccess && (
            <span className="pc-chip" data-tone="green">
              <LockOpen size={12} aria-hidden="true" />
              {'Open access'}
            </span>
          )}
        </div>
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
            {'Open'}
          </button>
          <button
            type="button"
            className="graph-peek-centre"
            onClick={() => requestCentre(peekPaper, focusedNode, { x: layout.centerX, y: layout.centerY })}
            disabled={!canCentre || Boolean(selectedPaperKey) || phase !== 'idle'}
            title={canCentre
              ? undefined
              : ('This work has no DOI to follow')}
          >
            <Crosshair size={15} aria-hidden="true" />
            {'Centre here'}
          </button>
          {focusedEntry?.paper?.doi && (
            <span className="graph-peek-doi">{`doi:${focusedEntry.paper.doi}`}</span>
          )}
        </div>
      </div>
    );
  };

  const renderMap = () => (
    <div className={`graph-map ${isMapReturning ? 'is-returning' : ''}`}>
      <div className="graph-plot" ref={measurePlot} data-lit={hoveredKey || focusedKey ? '' : undefined}>
        {layout.ready && (
          <>
            <svg className="graph-lines" width={box.width} height={box.height} aria-hidden="true">
              {layout.yearTicks.map(tick => (
                <line key={`year-${tick.year}`} className="graph-grid" x1={tick.x} y1={layout.plot.top} x2={tick.x} y2={layout.plot.bottom} />
              ))}
              {layout.ticks.map(tick => (
                <line key={`tick-${tick.value}`} className="graph-grid graph-grid--scale" x1={layout.plot.left} y1={tick.y} x2={layout.plot.right} y2={tick.y} />
              ))}
              {/* The centre paper's year, top to bottom. */}
              <line className="graph-now" x1={layout.centerX} y1={layout.plot.top} x2={layout.centerX} y2={layout.plot.bottom} />
              {layout.nodes.map(node => {
                const lit = hoveredKey || focusedKey;
                // Straight from the centre to the star.
                const curve = `M${layout.centerX},${layout.centerY} L${node.x},${node.y}`;
                return (
                  <g key={`edge-${node.key}`} {...hoverProps(node.key)}>
                    <path
                      className={`graph-edge ${focusedKey === node.key ? 'is-focused' : ''} ${hoveredKey === node.key ? 'is-hovered' : ''} ${lit && lit !== node.key ? 'is-dimmed' : ''} ${isLeaving ? 'is-gone' : ''}`}
                      d={curve}
                      style={{ '--edge-delay': `${node.edgeDelay}ms`, '--edge-accent': areaAccentForPaper(node.paper) }}
                    />
                    {/* A 1px line is too thin to aim at: this wider, unpainted
                        twin is what the pointer finds, and a press anywhere
                        on it picks its star. The star's own button is the
                        way in for the keyboard and assistive tech. */}
                    <path
                      className="graph-edge-hit"
                      d={curve}
                      onClick={() => setFocusedKey(focusedKey === node.key ? null : node.key)}
                    />
                  </g>
                );
              })}
            </svg>

            <span className="graph-scale-name">{'Citations'}</span>
            {layout.ticks.map(tick => (
              <span key={`scale-${tick.value}`} className="graph-scale-tick" style={{ top: `${tick.y}px` }}>{tick.label}</span>
            ))}
            {/* The column each of these stands in is handed over as
                `--mark-x` / `--chip-x`, which PaperCard.css puts on the
                native `translate` property and transitions. That is what
                makes the centre MOVE when the neighbourhood arrives and
                builds the axis under it, instead of teleporting 533px
                across the plot in one frame. */}
            <div
              className={`graph-mark ${isLeaving ? 'is-gone' : ''} ${isArriving ? 'is-sliding' : ''}`}
              style={{
                '--mark-x': `${(isArriving && !hasSlid ? previousCenter.x : layout.centerX) - 8}px`,
                '--mark-y': `${(isArriving && !hasSlid ? previousCenter.y : layout.centerY) - 8}px`,
              }}
            />
            <span
              className={`graph-chip ${isLeaving ? 'is-gone' : ''}`}
              data-side={chipOnLeft ? 'left' : 'right'}
              style={{
                // Both sides are measured from the same edge, so crossing over
                // is one value changing rather than two anchors swapping.
                '--chip-x': chipOnLeft
                  ? `calc(${layout.centerX - 16}px - 100%)`
                  : `${layout.centerX + 16}px`,
                '--chip-y': `${layout.centerY}px`,
              }}
            >
              {isWalking
                ? `${'Centre'} · ${center.year}`
                : `${'This paper'} · ${center.year}`}
            </span>

            {graphStatus === 'ready' && layout.nodes.map(renderNode)}

            {graphStatus === 'loading' && showPlaceholder && Array.from({ length: 12 }, (_, index) => {
              const before = index < 6;
              const columns = 6;
              const half = Math.max(0, box.width / 2 - 70);
              return (
                <span
                  key={`skeleton-${index}`}
                  className="graph-skeleton"
                  aria-hidden="true"
                  style={{
                    left: `${(before ? 50 : box.width / 2 + 20) + ((index % columns) + 0.5) / columns * half}px`,
                    top: `${box.height * (0.25 + ((index * 37) % 50) / 100)}px`,
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
                  translate: `${hasTravelled ? layout.centerX : travel.x}px ${hasTravelled ? layout.centerY : travel.y}px`,
                  background: hasTravelled ? 'var(--accent-primary)' : travel.accent,
                  transform: `scale(${hasTravelled ? 1.45 : 1.28})`,
                }}
              />
            )}
          </>
        )}
      </div>

      {/* Years along the bottom; the citation scale is labelled up the left
          of the plot (`graph-scale-tick`). */}
      <div className="graph-axis">
        {layout.yearTicks.map(tick => (
          <span key={`year-${tick.year}`} className="graph-axis-tick" style={{ left: `${tick.x}px` }}>{tick.year}</span>
        ))}
      </div>
    </div>
  );

  const renderList = () => (
    <div className={`related-list ${hasSwitched ? 'is-switched' : ''}`} key={`list-${trail.length}`}>
      {[
        { relation: 'reference', entries: listEntries.references },
        { relation: 'citation', entries: listEntries.citations },
      ].map(({ relation, entries }) => (entries.length ? (
        <div key={relation}>
          {entries.map(({ paper: related, key }) => {
            const listKey = `list:${key}`;
            return (
              <Toggle
                key={key}
                className={`related-item ${focusedKey === listKey ? 'is-selected' : ''}`}
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
                    {related.citationCountKnown ? ` · ${related.citationCount} ${'citations'}` : ''}
                  </small>
                </span>
                <CaretRight size={18} />
              </Toggle>
            );
          })}
        </div>
      ) : null))}
    </div>
  );

  // ui/tabs.jsx, in the pill shape the sheet has always drawn: the content
  // below is switched by `mode` rather than held in panels, because most of
  // it is shared between the two. Inline, with no title, it heads the panel.
  const modeTabs = (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        if (next === 'graph' && graphStatus === 'ready') setIsMapReturning(true);
        setHasSwitched(true);
        setMode(next);
      }}
    >
      <TabsList
        variant="pill"
        className="related-mode-tabs"
        aria-label={'Connection type'}
        style={{ '--mode-index': mode === 'graph' ? 0 : 1 }}
      >
        <span className="related-mode-pill" aria-hidden="true" />
        <TabsTrigger value="graph" disabled={!hasGraphIdentifier || Boolean(selectedPaperKey)}>
          <GitBranch size={16} />{'Graph'}
        </TabsTrigger>
        <TabsTrigger value="similar" disabled={Boolean(selectedPaperKey)}>
          <Sparkle size={16} />{'Similar'}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <Root
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) requestClose(); }}
      onOpenChangeComplete={handleOpenChangeComplete}
    >
      <Content
        className={`related-sheet related-sheet--graph related-sheet--${sheetStatus} ${inline ? 'related-sheet--inline' : isPhone ? '' : 'related-sheet--dialog'} ${isSelectingPaper ? 'is-selecting-paper' : ''}`}
        aria-busy={visibleStatus === 'loading'}
        {...(inline ? { 'aria-label': 'Paper connections' } : {
          render: <section />,
          ...(isPhone ? {} : { showClose: false }),
          overlayClassName: 'related-overlay',
          'aria-modal': 'true',
          // The X, not the first tabbable thing (the map/list switch): a
          // keyboard user who opened the sheet by mistake leaves it at once.
          initialFocus: closeButtonRef,
        })}
      >
        {isPhone && !inline && <div className="related-grabber" aria-hidden="true" />}
        <header className="related-header">
          {inline ? modeTabs : (
            <div>
              <Graph size={18} />
              <Title render={<h3 />}>{'Paper connections'}</Title>
            </div>
          )}
          <div className="related-header-actions">
            {mode === 'graph' && (
              <>
                {/* One button: pressed, the graph reads as a list; released,
                    as the map. The name stays and the pressed state carries
                    the change (the theme toggle's reasoning). */}
                <Toggle
                  size="icon"
                  className="graph-view-button"
                  pressed={view === 'list'}
                  onPressedChange={(next) => {
                    if (!next) setIsMapReturning(true);
                    setHasSwitched(true);
                    setView(next ? 'list' : 'map');
                  }}
                  aria-label={'List view'}
                  title={'List view'}
                >
                  <Stack size={17} />
                </Toggle>
                {!inline && <span className="related-header-divider" aria-hidden="true" />}
              </>
            )}
            {!inline && (
              <Close
                ref={closeButtonRef}
                aria-label={'Close'}
                title={'Close'}
              >
                <X size={20} />
              </Close>
            )}
          </div>
        </header>

        {!inline && modeTabs}

        {/* The trail shows once there is a path to go back along; before
            that it would only repeat the paper the panel was opened from. */}
        {mode === 'graph' && isWalking && (
          <div className="graph-trail" aria-label={'Path through the graph'}>
            {/* Tooltips name what the shortened path hides: where Back goes,
                and each step's whole title. */}
            {isWalking && (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <button
                      type="button"
                      className="graph-trail-back"
                      onClick={() => goBackTo(trail.length - 2)}
                      aria-label={'Back'}
                    />
                  )}
                >
                  <ArrowLeft size={15} />
                </TooltipTrigger>
                <TooltipContent>{`Back to ${previousCentre?.title || 'the previous paper'}`}</TooltipContent>
              </Tooltip>
            )}
            <span className="graph-trail-label">
              {isWalking ? ('Path') : ('This paper')}
            </span>
            <div className="graph-trail-steps">
              {trail.map((step, index) => {
                const last = index === trail.length - 1;
                return (
                  <span className="graph-trail-step" key={getRelatedPaperIdentity(step) || index}>
                    {index > 0 && <CaretRight size={12} aria-hidden="true" />}
                    <PathCrumb
                      title={step.title}
                      max={last ? 40 : 22}
                      current={last}
                      onSelect={() => goBackTo(index)}
                    />
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {mode === 'graph' && graph.degraded && graphStatus === 'ready' && (
          <p className="graph-degraded" role="status">
            <Warning size={14} aria-hidden="true" />
            {'Incomplete neighbourhood — one source did not answer, and this is what the other could give.'}
          </p>
        )}

        {isMap && (graphStatus === 'ready' || graphStatus === 'loading') && renderMap()}
        {isList && graphStatus === 'ready' && renderList()}

        {mode === 'similar' && visibleStatus === 'loading' && (
          <LoadingState label={'Finding connections...'} />
        )}
        {visibleStatus === 'unavailable' && (
          <div className="related-state">
            {'The bibliographic graph needs a valid DOI.'}
          </div>
        )}
        {visibleStatus === 'empty' && (
          <EmptyState
            as="p"
            className="graph-empty"
            art={<Petri pose="star" className="graph-empty-petri" />}
            title={mode === 'graph' ? 'No connections found' : 'No similar papers'}
            actions={mode === 'graph' && isWalking ? (
              <button type="button" className="graph-back-button" onClick={() => goBackTo(trail.length - 2)}>
                <ArrowLeft size={15} aria-hidden="true" />
                {'Back to'} {shortTitle(previousCentre?.title, 24)}
              </button>
            ) : null}
          >
            {mode === 'graph'
              ? graphEmptyLabel
              : ('No recommendations are available for this paper.')}
          </EmptyState>
        )}
        {visibleStatus === 'error' && (
          <EmptyState
            as="p"
            role="status"
            className="graph-empty"
            art={<Petri pose="upset" className="graph-empty-petri" />}
            title={'Connections did not load'}
            actions={mode === 'graph' ? (
              <Button size="sm" onClick={retryGraph}>
                <ArrowsClockwise size={16} aria-hidden="true" />
                {'Try again'}
              </Button>
            ) : null}
          >
            {'The rest of PaperTok keeps working.'}
          </EmptyState>
        )}
        {visibleStatus === 'signin' && (
          <div className="related-state" role="status">
            {'A paper’s connections need an account. Sign in to see its citation graph and similar papers.'}
          </div>
        )}

        {mode === 'similar' && visibleStatus === 'ready' && (
          <div className={`related-list ${hasSwitched ? 'is-switched' : ''}`} key="similar">
            {similarEntries.map(({ paper: related, key }) => (
              <button
                key={key}
                type="button"
                className={`related-item ${selectedPaperKey === key ? 'is-selected' : ''}`}
                onClick={() => requestPaper(related, key)}
                disabled={Boolean(selectedPaperKey)}
              >
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>
                    {related.authors.slice(0, 2).map(author => author.name || author).join(', ')}
                    {related.year ? ` · ${related.year}` : ''}
                    {related.citationCountKnown ? ` · ${related.citationCount} ${'citations'}` : ''}
                  </small>
                </span>
                <CaretRight size={18} />
              </button>
            ))}
          </div>
        )}

        {mode === 'graph' && renderPeek()}

      </Content>
    </Root>
  );
}
