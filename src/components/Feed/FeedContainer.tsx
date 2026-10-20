import type { OwnList } from '../../utils/ownLists.ts';
import type { AnimationEvent, PropsWithChildren, ReactNode, UIEvent } from 'react';
import type { MotionProps, Variants } from 'framer-motion';
import type { Paper } from '../../models/Paper.ts';
import type { PaperCardProps } from './PaperCard.tsx';

interface FeedSource {
  papers: Paper[];
  loading: boolean;
  error?: unknown;
  hasMore?: boolean;
  loadMore?: () => void;
  // A source without one (the Similar layer's fixed list) gets no refresh pill.
  refresh?: () => void;
  isRefreshing?: boolean;
  onPaperViewed?: (paper: Paper) => void;
  surface?: string;
  endCard?: ReactNode;
  emptyState?: ReactNode;
  initialLoadPending?: boolean;
}
interface FeedContainerProps extends Pick<PaperCardProps, 'onOpenPdf' | 'onSaveToList'> {
  source?: FeedSource | null;
  scrollKey?: string;
  landmark?: { label: string; heading: string } | null;
}
import { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState, startTransition } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowsClockwise, Check } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { useFeed } from '../../context/FeedContext.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { IS_DEMO } from '../../services/firebase.ts';
import { savedPaperDocRef } from '../../services/savedPaperStore.ts';
import { readListsHoldingPaper, writeListMembership } from '../../services/paperListMembership.ts';
import { buildSavedPaperPayload } from '../../utils/savedPaperPayload.ts';
import { setDoc } from 'firebase/firestore';
import { toast } from 'sonner';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';

import PaperCard from './PaperCard.tsx';
import SkeletonCard from './SkeletonCard.tsx';
import {
  MOUNT_WINDOW_IDLE_TIMEOUT_MS,
  MOUNT_WINDOW_RADIUS,
  MOUNT_WINDOW_RESUME_RADIUS,
  MOUNT_WINDOW_SETTLE_MS,
  growMountWindow,
  inMountWindow,
  initialMountWindow,
  mountWindowCovers,
  resumeIndex,
  windowReachingReader,
} from '../../utils/feedMountWindow.ts';
import Petri from '../Onboarding/Petri.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { FEED_DISPLAY_STATES, feedAtomVeilCopy, getFeedDisplayState } from '../../utils/feedLoadingState.ts';
import { createFeedResumeMemory } from '../../utils/feedResumeMemory.ts';
import { SKIP_EXIT_MS, skipExitSlot } from '../../utils/feedSkipExit.ts';
import { pullStartFrom, pullTakesOver, pullProgress, pullTravelPx, pullOutcome } from '../../utils/feedPullToRefresh.ts';
import './FeedContainer.css';
import { EASE_OUT, EASE_OUT_EXPO } from '../../utils/motionCurves.ts';

// Per-surface memory of the card each feed was left on: the Siguiendo feed
// shares this container with For You and must not clobber its place. The
// paper's id is what the restore actually follows (utils/feedMountWindow.js):
// the index is only as good as the order it was taken from, and Following's
// order can move between two visits. The memory writes through to
// sessionStorage once the scroll settles, so it outlives the reload the tab
// gives itself after a deploy (utils/feedResumeMemory.js).
const resumeMemory = createFeedResumeMemory();

/**
 * The card a feed opens on, and the memory row that answer came out of.
 *
 * Three places need the same answer and must not disagree: the mount
 * window's first guess, the window re-anchored when the papers arrive late,
 * and `activeIndex` before any scroll event has reported one. A window
 * anchored on card N while `activeIndex` is still 0 mounts exactly one card
 * (`MOUNT_WINDOW_RESUME_RADIUS` is 0) carrying `data-active="false"`, which
 * paints complete for a frame and then blanks and refades the whole card
 * body the moment the scroll event lands (PaperCard.css).
 *
 * The restore effect below keeps its own inline read of the same two lines
 * rather than calling this: feedResume.test.ts pins that exact text as the
 * contract for reporting the visible paper before the profile re-rank.
 */
function resumeAnchor(papers: Paper[], scrollKey: string) {
  const saved = resumeMemory.get(scrollKey);
  return { saved, index: resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index }) };
}
/** Depth of the band under the navbar in which the mouse asks for the pill. */
const REFRESH_HOVER_BAND_PX = 120;
// How long the feed takes to dip out of sight when a refresh starts. The same
// 180ms is written in FeedContainer.css (`.feed-container--refreshing`), and
// feedRefresh.test.ts holds the two together: everything this number is used
// for here is about waiting until the cover is actually down.
const REFRESH_DIP_MS = 180;
// How long the pull's landing pose is held (`landPull`). It only has to cover
// the frame or two React takes to give the pill `is-visible` through
// `isRefreshing`, plus the transition that takes it there; after that the
// pose is the same with the attribute and without it.
const PULL_LANDING_MS = 420;
// Lo que tarda la píldora en meterse bajo la barra (`.feed-refresh`, 280ms de
// recorrido). La cara se queda en «Actualizado» todo ese rato y sólo vuelve a
// «Actualizar» cuando ya no se la ve.
const PILL_EXIT_MS = 300;
// El relevo de caras de la píldora, y una sola regla: las dos caras NO se
// leen a la vez.
//
// Se cruzaban. `AnimatePresence` en modo `sync` con las caras apiladas en la
// misma celda de rejilla, así que en mitad del cambio lo que había sobre esos
// catorce píxeles eran dos textos distintos y dos iconos distintos
// superpuestos: la misma doble exposición que la transición de página ya
// aprendió a no hacer. Ahora la que se va sube y se apaga, y la que llega
// arranca cuando aquella ya es ilegible. El retardo es algo MENOR que la
// salida a propósito: solapan los últimos 40ms, con la saliente por debajo
// del 15%, para que tampoco haya un fotograma de píldora vacía.
//
// Y el reparto de papeles: la CARA viaja, la PÍLDORA escala (`is-done`, en la
// hoja). La cara llevaba además un `scale` de 0.84 a 1 con muelle mientras el
// botón entero hacía su pop de 1.12 — dos escalas anidadas multiplicándose
// sobre texto de 0.8rem, y tres relojes distintos justo en el instante que el
// lector está mirando. Una caja, una escala.
const FACE_OUT_S = 0.14;
const FACE_IN_DELAY_S = 0.08;
const EASE_OUT_QUAD: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];
function refreshFaceMotion(phase: string, reduced: boolean | null): Pick<MotionProps, 'initial' | 'animate' | 'exit'> {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.12, delay: FACE_IN_DELAY_S, ease: 'linear' } },
      exit: { opacity: 0, transition: { duration: FACE_OUT_S, ease: 'linear' } },
    };
  }
  // `transform` entero y no el atajo `y`: esto corre en el mismo instante en
  // que el feed se remonta —fotogramas de 90-173ms, medidos— y una cadena de
  // transform es lo que el compositor puede llevarse fuera del hilo. Un atajo
  // se recompone en JS en cada fotograma, que es justo lo que ahí no hay.
  const exit = {
    opacity: 0,
    transform: 'translateY(-6px)',
    transition: { duration: FACE_OUT_S, ease: EASE_OUT_QUAD },
  };
  // «Actualizado» es la única que llega con muelle: es la respuesta a lo que
  // el lector pidió y se le deja aterrizar. El resorte lleva el recorrido y
  // nada más — la opacidad va en su propio reloj, más corto, para que la cara
  // sea legible antes de terminar de asentarse y el rebote no se lea como un
  // parpadeo.
  if (phase === 'done') {
    return {
      initial: { opacity: 0, transform: 'translateY(8px)' },
      animate: {
        opacity: 1,
        transform: 'translateY(0px)',
        transition: {
          transform: { type: 'spring', duration: 0.32, bounce: 0.2, delay: FACE_IN_DELAY_S },
          opacity: { duration: 0.16, delay: FACE_IN_DELAY_S, ease: EASE_OUT_QUAD },
        },
      },
      exit,
    };
  }
  return {
    initial: { opacity: 0, transform: 'translateY(6px)' },
    animate: {
      opacity: 1,
      transform: 'translateY(0px)',
      transition: { duration: 0.2, delay: FACE_IN_DELAY_S, ease: EASE_OUT_QUAD },
    },
    exit,
  };
}
const SCROLL_IDLE_DELAY_MS = 120;
const SCROLL_INTERACTION_SETTLE_MS = 220;

// The `<main>` landmark is opt-in (via the `landmark` prop) rather than baked
// into every return: the Similar layer renders a feed too, and it is an
// overlay over a page, not a page of its own. Sólo lo pasa quien ES la raíz de una ruta: App.jsx
// para `/feed` y FollowingFeedPage para `/following`. Todas las ramas —feed,
// esqueleto, error, vacío y el vacío que trae la fuente— lo comparten, porque
// una pantalla sin papers sigue siendo la página y necesita su landmark y su
// encabezado igual que la que los tiene.
/**
 * How the atom gives way to the paper.
 *
 * The atom screen and the feed were two return branches of this component,
 * so React swapped one for the other in a single frame: the atom, then a
 * paper composing in, with nothing between. The screen is now a veil laid
 * over the same container the cards mount into, and it leaves as the first
 * card composes: the ground fades over 0.42 s while the atom shrinks and
 * rises out of the way and the copy settles, on the curve everything on the
 * card arrives with. Labels rather than objects on the children: inside a
 * variant tree a child animates on the parent's label, not on an object of
 * its own, so the atom's `gone` plays the frame the veil's does.
 */
const ATOM_VEIL_VARIANTS: Variants = {
  shown: { opacity: 1 },
  gone: { opacity: 0, transition: { duration: 0.42, ease: EASE_OUT_EXPO } },
};
const ATOM_VARIANTS = {
  shown: { opacity: 1, transform: 'translateY(0px) scale(1)' },
  gone: { opacity: 0, transform: 'translateY(-16px) scale(0.62)', transition: { duration: 0.36, ease: EASE_OUT_EXPO } },
};
const ATOM_COPY_VARIANTS = {
  shown: { opacity: 1, transform: 'translateY(0px)' },
  gone: { opacity: 0, transform: 'translateY(6px)', transition: { duration: 0.24, ease: EASE_OUT } },
};
const ATOM_VEIL_REDUCED_VARIANTS = {
  shown: { opacity: 1 },
  gone: { opacity: 0, transition: { duration: 0.12 } },
};

// `className` porque los estados vacíos NO son `.feed-wrapper`: son
// `.feed-empty`, con su propio `margin-top: var(--nav-total)`. Envolver uno
// dentro del otro sumaría el hueco de la barra dos veces, así que el landmark
// ES el contenedor en cada rama en vez de un nivel más.
function FeedLandmark({ landmark, className = 'feed-wrapper', children }: PropsWithChildren<{ landmark: FeedContainerProps['landmark']; className?: string }>) {
  if (!landmark) {
    return <div className={className}>{children}</div>;
  }
  return (
    <main className={className} aria-label={landmark.label}>
      <h1 className="visually-hidden">{landmark.heading}</h1>
      {children}
    </main>
  );
}

/**
 * `source` swaps WHERE the papers come from while every interaction (like,
 * save, read, view tracking) keeps flowing into the recommendation profile
 * through useFeed. Shape: { papers, loading, error, hasMore, loadMore,
 * refresh, isRefreshing, emptyState, endCard, onPaperViewed }.
 *
 * `endCard` is a node the source appends as one more snap item once the feed
 * has genuinely run out — same height, same snapping, same swipe.
 */
export default function FeedContainer({ onOpenPdf, onSaveToList, source = null, scrollKey = 'forYou', landmark = null }: FeedContainerProps) {
  const feed = useFeed();
  const { trackEvent, markActivation } = useAnalyticsConsent();
  const analyticsSurface = source?.surface || (scrollKey === 'following' ? 'following' : 'feed');
  const {
    trackPdfOpened,
    likedPaperIds, savedPaperIds, readPaperIds, interactionIdFor, toggleLike, markNotInterested, markAsRead, unmarkAsRead,
    personalLibrary, toggleReadLater, markSaved, unmarkSaved,
    trackViewTime, trackSkip, trackSkips: trackSkippedPapers,
  } = feed;
  const papers = source ? source.papers : feed.papers;
  const loading = source ? source.loading : feed.loading;
  const error = source ? source.error : feed.error;
  const hasMore = source ? Boolean(source.hasMore) : feed.hasMore;
  const loadMore = useMemo(
    () => (source ? (source.loadMore || (() => {})) : feed.loadMore),
    [source, feed.loadMore],
  );
  const refreshFeed = useMemo(
    () => (source ? (source.refresh || (() => {})) : feed.refreshFeed),
    [source, feed.refreshFeed],
  );
  const isRefreshing = source ? Boolean(source.isRefreshing) : feed.isRefreshing;
  // Only the For You feed owns the context's list; Following and the Similar
  // layer render a `source` of their own and must not anchor For You's
  // re-rank on a card it does not have.
  const reportVisiblePaper = source ? null : feed.reportVisiblePaper;
  const loadingAbstractIds = source ? undefined : feed.loadingAbstractIds;
  // Only once nothing more is coming: a page still loading or still pending
  // would put the ending in front of papers the reader has not seen yet.
  const endCard = source?.endCard ?? null;
  const showEndCard = Boolean(endCard) && papers.length > 0 && !loading && !hasMore;
  const prefersReducedMotion = useReducedMotion();

  const handleViewTime = useCallback((paper: Paper, seconds: number) => {
    source?.onPaperViewed?.(paper);
    trackViewTime(paper, seconds);
  }, [source, trackViewTime]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  // El scroller, además de en el ref: el oyente del hover (más abajo) tiene
  // que atarse al envoltorio VIVO, y un ref no despierta a nadie cuando
  // cambia. `feedRef` se sigue poniendo aquí porque de él leen el scroll, el
  // resume, el tirón y el salto del refresco, que corren con el nodo ya
  // montado y no necesitan enterarse de nada.
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((node: HTMLDivElement | null) => {
    feedRef.current = node;
    setFeedNode(node);
  }, []);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // The card currently snapped into view, derived in handleScroll from the
  // same scrollTop/clientHeight math the keyboard-nav effect below already
  // uses. It tracks the scroll position on every scroll, and the mount
  // window grows toward it (`windowReachingReader`). But the mount window can
  // trail it and briefly leave zero cards active, not the wrong one: right
  // after a resume the window is exactly the one card resumed onto
  // (`MOUNT_WINDOW_RESUME_RADIUS` is 0), and right after any mount the
  // first idle growth waits out `MOUNT_WINDOW_SETTLE_MS` (feedMountWindow.js).
  // A swipe that outruns the window in that stretch — one ordinary swipe
  // suffices on resume — sets activeIndex to a card still rendered as a
  // `.feed-snap-item--pending` placeholder. It self-heals there: nothing
  // resets activeIndex in between, so the window still reaches the target
  // card once it grows.
  // Seeded from the same anchor the mount window uses, never from a bare 0:
  // a resumed feed mounts card N and nothing else, and a 0 here would hand
  // that card `data-active="false"` for the first painted frame — complete,
  // then blanked and refaded over 280ms plus 175ms of stagger the instant
  // the scroll event corrected it. The restore effect below re-seeds it for
  // the other resume shape, a reload whose papers had not arrived yet.
  const [activeIndex, setActiveIndex] = useState(() => resumeAnchor(papers, scrollKey).index);
  // One gesture's worth of state. `phase` is 'idle' until a touch lands
  // somewhere a pull may begin, 'pending' until its first move says which
  // way it is going, and 'owning' once it is ours — from there the feed is
  // stopped from scrolling under it.
  const pullRef = useRef({ phase: 'idle', startY: 0, startX: 0, startedAt: 0 });
  // The touch listeners are attached once per scroller, not per render, so
  // what they need from the render lives here instead of in their closure.
  const pullDepsRef = useRef({ refresh: refreshFeed, loading, isRefreshing });
  const pullLandingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshPillRef = useRef<HTMLButtonElement | null>(null);
  // Whether the scroll back to the top is still owed (see the effect below).
  const refreshJumpOwedRef = useRef(false);
  // Desktop: the pill lives hidden under the navbar and shows while the mouse
  // is in the band beneath it. Touch: it shows as the pull progresses.
  const [refreshPillHover, setRefreshPillHover] = useState(false);
  // True until the pointer leaves the hover band once. Stops the pill from
  // flashing when the feed returns under a cursor that never left the band.
  const refreshHoverLockedRef = useRef(true);
  const [refreshDone, setRefreshDone] = useState(false);
  // La píldora se va SIEMPRE diciendo «Actualizado».
  //
  // Al terminar el beat, la cara volvía al verbo. Ese cruce no informa de
  // nada — no ha pasado nada entre uno y otro — y no tenía dónde ocurrir sin
  // que se viera: con el dedo la píldora se esconde en cuanto el beat acaba,
  // así que el texto cambiaba mientras se marchaba; con el ratón quieto en la
  // franja cambiaba delante del lector, que veía deshacerse la respuesta a lo
  // que acababa de pedir. Ahora la cara se queda puesta hasta que la píldora
  // está fuera de vista y vuelve al verbo debajo de la barra: la próxima vez
  // que asome ya viene ofreciéndose.
  const [doneHold, setDoneHold] = useState(false);
  // Si el botón tiene el foco de teclado, el CSS lo saca (`:focus-visible`)
  // sin pasar por el estado — así que la cola tiene que contar con él o la
  // cara volvería al verbo delante de quien refrescó con el teclado.
  // `:focus-visible` y no `:focus` a secas: un clic con el ratón también deja
  // el botón enfocado, y eso dejaría «Actualizado» clavado para siempre.
  const [refreshPillFocused, setRefreshPillFocused] = useState(false);
  const wasRefreshingRef = useRef(false);
  const [showLoader, setShowLoader] = useState(false);
  const [initialFeedReady, setInitialFeedReady] = useState(false);
  // The cards mounted right now: a window around the card this feed was left
  // on, grown outwards in idle chunks until it covers every paper. Mounting
  // the whole feed in the same commit as the tab switch was what blocked the
  // main thread for ~200 ms at a time and froze the transition.
  // Read by the scroll handler, which must not be re-created on every
  // papers change; refreshed after each commit, which is before any scroll.
  const papersRef = useRef(papers);
  useEffect(() => { papersRef.current = papers; }, [papers]);
  const [mountWindow, setMountWindow] = useState(
    () => {
      const { saved, index } = resumeAnchor(papers, scrollKey);
      return initialMountWindow({
        total: papers.length,
        anchorIndex: index,
        radius: saved.paperId ? MOUNT_WINDOW_RESUME_RADIUS : MOUNT_WINDOW_RADIUS,
      });
    },
  );
  // When this container mounted: the first growth of the window waits out the
  // page transition from here (feedMountWindow.js says why). Stamped in an
  // effect, not during render — the clock is not a pure read — so `null`
  // means "this commit".
  const mountedAtRef = useRef<number | null>(null);
  useEffect(() => {
    mountedAtRef.current = performance.now();
  }, []);
  // Papers that arrive after the first render (a first load, a source that
  // answers late) find an empty window: derive one anchored on the resumed
  // card, or it would grow from the top and leave that card a blank slot
  // until it got there. Derived, not set in an effect, so the first paint
  // with papers already has the right cards in it.
  const anchoredWindow = useMemo(() => {
    if (mountWindow.hi !== 0) return windowReachingReader(mountWindow, activeIndex, papers.length);
    if (papers.length === 0) return mountWindow;
    const { saved, index } = resumeAnchor(papers, scrollKey);
    return initialMountWindow({
      total: papers.length,
      anchorIndex: index,
      radius: saved.paperId ? MOUNT_WINDOW_RESUME_RADIUS : MOUNT_WINDOW_RADIUS,
    });
  }, [mountWindow, papers, scrollKey, activeIndex]);
  useEffect(() => {
    if (mountWindowCovers(anchoredWindow, papers.length)) return undefined;
    // `requestIdleCallback` where it exists, so a chunk never lands inside a
    // frame the transition or a scroll needs; a short timeout elsewhere. The
    // idle wait itself starts once the page transition has had its time: a
    // chunk scheduled straight after mount ran inside the entrance (idle, as
    // the browser saw it) and froze it for the length of the task.
    const schedule = typeof window.requestIdleCallback === 'function'
      ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: MOUNT_WINDOW_IDLE_TIMEOUT_MS })
      : (fn: () => void) => setTimeout(fn, 32);
    const cancel = typeof window.cancelIdleCallback === 'function'
      ? (id: number) => window.cancelIdleCallback(id)
      : (id: number) => clearTimeout(id);
    const sinceMount = mountedAtRef.current === null ? 0 : performance.now() - mountedAtRef.current;
    let handle: number | null = null;
    let retry: number | null = null;
    // Not while the feed is moving. The main thread is idle for exactly as
    // long as the compositor is running the snap to the next card, so an
    // idle chunk armed by a page arriving mid-swipe mounted two cards inside
    // the animation (measured 2026-09-22: 125-150 ms commits at 4x CPU, on
    // the frames the snap was landing). `feed-container--scrolling` is the
    // scroll handler's own signal; it clears SCROLL_IDLE_DELAY_MS after the
    // last scroll event, which is when the chunk is asked for again.
    const grow = () => {
      handle = null;
      if (feedRef.current?.classList.contains('feed-container--scrolling')) {
        retry = setTimeout(() => { handle = schedule(grow); }, SCROLL_IDLE_DELAY_MS);
        return;
      }
      setMountWindow(growMountWindow(anchoredWindow, papers.length));
    };
    const timer = setTimeout(() => {
      handle = schedule(grow);
    }, Math.max(0, MOUNT_WINDOW_SETTLE_MS - sinceMount));
    return () => {
      clearTimeout(timer);
      clearTimeout(retry!);
      if (handle !== null) cancel(handle);
    };
  }, [anchoredWindow, papers.length]);
  const initialLoadStartedRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const skipFlushTimerRef = useRef<number | null>(null);
  const pendingSkippedPapersRef = useRef(new Map<string, Paper>());
  // The card on its way out of the feed, and the removal waiting for it to
  // get there. Only ever one: a second skip lands the first one first.
  const [skipExit, setSkipExit] = useState<ReturnType<typeof skipExitSlot>>(null);
  const skipExitRef = useRef<(NonNullable<ReturnType<typeof skipExitSlot>> & { commit: () => void }) | null>(null);
  const skipExitTimerRef = useRef<number | null>(null);
  const getInteractionState = useCallback((paper: Paper) => ({
    isLiked: likedPaperIds.has(interactionIdFor(paper)!),
    isSaved: savedPaperIds.has(interactionIdFor(paper)!),
    isRead: readPaperIds?.has(interactionIdFor(paper)!),
  }), [interactionIdFor, likedPaperIds, readPaperIds, savedPaperIds]);

  const flushPendingSkips = useCallback(() => {
    const skippedPapers = Array.from(pendingSkippedPapersRef.current.values());
    pendingSkippedPapersRef.current.clear();
    if (skippedPapers.length === 0) return;

    if (trackSkippedPapers) {
      void trackSkippedPapers(skippedPapers);
      return;
    }
    skippedPapers.forEach((paper) => void trackSkip(paper));
  }, [trackSkip, trackSkippedPapers]);

  const schedulePendingSkipFlush = useCallback(() => {
    if (skipFlushTimerRef.current) clearTimeout(skipFlushTimerRef.current);
    skipFlushTimerRef.current = setTimeout(flushPendingSkips, SCROLL_INTERACTION_SETTLE_MS);
  }, [flushPendingSkips]);

  // Lands the pending removal, whether the exit finished, was cut short by
  // another skip, or never ran at all. Idempotent: the animation and the
  // clock both call it, and whichever arrives second finds nothing to do.
  const flushSkipExit = useCallback(() => {
    const pending = skipExitRef.current;
    if (!pending) return;
    skipExitRef.current = null;
    if (skipExitTimerRef.current) clearTimeout(skipExitTimerRef.current);
    skipExitTimerRef.current = null;
    setSkipExit(null);
    pending.commit();
  }, []);

  // Runs the card out of the feed, then removes it. `commit` is the removal
  // itself — it differs by surface, and by whether there is a session — so
  // this only owns the going.
  const beginSkipExit = useCallback((paperId: string, commit: () => void) => {
    flushSkipExit();
    const slot = skipExitSlot({
      papers: papersRef.current,
      paperId,
      cardHeight: feedRef.current?.clientHeight ?? 0,
    });
    // Nothing to animate — a card the list does not have, or a container that
    // has not been measured. The skip still happens, at once, as it always did.
    if (!slot) {
      commit();
      return;
    }
    skipExitRef.current = { ...slot, commit };
    setSkipExit(slot);
    // The clock is the backstop, not the mechanism: `animationend` normally
    // gets there first. Without it, an exit that never runs — a rule that
    // turns the animation off, a browser that skips it — would strand the
    // card in the feed with the skip never recorded.
    skipExitTimerRef.current = setTimeout(flushSkipExit, SKIP_EXIT_MS + 120);
  }, [flushSkipExit]);

  const handleSkipExitEnd = useCallback((event: AnimationEvent) => {
    // The card is full of animations of its own and they all bubble to here,
    // so the exit has to name itself. Both halves of it start with this.
    if (!String(event.animationName).startsWith('feedSkipExit')) return;
    flushSkipExit();
  }, [flushSkipExit]);

  const handleNotInterested = useCallback((paper: Paper) => {
    beginSkipExit(paper?.id, () => markNotInterested(paper));
  }, [beginSkipExit, markNotInterested]);

  const handleSkip = useCallback((paper: Paper) => {
    source?.onPaperViewed?.(paper);
    if (!paper?.id) return;
    pendingSkippedPapersRef.current.set(paper.id, paper);
    schedulePendingSkipFlush();
  }, [schedulePendingSkipFlush, source]);

  // Restore scroll position instantly before browser paints. Must run only once
  // per mount: re-assigning scrollTop on later papers.length changes (infinite
  // scroll appends) cancels any in-flight momentum and makes scrolling stutter.
  const restoreAttemptedRef = useRef(false);
  useLayoutEffect(() => {
    if (restoreAttemptedRef.current || papers.length === 0) return;
    restoreAttemptedRef.current = true;
    const saved = resumeMemory.get(scrollKey);
    // The paper the reader was on, wherever it is in this order. Reported to
    // the context here, not left to the scroll event the programmatic
    // scrollTop fires later: the profile load's re-rank must find the anchor
    // already set.
    const index = resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index });
    reportVisiblePaper?.(papers[index]?.id ?? null);
    // The other resume shape: a reload restores its place before the papers
    // have arrived, so the seed above could only answer 0. This runs in a
    // layout effect, so React flushes the re-render BEFORE the browser
    // paints and the resumed card still never shows a frame at rest.
    setActiveIndex(index);
    // A place restored from storage after a reload has an index and no pixel
    // offset; either says there is somewhere to go back to.
    if (feedRef.current && (saved.scrollTop > 0 || saved.index > 0)) {
      const el = feedRef.current;
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto'; // Force instant jump
      // Each snap item is one container height tall, so the card's index is
      // its offset; the raw offset only stands in when the height is unknown.
      el.scrollTop = el.clientHeight > 0 ? index * el.clientHeight : saved.scrollTop;

      requestAnimationFrame(() => {
        el.style.scrollBehavior = prevBehavior;
      });
    }
  }, [papers, reportVisiblePaper, scrollKey]);

  useEffect(() => {
    if (loading) initialLoadStartedRef.current = true;
    if (papers.length > 0 || error || (initialLoadStartedRef.current && !loading)) {
      setInitialFeedReady(true);
    }
  }, [error, loading, papers.length]);

  // Only show the atom loader if loading takes more than 1.5s
  useEffect(() => {
    if (papers.length === 0 && loading && !error) {
      const timer = setTimeout(() => setShowLoader(true), 1500);
      return () => clearTimeout(timer);
    }
    const hideTimer = setTimeout(() => setShowLoader(false), 0);
    return () => clearTimeout(hideTimer);
  }, [papers.length, loading, error]);

  // Back to the top on a manual refresh — behind the cover, not in front of
  // it. It used to scroll smoothly the moment the refresh started, which from
  // the seventh card is seven viewport-heights of papers streaming past while
  // the reader waits for different ones: a long second movement to read, on
  // top of the one the veil is already making. Now it is a jump, taken once
  // the veil is down, where there is nothing to see. Waiting matters — at
  // frame 0 the fade has not started and the jump would be in the clear.
  useEffect(() => {
    if (!isRefreshing) {
      // A refresh off a warm cache can land before the veil is all the way
      // down, and the jump is still owed: take it here, with what cover there
      // is, rather than let the cleanup swallow it and leave the reader on
      // the card they asked to be refreshed away from. Unmount never reaches
      // this branch, so leaving the feed never scrolls it.
      if (refreshJumpOwedRef.current) {
        refreshJumpOwedRef.current = false;
        feedRef.current?.scrollTo({ top: 0, behavior: 'auto' });
      }
      return undefined;
    }
    refreshJumpOwedRef.current = true;
    const t = setTimeout(() => {
      refreshJumpOwedRef.current = false;
      feedRef.current?.scrollTo({ top: 0, behavior: 'auto' });
    }, REFRESH_DIP_MS);
    return () => clearTimeout(t);
  }, [isRefreshing]);

  useEffect(() => {
    return () => {
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      if (skipFlushTimerRef.current) clearTimeout(skipFlushTimerRef.current);
      // Leaving the feed while a card is still on its way out: the skip is
      // the reader's, not the animation's, so it lands anyway.
      flushSkipExit();
      // Leaving mid-settle (a tab switch right after a fling) must not lose
      // the place the settle timer was about to write.
      resumeMemory.persist(scrollKey);
    };
  }, [scrollKey, flushSkipExit]);

  // Infinite scroll: observe sentinel element
  useEffect(() => {
    const root = feedRef.current;
    if (!sentinelRef.current || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading) {
          loadMore();
        }
      },
      {
        root,
        // Two viewports of runway, not five: loadPapers' per-source fetch is
        // capped at FEED_SOURCE_RENDER_BUDGET_MS (4 s worst case, see
        // FeedContext.jsx) and a typical reader spends far longer than that on
        // two cards, so this still starts the next page well before the
        // sentinel's own card is reached. If it ever isn't enough, the
        // `loading && <SkeletonCard />` snap item below is the fallback, not a
        // dead end. Five viewports only bought DOM bloat on mobile.
        rootMargin: '0px 0px 200% 0px',
        threshold: 0,
      }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadMore]);

  // Wheel and trackpad scrolling stay entirely native. CSS scroll snapping
  // keeps cards aligned without a non-passive listener blocking momentum
  // scrolling, and nothing here listens to the wheel.

  useEffect(() => {
    if (!feedNode) return undefined;
    const moved = () => { feedNode.dataset.moved = ''; };
    feedNode.addEventListener('scroll', moved, { once: true, passive: true });
    return () => feedNode.removeEventListener('scroll', moved);
  }, [feedNode]);

  // Implement keyboard arrow navigation on desktop
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const container = feedRef.current;
      if (!container) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const activeTarget = e.target instanceof Element ? e.target : null;
        // `[role="dialog"]` covers a non-modal popup over the feed, such as a
        // visitor's Privacy panel: its keys are its own, and with large text it
        // scrolls with them.
        const exempt = activeTarget?.closest(
          'input, textarea, select, button, a, summary, [contenteditable="true"], [role="textbox"], [role="button"], [role="link"], [role="dialog"]',
        );
        // The Similar layer is a modal dialog this feed lives IN: its arrows
        // are this feed's, and the feed under it is the one that keeps still.
        const isInteractive = exempt && !(exempt.matches('[role="dialog"]') && exempt.contains(container));
        // A modal Base UI has hidden behind a newer one (`aria-hidden`) — the
        // explorer's paper overlay under the Similar layer — owns no keys.
        const hasOpenModal = [...document.querySelectorAll('[aria-modal="true"]')]
          .some(modal => !modal.contains(container) && !modal.closest('[aria-hidden="true"]'));
        if (isInteractive || hasOpenModal) return;

        e.preventDefault();
        const direction = e.key === 'ArrowDown' ? 1 : -1;
        const cardHeight = container.clientHeight;
        const currentScroll = container.scrollTop;
        const currentIndex = Math.round(currentScroll / cardHeight);
        const nextIndex = currentIndex + direction;

        const itemCount = papers.length + (loading ? 1 : 0) + (showEndCard ? 1 : 0);
        if (nextIndex >= 0 && nextIndex < itemCount) {
          // Smooth, as the browser's own arrow scroll is when a focused
          // control leaves the key to it: an instant jump here made the same
          // key move the feed two different ways depending on focus.
          container.scrollTo({ top: nextIndex * cardHeight, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
        }
      }
    };

    // Base UI stops arrow keys at the edge of a dialog (its popup's
    // `COMPOSITE_KEYS`), so a feed inside one — the Similar layer — listens on
    // that dialog. The page's own feed listens on the window.
    const dialog = feedNode?.closest<HTMLElement>('[role="dialog"]');
    if (dialog) {
      dialog.addEventListener('keydown', handleKeyDown);
      return () => dialog.removeEventListener('keydown', handleKeyDown);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [papers.length, loading, showEndCard, feedNode, prefersReducedMotion]);

  const handleRefresh = useCallback(() => {
    refreshFeed();
  }, [refreshFeed]);

  // The pull's progress goes to the WRAPPER, not to the pill: the papers
  // follow the finger too, and the wrapper is the one ancestor both they and
  // the pill hang off. Written to the element, so a drag never re-renders.
  // A data attribute, not a class: `className` on `.feed-wrapper` is a JSX
  // literal that React rewrites on every commit, and the commit that starts
  // the refresh lands on the very frame the finger lets go. `setAttribute`
  // rather than `dataset.x =`, which the lint reads as mutating a ref value.
  const setPull = useCallback((progress: number, travelPx = 0) => {
    const wrapper = feedRef.current?.parentElement;
    if (!wrapper) return;
    wrapper.style.setProperty('--pull', String(progress));
    wrapper.style.setProperty('--pull-y', `${travelPx.toFixed(1)}px`);
    wrapper.setAttribute('data-pull', progress > 0 ? 'pulling' : '');
  }, []);

  // A pull that refreshes does not let go: it lands. Resetting to zero would
  // leave the pill with no state for the frame or two before React gives it
  // `is-visible`, and with no state its transition is the one that LEAVES —
  // a half-shown pill, a retreat and a jump back, all inside 100ms. The
  // landing pose is the working pose letter for letter, so when React
  // arrives there is nothing to correct; and the papers sink on the veil's
  // clock instead of springing back, so thumb to veil reads as one movement.
  const landPull = useCallback(() => {
    const wrapper = feedRef.current?.parentElement;
    if (!wrapper) return;
    wrapper.style.setProperty('--pull', '1');
    wrapper.style.setProperty('--pull-y', '0px');
    wrapper.setAttribute('data-pull', 'landing');
    clearTimeout(pullLandingTimerRef.current);
    pullLandingTimerRef.current = setTimeout(() => {
      if (wrapper.getAttribute('data-pull') === 'landing') wrapper.setAttribute('data-pull', '');
    }, PULL_LANDING_MS);
  }, []);
  useEffect(() => () => clearTimeout(pullLandingTimerRef.current), []);
  useEffect(() => {
    pullDepsRef.current = { refresh: refreshFeed, loading, isRefreshing };
  });


  // Fine pointer only: a touch also fires a synthetic mousemove where it
  // landed, and a tap on the card's top edge is not a request for the pill.
  // Listened for on the wrapper — the parent of both the scroller and the
  // pill — never on the scroller itself: the pill is the scroller's sibling,
  // so with the listener there, the cursor reaching the pill was a
  // `mouseleave` for the scroller, the pill hid, the cursor was back over
  // the scroller, the pill showed… a blink for as long as the mouse stayed.
  //
  // Hover starts locked. Coming back from a topic/author/project remounts
  // the feed under a cursor that never left the band; closing the save sheet
  // is the same. The first mousemove would flash the pill. Stay hidden until
  // the pointer leaves the band once; after that, hover works as before.
  // A pointerdown outside the wrapper (sheet, modal, navbar) re-locks.
  const handleMouseMove = useCallback((e: MouseEvent, wrapper: HTMLElement) => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    const inBand = e.clientY - wrapper.getBoundingClientRect().top < REFRESH_HOVER_BAND_PX;
    if (refreshHoverLockedRef.current) {
      if (inBand) {
        setRefreshPillHover((prev) => (prev ? false : prev));
        return;
      }
      refreshHoverLockedRef.current = false;
    }
    setRefreshPillHover((prev) => (prev === inBand ? prev : inBand));
  }, []);
  // Enganchado al NODO, no a una lectura del ref en el primer commit. Las dos
  // dependencias de antes —`handleMouseMove` y `publicMode`— eran estables, así
  // que el efecto corría una sola vez por montaje; y el scroller sólo existe en
  // la rama del feed, de modo que un montaje que empezara en el esqueleto leía
  // el ref en null, salía por la puerta de arriba y no volvía a correr cuando
  // llegaban los papers. El feed de invitado no declara `initialLoadPending`:
  // cargar sin papers lo lleva siempre al esqueleto, y en esa carga la franja
  // no ofrecía la píldora nunca. Medido el 12-09: 37 mousemove llegaban al
  // envoltorio y CDP no le veía un solo oyente.
  useEffect(() => {
    const wrapper = feedNode?.parentElement;
    if (!wrapper) return undefined;
    const onMove = (e: MouseEvent) => handleMouseMove(e, wrapper);
    const onLeave = () => {
      refreshHoverLockedRef.current = true;
      setRefreshPillHover(false);
    };
    const onPointerDownCapture = (event: PointerEvent) => {
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (wrapper.contains(t)) return;
      refreshHoverLockedRef.current = true;
      setRefreshPillHover(false);
    };
    wrapper.addEventListener('mousemove', onMove, { passive: true });
    wrapper.addEventListener('mouseleave', onLeave);
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    return () => {
      wrapper.removeEventListener('mousemove', onMove);
      wrapper.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('pointerdown', onPointerDownCapture, true);
    };
  }, [feedNode, handleMouseMove]);

  // A short "done" beat once a refresh lands, before the pill hides again.
  // Long enough for the face crossfade to enter, hold, and leave — 600ms
  // clipped the Updated → Refresh exit mid-fade. While a new refresh runs,
  // `refreshPhase` already prefers refreshing over done, so we never clear
  // `refreshDone` synchronously here (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (wasRefreshingRef.current && !isRefreshing) {
      setRefreshDone(true);
      setDoneHold(true);
      const holdMs = prefersReducedMotion ? 500 : 1000;
      const t = setTimeout(() => setRefreshDone(false), holdMs);
      wasRefreshingRef.current = false;
      return () => clearTimeout(t);
    }
    wasRefreshingRef.current = isRefreshing;
    return undefined;
  }, [isRefreshing, prefersReducedMotion]);

  // El otro extremo de la cola: «Actualizado» se suelta cuando la píldora ya
  // no se ve, más lo que tarda en llegar debajo de la barra (`PILL_EXIT_MS`).
  // No hay flanco que recordar aquí — la condición es un estado, no un
  // instante: mientras el ratón siga en la franja la píldora sigue delante y
  // la cara no tiene por qué cambiar, y si vuelve a la franja antes de que el
  // temporizador dispare, el cleanup lo cancela y sigue siendo la misma
  // visita. `pillOnScreen` lleva el foco de teclado además de las tres
  // condiciones de `is-visible`, porque `:focus-visible` también la saca.
  const pillOnScreen = refreshPillHover || refreshPillFocused || isRefreshing || refreshDone;
  useEffect(() => {
    if (!doneHold || pillOnScreen) return undefined;
    const t = setTimeout(() => setDoneHold(false), PILL_EXIT_MS);
    return () => clearTimeout(t);
  }, [doneHold, pillOnScreen]);

  const handleOpenPdf = useCallback((paper: Paper) => {
    trackPdfOpened(paper);
    onOpenPdf!(paper);
  }, [onOpenPdf, trackPdfOpened]);

  const { user } = useAuth();
  const { language } = useLanguage();
  const saveState = useRef({ personalLibrary, toggleReadLater, markSaved });
  useEffect(() => {
    saveState.current = { personalLibrary, toggleReadLater, markSaved };
  }, [markSaved, personalLibrary, toggleReadLater]);

  const restoreSave = useCallback(async (paper: Paper, lists: OwnList[], readLater: boolean) => {
    const id = interactionIdFor(paper)!;
    const latest = saveState.current;
    if (user && !IS_DEMO) {
      await setDoc(savedPaperDocRef(user.uid, paper.id), buildSavedPaperPayload(paper, new Date().toISOString()), { merge: true });
      await writeListMembership({ uid: user.uid, paper, lists, added: true, language });
    }
    if (readLater && !latest.personalLibrary[id]?.readLater) await latest.toggleReadLater(paper);
    await latest.markSaved(paper);
  }, [interactionIdFor, language, user]);

  const handleSaveToList = useCallback(async (paper: Paper) => {
    const id = interactionIdFor(paper)!;
    const readLater = Boolean(personalLibrary[id]?.readLater);
    if (savedPaperIds.has(id)) {
      let lists: OwnList[] | null = null;
      let removed = false;
      try {
        lists = user && !IS_DEMO ? await readListsHoldingPaper(user.uid, paper.id) : [];
        if (!lists) {
          onSaveToList!(paper);
          return;
        }
        const held = lists;
        if (user && !IS_DEMO) await writeListMembership({ uid: user.uid, paper, lists: held, added: false, language });
        removed = true;
        if (readLater) await toggleReadLater(paper);
        await unmarkSaved(paper);
        toast('Removed from your saved papers', {
          action: {
            label: 'Undo',
            onClick: () => { restoreSave(paper, held, readLater).catch(() => toast.error('Could not save this paper')); },
          },
        });
      } catch {
        // Half an unsave is worse than none: put back what was already taken.
        if (removed && lists) await restoreSave(paper, lists, readLater).catch(() => {});
        toast.error('Could not remove this paper');
      }
      return;
    }
    try {
      await restoreSave(paper, [], true);
      markActivation();
      toast.success('Saved to Read later', {
        action: { label: 'Add to list', onClick: () => onSaveToList!(paper) },
      });
    } catch {
      toast.error('Could not save this paper');
    }
  }, [interactionIdFor, language, markActivation, onSaveToList, personalLibrary, restoreSave, savedPaperIds, toggleReadLater, unmarkSaved, user]);

  /**
   * El `setActiveIndex` de aquí va en transición, y conviene saber exactamente
   * cuánto compra eso: en este Mac, NADA. Medido sobre el bundle de producción
   * y contra control en el mismo árbol, con y sin la transición, el scroll mide
   * igual — mediana 16,7ms, p95 16,8ms, cero fotogramas largos y CERO bloqueo
   * en ambos. Se queda como seguro para aparatos lentos, no como arreglo.
   *
   * La medida que lo motivó estaba hecha sobre el servidor de DESARROLLO, y ahí
   * cada cambio de tarjeta metía un fotograma largo de 50 a 94ms atribuido a
   * `performWorkUntilDeadline`. Eso era sobrecoste de React en modo dev, que
   * infla el coste de render varias veces: en producción no existe. **No vuelvas
   * a medir fluidez del feed en dev.** El coste de render de `PaperCard` es real
   * pero el hilo principal lo absorbe de sobra en un aparato de escritorio; en
   * un móvil de gama media podría acercarse al perfil de dev, y es para ese caso
   * para el que esto está aquí.
   *
   * What does hold, and keeps this safe: the card no longer receives
   * `activeIndex` in any form. Nothing visual depends on it (clips enter
   * through an IntersectionObserver at 15% and `pcArrive` has no condition),
   * so a value that lands a frame or two late makes nothing flicker.
   * feedScrollPriority.test.ts pins that the card takes no active flag.
   *
   * El `setActiveIndex` del efecto de resume NO va en transición: allí el valor
   * tiene que estar puesto antes de que la ventana de montaje decida, o la
   * tarjeta a la que se vuelve monta sola y refunde su cuerpo entero.
   *
   * El comentario vive aquí arriba, y no dentro, porque feedResume.test.ts
   * acota el cuerpo de este handler a 32 líneas y `stripComments` deja las
   * líneas en blanco: el handler ya estaba justo en ese tope.
   */
  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget;
    const index = container.clientHeight > 0
      ? Math.round(container.scrollTop / container.clientHeight)
      : 0;
    // Fires on every scroll event, but useState bails out of re-rendering
    // when the value is unchanged (Object.is), so every tick that doesn't
    // cross a card boundary is a no-op here.
    //
    startTransition(() => setActiveIndex(index));
    const paperId = papersRef.current[index]?.id || resumeMemory.get(scrollKey).paperId;
    resumeMemory.remember(scrollKey, {
      scrollTop: container.scrollTop,
      index,
      paperId,
    });
    reportVisiblePaper?.(paperId);
    if (!container.classList.contains('feed-container--scrolling')) {
      container.classList.add('feed-container--scrolling');
    }

    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(() => {
      container.classList.remove('feed-container--scrolling');
      // One storage write per settled scroll, not one per scroll event.
      resumeMemory.persist(scrollKey);
    }, SCROLL_IDLE_DELAY_MS);

    if (pendingSkippedPapersRef.current.size > 0) {
      schedulePendingSkipFlush();
    }
  }, [reportVisiblePaper, schedulePendingSkipFlush, scrollKey]);

  const displayState = getFeedDisplayState({
    hasPapers: papers.length > 0,
    loading,
    error,
    isRefreshing,
    showLoader,
    // A source says for itself whether it is still on its first load (the
    // Following feed does); the main feed derives it from its own history.
    initialLoadPending: (source ? Boolean(source.initialLoadPending) : !initialFeedReady) && !error,
    hasSourceEmptyState: Boolean(source?.emptyState),
  });
  const atomVeil = feedAtomVeilCopy({ displayState, loading, isRefreshing });
  const feedFailed = displayState === FEED_DISPLAY_STATES.ERROR;
  useEffect(() => {
    if (feedFailed) trackEvent('app_error', { kind: 'feed_load_failed' });
  }, [feedFailed, trackEvent]);

  // Pull-to-refresh, touch only, and only where the pill exists: a source
  // without a refresh of its own (the Similar layer) has nothing to pull.
  // utils/feedPullToRefresh.ts says where a pull may begin and how it ends.
  // Native listeners, not React's: React registers `touchmove` at the root as
  // passive, so `preventDefault` inside an `onTouchMove` prop is ignored —
  // and stopping the scroll is the whole point once the pull is ours.
  const canPull = papers.length > 0 && (!source || Boolean(source.refresh));
  useEffect(() => {
    const el = feedNode;
    if (!el || !canPull) return undefined;
    const state = pullRef.current;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const box = el.getBoundingClientRect();
      const startY = pullStartFrom({
        target: event.target as Element | null,
        scrollTop: el.scrollTop,
        clientY: touch.clientY,
        containerTop: box.top,
        containerHeight: box.height,
      });
      state.phase = startY === null ? 'idle' : 'pending';
      state.startY = startY ?? 0;
      state.startX = touch.clientX;
      state.startedAt = performance.now();
    };
    const onMove = (event: TouchEvent) => {
      if (state.phase === 'idle') return;
      const touch = event.touches[0];
      if (!touch) return;
      if (state.phase === 'pending') {
        if (touch.clientY === state.startY && touch.clientX === state.startX) return;
        if (!pullTakesOver({
          startY: state.startY, startX: state.startX, currentY: touch.clientY, currentX: touch.clientX,
        })) {
          state.phase = 'idle';
          return;
        }
        state.phase = 'owning';
      }
      if (event.cancelable) event.preventDefault();
      setPull(
        pullProgress({ startY: state.startY, currentY: touch.clientY }),
        pullTravelPx({ startY: state.startY, currentY: touch.clientY }),
      );
    };
    const onEnd = (event: TouchEvent) => {
      const owning = state.phase === 'owning';
      state.phase = 'idle';
      if (!owning) return;
      const touch = event.changedTouches[0];
      if (!touch) { setPull(0, 0); return; }
      const outcome = pullOutcome({
        startY: state.startY,
        endY: touch.clientY,
        elapsedMs: performance.now() - state.startedAt,
      });
      const { refresh, loading: busy, isRefreshing: running } = pullDepsRef.current;
      // Released short of a refresh is a spring: everything goes back.
      // Released into one is a hand-over: see `landPull`.
      if (outcome === 'refresh' && !busy && !running) {
        landPull();
        refresh();
      } else {
        setPull(0, 0);
      }
    };
    const onCancel = () => {
      state.phase = 'idle';
      setPull(0, 0);
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [feedNode, canPull, setPull, landPull]);




  // Las ramas de abajo también llevan el landmark. La auditoría vio
  // `/following` en su estado VACÍO, que es el que la cuenta de pruebas
  // alcanza, y ahí no había ni `<main>` ni `<h1>`: el landmark vivía sólo en
  // la rama con papers. Un estado de la página sigue siendo la página.
  if (displayState === FEED_DISPLAY_STATES.ERROR) {
    return (
      <FeedLandmark landmark={landmark} className="feed-empty">
        <EmptyState
          role="alert"
          art={<Petri pose="upset" className="feed-error-petri" />}
          title={'Error loading papers'}
          actions={(
            <Button size="sm" onClick={handleRefresh}>
              <ArrowsClockwise size={16} aria-hidden="true" />
              {'Try again'}
            </Button>
          )}
        >
          {getUiErrorMessage(error, 'FEED_LOAD_FAILED')}
        </EmptyState>
      </FeedLandmark>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.SKELETON) {
    return (
      <FeedLandmark landmark={landmark}>
        <div className="feed-container">
          <div className="feed-snap-item"><SkeletonCard /></div>
        </div>
      </FeedLandmark>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.SOURCE_EMPTY) {
    // Alternative sources bring their own empty state; Siguiendo must never
    // fall back to the generic For You copy that asks users to broaden their interests.
    return <FeedLandmark landmark={landmark} className="feed-empty">{source!.emptyState}</FeedLandmark>;
  }

  if (displayState === FEED_DISPLAY_STATES.EMPTY && !atomVeil) {
    return (
      <FeedLandmark landmark={landmark} className="feed-empty">
        <div className="atom-loader">
          <Petri pose="flask" className="petri-loader" />
        </div>
        <h2>{'Searching for discoveries...'}</h2>
        <p>
          {'There are no papers in your categories yet. Try broadening your interests.'}
        </p>
        <button className="feed-retry-btn" onClick={handleRefresh}>
          {'Explore again'}
        </button>
      </FeedLandmark>
    );
  }

  if (displayState === FEED_DISPLAY_STATES.FEED || atomVeil) {
  const refreshPhase = isRefreshing ? 'refreshing' : (refreshDone || doneHold) ? 'done' : 'idle';
  const refreshLabels = { refreshing: 'Refreshing…', done: 'Updated', idle: 'Refresh' };
  const refreshLabel = refreshLabels[refreshPhase];
  const faceMotion = refreshFaceMotion(refreshPhase, prefersReducedMotion);
  return (
    <FeedLandmark landmark={landmark}>
      {papers.length > 0 && (!source || source.refresh) && (
        <button
          type="button"
          ref={refreshPillRef}
          className={`feed-refresh${refreshPillHover || isRefreshing || refreshDone ? ' is-visible' : ''}${isRefreshing ? ' is-refreshing' : ''}${refreshDone && !isRefreshing ? ' is-done' : ''}`}
          onClick={handleRefresh}
          onFocus={(event) => setRefreshPillFocused(event.currentTarget.matches(':focus-visible'))}
          onBlur={() => setRefreshPillFocused(false)}
          disabled={isRefreshing}
          aria-busy={isRefreshing || undefined}
        >
          <span className="feed-refresh-face">
            {/* El medidor. Lleva las tres etiquetas apiladas e invisibles, y
                es lo único que decide el ancho de la píldora: con una caja
                quieta las caras sólo se cruzan, sin que nada se mueva de
                sitio. Antes lo hacía un `layout` de framer sobre la cara, y
                como la píldora va centrada (`left: 50%` + `translate: -50%`)
                su propia caja se re-centraba en el mismo fotograma sin estar
                animada: de ahí el texto yéndose a la izquierda, volviendo, y
                yéndose otra vez al acabar el refresco. */}
            <span className="feed-refresh-gauge" aria-hidden="true">
              {Object.values(refreshLabels).map((label) => (
                <span key={label} className="feed-refresh-content">
                  <ArrowsClockwise size={14} aria-hidden="true" />
                  <span className="feed-refresh-label">{label}</span>
                </span>
              ))}
            </span>
            <AnimatePresence initial={false}>
              <motion.span
                key={refreshPhase}
                className="feed-refresh-content"
                initial={faceMotion.initial}
                animate={faceMotion.animate}
                exit={faceMotion.exit}
              >
                {refreshPhase === 'done'
                  ? <Check size={14} aria-hidden="true" />
                  : (
                    <ArrowsClockwise
                      size={14}
                      aria-hidden="true"
                      className={`feed-refresh-icon${refreshPhase === 'refreshing' ? ' feed-refresh-icon--spinning' : ''}`}
                    />
                  )}
                <span className="feed-refresh-label">{refreshLabel}</span>
              </motion.span>
            </AnimatePresence>
          </span>
        </button>
      )}
      <div
        className={`feed-container${isRefreshing ? ' feed-container--refreshing' : ''}`}
        ref={attachFeed}
        onScroll={handleScroll}
      >
        {papers.map((paper, index) => (
          !inMountWindow(anchoredWindow, index) ? (
            // Outside the mount window: a full-height slot, so the scroll
            // extent and the snap points are already those of the finished
            // feed. It becomes a card when the window reaches it.
            <div key={paper.id} className="feed-snap-item feed-snap-item--pending" aria-hidden="true" />
          ) : (
          <div
            key={paper.id}
            className={`feed-snap-item${skipExit?.id === paper.id ? ' feed-snap-item--leaving' : ''}`}
            style={skipExit?.id === paper.id ? { top: `${skipExit.top}px`, height: `${skipExit.height}px` } : undefined}
            onAnimationEnd={skipExit?.id === paper.id ? handleSkipExitEnd : undefined}
          >
            <PaperCard
              paper={paper}
              isLiked={likedPaperIds.has(interactionIdFor(paper)!)}
              isSaved={savedPaperIds.has(interactionIdFor(paper)!)}
              isRead={readPaperIds?.has(interactionIdFor(paper)!)}
              onLike={toggleLike}
              onNotInterested={handleNotInterested}
              onMarkAsRead={markAsRead}
              onUnmarkAsRead={unmarkAsRead}
              trackViewTime={handleViewTime}
              trackSkip={handleSkip}
              onOpenPdf={handleOpenPdf}
              onSaveToList={handleSaveToList}
              onPickList={onSaveToList}
              getInteractionState={getInteractionState}
              analyticsSurface={analyticsSurface}
              position={index + 1}
              abstractLoading={Boolean(loadingAbstractIds?.has(paper.id))}
              // The scroll hint belongs to the first card only, and this prop is
              // the only thing that decides it now: a
              // `.feed-snap-item:not(:first-child) .pc-scroll-hint { display:
              // none }` CSS rule used to do the same job by DOM position, which
              // meant every other mounted card still rendered the hint and
              // relied on that rule (and, off screen, on `content-visibility`)
              // to keep it invisible. That rule is gone — first-card-only is
              // decided here, once, instead of being re-derived in CSS.
              hideScrollHint={index !== 0}
            />
          </div>
          )
        ))}

        {/* The wait at the end of the feed. It used to be a SkeletonCard
            mounted for exactly as long as `loading`, which failed three ways
            (measured 2026-10-06, production build): on a phone its blocks
            were the colour of their own ground, so the reader sat on an empty
            screen; on a desktop it was a boxed card the real card no longer
            resembles; and a load that chains a second page dropped `loading`
            for a commit, so the slot left, the scroll extent shrank under a
            reader parked on it, and it came back. It is now the feed's own
            loading mark — the atom of the first load — and it stays the last
            snap item for as long as more can come, so it is already there
            when the reader reaches it and never leaves from under them.
            Keyed by the count, so the slot the page lands on is a new element:
            kept as the same one, the browser re-snapped to it after the
            insert (a snapped element stays snapped) and carried the reader
            past the fifteen papers that had just arrived. */}
        {(loading || (hasMore && !error)) && (
          <div key={`tail-${papers.length}`} className="feed-snap-item feed-snap-item--tail">
            <div className="feed-tail">
              <div className="atom-loader feed-tail-atom" aria-hidden="true">
                <Petri pose="flask" className="petri-loader" />
              </div>
              <p className="feed-tail-label" aria-hidden="true">{'Loading more papers…'}</p>
              {/* Spoken only while a page is actually on its way: the slot
                  is mounted ahead of the load, and a fresh one after every
                  page, so a live region carrying the words from the start
                  would speak for waits that are not happening. */}
              <span className="visually-hidden" role="status">{loading ? 'Loading more papers…' : ''}</span>
            </div>
          </div>
        )}

        {showEndCard && (
          <div className="feed-snap-item feed-snap-item--end">{endCard}</div>
        )}

        {/* Sentinel for infinite scroll */}
        {hasMore && <div ref={sentinelRef} className="feed-sentinel" />}
      </div>

      {/* The wait, over the container rather than instead of it. While the
          papers are on their way this is the whole screen; the frame they
          land, the cards mount underneath and this recedes over them. */}
      <AnimatePresence>
        {atomVeil && (
          <motion.div
            key="atom-veil"
            className="feed-empty feed-empty--veil"
            role="status"
            aria-live="polite"
            aria-busy="true"
            variants={prefersReducedMotion ? ATOM_VEIL_REDUCED_VARIANTS : ATOM_VEIL_VARIANTS}
            initial={false}
            animate="shown"
            exit="gone"
          >
            <motion.div className="atom-loader" aria-hidden="true" variants={prefersReducedMotion ? undefined : ATOM_VARIANTS}>
              <Petri pose="flask" className="petri-loader" />
            </motion.div>
            <motion.div className="feed-empty-copy" variants={prefersReducedMotion ? undefined : ATOM_COPY_VARIANTS}>
              <h2>
                {atomVeil === 'gathering'
                  ? ('Gathering papers...')
                  : ('Searching for discoveries...')}
              </h2>
              <p>
                {'Connecting to scientific sources to bring you the latest research'}
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </FeedLandmark>
  );
  }

  return null;
}
