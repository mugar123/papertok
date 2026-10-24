import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Paper, PaperAuthor } from '../../models/paper.ts';
import type { CitationGraph } from '../../services/citation-graph-service.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CaretRight,
  Crosshair,
  DownloadSimple,
  GitBranch,
  Graph,
  Stack,
  Warning,
  X,
} from '@phosphor-icons/react';
import { useReducedMotion } from 'framer-motion';
import { citationGraphExportPapers, getCitationGraph, getCitationGraphDoi } from '../../services/citation-graph-service.ts';
import { downloadCitationFile } from '../../utils/reading-library.ts';
import { isSignInRequiredError } from '../../utils/sign-in-required.ts';
import { CITATION_MAP_GEOMETRY, buildCitationMapLayout, nearestCitationLink } from '../../utils/citation-map.ts';
import { STAR_PATH } from '../../utils/star-path.ts';
import { areaAccentForPaper } from '../../utils/area-accent.ts';
import {
  buildRelatedPaperEntries,
  getRelatedPaperIdentity,
} from '../../utils/related-paper-transition.ts';
import ScientificText from '../scientific-text.ts';
import { Toggle } from '../ui/toggle.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import useClipTooltip from '../../hooks/use-clip-tooltip.ts';
import { Button } from '../ui/button.tsx';
import Petri from '../onboarding/petri.tsx';
import { useLanguage } from '../../context/language-context.tsx';
import { usePopupOpenOnMount } from '../../hooks/use-popup-open-on-mount.ts';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '../ui/drawer.tsx';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../ui/dialog.tsx';
import useIsPhone from '../../hooks/use-is-phone.ts';

const INITIAL_GRAPH: CitationGraph = {
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

function formatCount(value: unknown, locale = 'es-ES') {
  return new Intl.NumberFormat(locale).format(Math.max(0, Number(value) || 0));
}

/** The node label has room for one word: the first author's family name. */
function nodeAuthorLabel(paper: Partial<Paper>) {
  const first = paper?.authors?.[0];
  const name = String((first as PaperAuthor)?.name || first || '').trim();
  if (name) return name.split(/\s+/).pop();
  return String(paper?.title || '').split(/\s+/)[0] || '';
}

function shortTitle(title: unknown, max: number) {
  const text = String(title || '').trim();
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

/** A step of the walked path, shortened to fit: the whole title is its name,
    and resting on it shows that title, but only when the step is cut —
    shortened here or ellipsed by its width (a phone's narrower crumb). */
function PathCrumb({ title, max, current, onSelect }: { title: string | undefined; max: number; current: boolean; onSelect: () => void }) {
  const text = shortTitle(title, max);
  const { ref, ...tooltip } = useClipTooltip<HTMLButtonElement>(text !== String(title || '').trim());
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
 * settle-and-fade of `is-selecting-paper` in paper-card.css) and only then,
 * from `onOpenChangeComplete(false)`, is the parent told: `onSelectPaper`
 * when a paper is waiting, `onClose` otherwise. The primitive also owns the
 * focus trap, Escape and the restore.
 *
 * `inline` is the third form: no popup at all, the panel the rail's
 * Connections tile puts where the card's abstract was. The tile is its name
 * and its way back, so it draws no title and no X, and with no exit to wait
 * for, a chosen paper reaches the parent at once.
 */
function InlineRoot({ children }: { children: ReactNode }) {
  return children;
}

export default function RelatedPapersSheet({ paper, inline = false, onClose, onPreparePaper, onSelectPaper }: { paper: Paper; inline?: boolean; onClose: () => void; onPreparePaper?: (paper: Paper) => unknown; onSelectPaper: (paper: Paper) => void }) {
  const { locale } = useLanguage();
  const { open, setOpen } = usePopupOpenOnMount();
  const isPhone = useIsPhone();
  const Root = inline ? InlineRoot : isPhone ? Drawer : Dialog;
  const Content = inline ? 'section' : isPhone ? DrawerContent : DialogContent;
  const Title = isPhone ? DrawerTitle : DialogTitle;
  const Close = isPhone ? DrawerClose : DialogClose;
  const [view, setView] = useState('map');
  const [trail, setTrail] = useState<Partial<Paper>[]>([paper]);
  const [graphs, setGraphs] = useState<Record<string, { status: string; data?: CitationGraph }>>({});
  const [isSelectionReady, setIsSelectionReady] = useState(false);
  const [selectedPaperKey, setSelectedPaperKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // The node (or its edge) under a mouse: lifted, its edge inked, the rest
  // stepped back. Touch has no hover; a tap focuses instead.
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const hoverProps = (key: string) => ({
    onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === 'mouse') setHoveredKey(key); },
    onPointerLeave: () => setHoveredKey(current => (current === key ? null : current)),
  });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [phase, setPhase] = useState('idle');
  const [travel, setTravel] = useState<{ x: number; y: number; accent: string } | null>(null);
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
  const pendingSelectionRef = useRef<{ paper: Paper; key: string } | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const viewToggleRef = useRef<HTMLButtonElement | null>(null);
  const walkTimersRef = useRef<number[]>([]);
  const walkingRef = useRef(false);
  const resizeRef = useRef<{ disconnect: () => void } | null>(null);
  const onCloseRef = useRef(onClose);
  const onPreparePaperRef = useRef(onPreparePaper);
  const onSelectPaperRef = useRef(onSelectPaper);
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
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element
        && event.target.closest('.graph-peek, .graph-plot, .related-item')) return;
      setFocusedKey(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [focusedKey]);

  const later = useCallback((ms: number, action: () => void) => {
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

  const requestPaper = useCallback((relatedPaper: Partial<Paper>, paperKey: string) => {
    if (closingRef.current) return;
    onPreparePaperRef.current?.(relatedPaper as Paper);
    pendingSelectionRef.current = { paper: relatedPaper as Paper, key: paperKey };
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
  const handleOpenChangeComplete = useCallback((nextOpen: boolean) => {
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

  // The first map shows its placeholder at once; a hop waits `PLACEHOLDER`
  // milliseconds, so the travelling node is not drawn over it.
  useEffect(() => {
    if (graphStatus !== 'loading') return undefined;
    const timer = setTimeout(() => {
      if (mountedRef.current) setPlaceholderFor(centerDoi);
    }, WALK.PLACEHOLDER);
    return () => clearTimeout(timer);
  }, [graphStatus, centerDoi]);
  const showPlaceholder = graphStatus === 'loading' && (trail.length === 1 || placeholderFor === centerDoi);
  const measurePlot = useCallback((node: HTMLDivElement | null) => {
    resizeRef.current?.disconnect();
    resizeRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect || !mountedRef.current) return;
      node.setAttribute('data-resizing', '');
      clearTimeout(settle);
      settle = setTimeout(() => node.removeAttribute('data-resizing'), 200);
      setBox({ width: Math.round(rect.width), height: Math.round(rect.height) });
    });
    observer.observe(node);
    resizeRef.current = { disconnect: () => { clearTimeout(settle); observer.disconnect(); } };
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
  const offMapCount = listEntries.references.length + listEntries.citations.length - layout.nodes.length;
  const focusedListPaper = useMemo(() => {
    if (focusedNode) return focusedNode.paper;
    const all = [...listEntries.references, ...listEntries.citations];
    return all.find(entry => `list:${entry.key}` === focusedKey)?.paper || null;
  }, [focusedNode, listEntries, focusedKey]);

  const appendToTrail = useCallback((next: Partial<Paper>) => {
    setIsMapReturning(false);
    setTrail(previous => {
      const identity = getRelatedPaperIdentity(next);
      const seen = previous.findIndex(item => getRelatedPaperIdentity(item) === identity);
      // A citation graph has cycles; a trail of breadcrumbs must not.
      return seen >= 0 ? previous.slice(0, seen + 1) : [...previous, next];
    });
  }, []);

  const requestCentre = useCallback((targetPaper: Partial<Paper>, origin: { x: number; y: number } | null, currentCenter: { x: number; y: number }) => {
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

  const goBackTo = useCallback((index: number) => {
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

  const visibleStatus = graphStatus;
  const isSelectingPaper = Boolean(selectedPaperKey) && isSelectionReady;
  // Which side of the dot the label sits on. Decided from the settled column,
  // so it commits once and the slide below carries the crossing.
  const chipOnLeft = layout.chipSide === 'left';
  const isMap = view === 'map';
  const isList = view === 'list';
  // Only the short states shrink the sheet: a map that is still loading keeps
  // its frame, because the frame is what the loading state is made of.
  const sheetStatus = visibleStatus === 'loading' ? 'ready' : visibleStatus;

  const renderNode = (node: ReturnType<typeof buildCitationMapLayout>['nodes'][number]) => {
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

    const style: CSSProperties = {
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
    const canCentre = Boolean(getCitationGraphDoi(peekPaper));
    const openKey = focusedNode ? focusedNode.key : focusedKey;

    const byline = [
      peekPaper.authors!.length > 0
        ? `${nodeAuthorLabel(peekPaper)}${peekPaper.authors!.length > 1 ? ' et al.' : ''}`
        : null,
      peekPaper.year,
      peekPaper.citationCountKnown
        ? `${formatCount(peekPaper.citationCount, locale)} ${'citations'}`
        : ('citations unknown'),
    ].filter(Boolean).join(' · ');

    // One slim strip over the foot of the plot, so the graph stays in view:
    // the title, who and when, and the two things to do with this paper.
    return (
      <div className={`graph-peek ${isLeaving ? 'is-leaving' : ''}`}>
        <div className="graph-peek-copy">
          <strong className="graph-peek-title"><ScientificText>{peekPaper.title}</ScientificText></strong>
          <small className="graph-peek-byline">{byline}</small>
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => requestCentre(peekPaper, focusedNode, { x: layout.centerX, y: layout.centerY })}
          disabled={!canCentre || Boolean(selectedPaperKey) || phase !== 'idle'}
          aria-label={canCentre ? 'Centre the graph here' : 'Centre the graph here (this work has no DOI to follow)'}
          title={canCentre ? 'Centre here' : ('This work has no DOI to follow')}
        >
          <Crosshair size={16} aria-hidden="true" />
        </Button>
        <Button
          size="icon-sm"
          onClick={() => requestPaper(peekPaper, openKey || getRelatedPaperIdentity(peekPaper))}
          disabled={Boolean(selectedPaperKey)}
          aria-label={'Open paper'}
          title={'Open'}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <button
          type="button"
          className="graph-peek-close"
          onClick={() => setFocusedKey(null)}
          aria-label={'Close details'}
        >
          <X size={15} />
        </button>
      </div>
    );
  };

  // A press on the map picks the link nearest it; the stars' own buttons are
  // the way in for the keyboard and assistive tech.
  const linkAt = (event: ReactMouseEvent<HTMLDivElement>, reach: number) => {
    const plot = event.currentTarget.getBoundingClientRect();
    return nearestCitationLink(
      layout.nodes,
      { x: layout.centerX, y: layout.centerY },
      { x: event.clientX - plot.left, y: event.clientY - plot.top },
      reach,
    );
  };
  const pickLink = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (graphStatus !== 'ready' || selectedPaperKey || isLeaving) return;
    if (event.target instanceof Element && event.target.closest('.graph-node')) return;
    const key = linkAt(event, 20);
    setFocusedKey(key && key !== focusedKey ? key : null);
  };
  const hoverLink = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || graphStatus !== 'ready') return;
    if (event.target instanceof Element && event.target.closest('.graph-node')) return;
    setHoveredKey(linkAt(event, 8));
  };
  const linkHovered = Boolean(hoveredKey) && graphStatus === 'ready';

  // The link goes with the map, so focus lands on the switch it pressed.
  const showList = () => {
    setHasSwitched(true);
    setView('list');
    viewToggleRef.current?.focus();
  };

  const renderMap = () => (
    <div className={`graph-map ${isMapReturning ? 'is-returning' : ''}`}>
      <div
        className="graph-plot"
        ref={measurePlot}
        data-lit={hoveredKey || focusedKey ? '' : undefined}
        data-link-hovered={linkHovered ? '' : undefined}
        // The drawer's swipe takes the pointer on any press that is not a
        // button, and the click would never reach the map. It still swipes
        // from the grabber and the header.
        onPointerDown={event => event.stopPropagation()}
        onClick={pickLink}
        onPointerMove={hoverLink}
        onPointerLeave={() => setHoveredKey(null)}
      >
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
                  <path
                    key={`edge-${node.key}`}
                    className={`graph-edge ${focusedKey === node.key ? 'is-focused' : ''} ${hoveredKey === node.key ? 'is-hovered' : ''} ${lit && lit !== node.key ? 'is-dimmed' : ''} ${isLeaving ? 'is-gone' : ''}`}
                    d={curve}
                    style={{ '--edge-delay': `${node.edgeDelay}ms`, '--edge-accent': areaAccentForPaper(node.paper) }}
                  />
                );
              })}
            </svg>

            <span className="graph-scale-name">{'Citations'}</span>
            {layout.ticks.map(tick => (
              <span key={`scale-${tick.value}`} className="graph-scale-tick" style={{ top: `${tick.y}px` }}>{tick.label}</span>
            ))}
            {/* The column each of these stands in is handed over as
                `--mark-x` / `--chip-x`, which paper-card.css puts on the
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
              {[isWalking ? 'Centre' : 'This paper', center.year].filter(Boolean).join(' · ')}
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
                    {related.authors.slice(0, 2).map(author => (author as PaperAuthor).name || author).join(', ')}
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
        {(!inline || sheetStatus === 'ready') && (
        <header className="related-header">
          {inline ? (
            <div>
              <GitBranch size={18} />
              <h3>{'Citation graph'}</h3>
            </div>
          ) : (
            <div>
              <Graph size={18} />
              <Title render={<h3 />}>{'Paper connections'}</Title>
            </div>
          )}
          <div className="related-header-actions">
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
              ref={viewToggleRef}
            >
              <Stack size={17} />
            </Toggle>
            {graphStatus === 'ready' && (
              <button
                type="button"
                className="graph-view-button"
                onClick={() => downloadCitationFile(citationGraphExportPapers(graph), 'bibtex', 'papertok-citations')}
                aria-label={'Download these papers as BibTeX'}
                title={'Download BibTeX'}
              >
                <DownloadSimple size={17} />
              </button>
            )}
            {!inline && <span className="related-header-divider" aria-hidden="true" />}
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
        )}

        {/* The trail shows once there is a path to go back along; before
            that it would only repeat the paper the panel was opened from. */}
        {isWalking && (
          <div className="graph-trail" role="group" aria-label={'Path through the graph'}>
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

        {graph.degraded && graphStatus === 'ready' && (
          <p className="graph-degraded" role="status">
            <Warning size={14} aria-hidden="true" />
            {'Incomplete neighbourhood — one source did not answer, and this is what the other could give.'}
          </p>
        )}

        {isMap && graphStatus === 'ready' && layout.ready && offMapCount > 0 && (
          <button type="button" className="graph-off-map" onClick={showList}>
            {offMapCount === 1 ? '1 more paper in the list' : `${offMapCount} more papers in the list`}
            <ArrowRight size={13} aria-hidden="true" />
          </button>
        )}
        {isMap && (graphStatus === 'ready' || graphStatus === 'loading') && renderMap()}
        {isList && graphStatus === 'ready' && renderList()}

        {visibleStatus === 'unavailable' && (
          <EmptyState
            as="p"
            className="graph-empty"
            art={<Petri pose="blankPage" className="graph-empty-petri" />}
            title={'No citation graph'}
          >
            {'The graph needs a DOI, and this paper does not have one.'}
          </EmptyState>
        )}
        {visibleStatus === 'empty' && (
          <EmptyState
            as="p"
            className="graph-empty"
            art={<Petri pose="star" className="graph-empty-petri" />}
            title={'No connections found'}
            actions={isWalking ? (
              <button type="button" className="graph-back-button" onClick={() => goBackTo(trail.length - 2)}>
                <ArrowLeft size={15} aria-hidden="true" />
                {'Back to'} {shortTitle(previousCentre?.title, 24)}
              </button>
            ) : null}
          >
            {graphEmptyLabel}
          </EmptyState>
        )}
        {visibleStatus === 'error' && (
          <EmptyState
            as="p"
            role="status"
            className="graph-empty"
            art={<Petri pose="upset" className="graph-empty-petri" />}
            title={'Connections did not load'}
          >
            {'The rest of PaperTok keeps working.'}
          </EmptyState>
        )}
        {visibleStatus === 'signin' && (
          <div className="related-state" role="status">
            {'A paper’s connections need an account. Sign in to see its citation graph.'}
          </div>
        )}

        {renderPeek()}

      </Content>
    </Root>
  );
}
