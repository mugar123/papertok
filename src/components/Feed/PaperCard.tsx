import type { ComponentProps, MouseEvent, SyntheticEvent, TransitionEvent } from 'react';
import type { Paper, PaperAuthor, PaperResearchResource } from '../../models/Paper.ts';
type OpenCopy = Awaited<ReturnType<typeof findOpenAccessCopy>>;
export interface PaperCardProps {
  paper: Paper;
  isLiked?: boolean;
  isSaved?: boolean;
  isRead?: boolean;
  onLike?: (paper: Paper) => void;
  onNotInterested?: (paper: Paper) => void;
  onGuestNotInterested?: (paperId: string) => void;
  onMarkAsRead?: (paper: Paper) => void;
  onUnmarkAsRead?: (paperId: string) => void;
  trackViewTime?: (paper: Paper, seconds: number) => void;
  trackSkip?: (paper: Paper) => void;
  onOpenPdf?: (paper: Paper) => void;
  onSaveToList?: (paper: Paper) => void;
  getInteractionState?: (paper: Paper) => { isLiked?: boolean; isSaved?: boolean; isRead?: boolean };
  hideScrollHint?: boolean;
  showFollowReason?: boolean;
  titleAs?: 'h1' | 'h2';
  publicMode?: boolean;
  onAuthRequired?: (reason: string) => void;
  analyticsSurface?: string;
  position?: number;
}

import { useState, useRef, useCallback, useLayoutEffect, useMemo, useEffect, useId, memo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORIES } from '../../data/categories.ts';
import {
  ArrowLeft,
  ArrowSquareOut,
  BookmarkSimple,
  Brain,
  Briefcase,
  Building,
  CaretDown,
  ChartBar,
  CheckCircle,
  CircleNotch,
  DotsThree,
  DownloadSimple,
  ClockCounterClockwise,
  Code,
  Cpu,
  CurrencyCircleDollar,
  Database,
  Dna,
  Eye,
  FileText,
  Flask,
  Gear,
  GraduationCap,
  Graph,
  Heart,
  Heartbeat,
  Lightning,
  Lock,
  LockOpen,
  Package,
  Planet,
  Prohibit,
  ShareNetwork,
  Sigma,
  Sparkle,
  TrendUp,
  UserCheck,
  X,
} from '@phosphor-icons/react';
import { useOverlayHistory } from '../../hooks/useOverlayHistory.ts';
import { useIsPageArriving } from '../../hooks/usePageArrival.ts';
import ScientificText from '../ScientificText.ts';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../Onboarding/Petri.tsx';
import { Toggle } from '../ui/toggle.tsx';
import { useFollowing } from '../../context/FollowingContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { getProjectForPaper } from '../../services/openAireService.ts';
import { authorExplorerPath } from '../../utils/explorerPaths.ts';
import { Link } from 'react-router-dom';
import { useStableNavigate } from '../../hooks/useStableNavigate.ts';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
// Before the card's own stylesheet on purpose: PaperCard.css restates a few
// of the drawer's box declarations for the two sheets and has to come later
// in the cascade to win them.
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import AbstractSheet from './AbstractSheet.tsx';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import SharePanel from './SharePanel.tsx';
import MoreActions from './MoreActions.tsx';
import { downloadCitationFile } from '../../utils/readingLibrary.ts';
import './PaperCard.css';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import useClipTooltip from '../../hooks/useClipTooltip.ts';
import { lazyWithPreload } from '../../utils/lazyPreload.ts';

// Preloaded once the card settles on a wider screen, so the map can stand in
// the slot on the very frame it is asked for (see the slot's height morph).
const RelatedPapersSheet = lazyWithPreload(() => import('./RelatedPapersSheet.tsx'));
import useIsPhone from '../../hooks/useIsPhone.ts';
import { findOpenAccessCopy } from '../../services/unpaywallService.ts';
import { findInstitutionAccess } from '../../services/institutionAccessService.ts';
import { institutionLabel } from '../../services/institutionService.ts';
import { useAuth } from '../../context/AuthContext.tsx';
import { getRelatedResearchResources } from '../../services/dataCiteService.ts';
import { getHuggingFaceResearchResources } from '../../services/huggingFaceService.ts';
import { isOpaqueQueryTopicText, resolvePaperTopic, topicExplorerPath } from '../../utils/topicNavigation.ts';
import { canRewritePaper } from '../../services/paperRewriteService.ts';
import { getPaperFigures, peekPaperFigures } from '../../services/paperFigureService.ts';
import { CARD_DURATION_MS } from '../../utils/scrollTween.ts';
import { areaAccentForPaper, areaKeyForPaper, areaLabelForPaper } from '../../utils/areaAccent.ts';
import { accessStatusForPaper, accessTagForPaper, reviewTagForPaper } from '../../utils/paperStatus.ts';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.ts';
import { buildPaperTopicTags } from '../../utils/paperTopicTags.ts';

/**
 * How still the abstract panel has to be before its clipping is believed: the
 * quiet demanded after the LAST size change, not a wait for the whole travel.
 * A 420ms collapse keeps resetting this, so the reading lands once — after it.
 */
const ABSTRACT_SETTLE_MS = 180;
// The abstract ⇄ map swap: the slide and the slot's height (`.pc-slot--morphing`
// in PaperCard.css) on one clock.
const SLOT_MORPH_MS = 240;

/**
 * A glyph per status, keyed the same way the tags are.
 *
 * The icons stay here rather than in `paperStatus.js` so that module holds no
 * React and can be read straight by `node --test`.
 */
const STATUS_CHIP_ICONS = {
  preprint: FileText,
  open: LockOpen,
  openCopy: LockOpen,
  subscription: Lock,
};
import { buildFollowReasonLabel } from '../../utils/followingFeed.ts';
import { isTechnicalClassification } from '../../utils/scientificClassification.ts';
import { getRelatedPaperIdentity } from '../../utils/relatedPaperTransition.ts';
import { hydrateCitationGraphPaper } from '../../services/citationGraphService.ts';
import { getSemanticScholarPaperId } from '../../services/relatedPapersService.ts';
import { resolveWithin } from '../../utils/asyncTiming.ts';
import {
  isTrustedInlinePdfUrl,
  openExternalUrl,
  safeDoiUrl,
  safeExternalUrl,
} from '../../utils/externalUrl.ts';
import { openFirstTarget, openTargetsForPaper } from '../../utils/paperOpenTargets.ts';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { getPublicEntityPath, getPublicPaperUrl } from '../../utils/publicNavigation.ts';
import { EASE_IN_OUT, EASE_OUT, EASE_OUT_EXPO, animateSize } from '../../utils/motionCurves.ts';

/** An author's name in its grid cell: ellipsed when it does not fit, and only
    then does resting on it show the whole name. */
function ClippedName({ name }: { name: string }) {
  const { ref, ...tooltip } = useClipTooltip();
  return (
    <Tooltip {...tooltip}>
      <TooltipTrigger render={<span ref={ref} className="pc-authors-list-name" />}>{name}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

// The reader drags in the annotations layer, LaTeX export and their CSS
// (PaperReader.css, Annotations.css, Export.css — ~53 KB raw source, ~28 KB
// once minified) — none of it belongs in the boot graph when most sessions
// never tap "read". It opens over a card that has already painted, so there
// is nothing to placehold while the chunk loads; `fallback={null}` is
// correct here, unlike the route-level `RouteFallback` used for `App.jsx`'s
// lazy routes.
const PaperReader = lazy(() => import('../Reader/PaperReader.tsx'));

// One quiet watermark per research area, engraved in the corner of
// the sheet. It replaces the old animated icon constellation: the same visual
// cue about the field, without the haze competing with the type.
const AREA_WATERMARK_ICONS = {
  physics: Planet,
  cs: Cpu,
  math: Sigma,
  stat: ChartBar,
  econ: TrendUp,
  'q-fin': CurrencyCircleDollar,
  eess: Lightning,
  mech: Gear,
  civil: Building,
  chemeng: Flask,
  med: Heartbeat,
  bio: Dna,
};

const RESOURCE_KIND_CONFIG = {
  dataset: { label: { en: 'Data' }, Icon: Database },
  model: { label: { en: 'AI model' }, Icon: Brain },
  software: { label: { en: 'Code' }, Icon: Code },
  material: { label: { en: 'Material' }, Icon: Package },
  version: { label: { en: 'Version' }, Icon: ClockCounterClockwise },
};
const ENRICHMENT_SETTLE_DELAY_MS = 240;
const SECONDARY_NETWORK_DELAY_MS = 900;
const RELATED_PAPER_HYDRATION_TIMEOUT_MS = 8_000;
// The library lookup says "Checking" only once it has taken this long, the
// delay every loading placeholder waits: a cached answer, or a fast one, goes
// straight from the record's label to the library's.
const LIBRARY_CHECKING_DELAY_MS = 320;
// How long a press during "Checking" waits for the library before opening
// what the record offers: under the browser's ~5 s of user activation, after
// which the new tab would be blocked.
const LIBRARY_PRESS_WAIT_MS = 3_000;

// Read once at module load, not per render: every card in the feed was
// hitting localStorage on its own render just to show a panel almost nobody
// has on. Whoever flips DEBUG_RANKING reloads to see it -- the same trade
// `shouldLogRanking` (recommendationEngine.js) makes for the ranking table,
// except that one is read live per batch because a batch is already a
// deliberate, infrequent event, not a per-card render.
//
// try/catch, not `?.`: this runs at module scope, before main.jsx ever calls
// createRoot(...).render(), so nothing has a React tree yet and
// GlobalErrorBoundary cannot catch anything thrown here. `?.` only guards a
// nullish `window.localStorage`; it does nothing when the *getter* itself
// throws, which is exactly what browsers with site storage blocked (Safari
// restricted mode, corporate policy, some extensions) do. An uncaught throw
// here used to mean a white screen on every route, not just the feed.
const SHOW_RANKING_DEBUG = (() => {
  try {
    return typeof window !== 'undefined'
      && window.localStorage?.getItem('DEBUG_RANKING') === 'true';
  } catch {
    return false;
  }
})();

// How far a clipping may stray from the corner it belongs to. Small on
// purpose: the point is that no two papers pin their figures at exactly the
// same angle, not that a figure could turn up anywhere.
const FIGURE_TILT_JITTER_DEG = 2.4;
const FIGURE_SHIFT_JITTER_PX = 14;
/* The idle float, retuned. It was 5–10px over a 6–9.5s round trip — under
   2px per second — behind a 3.2s wait before it even began, so a clipping
   appeared, sat perfectly still for three and a half seconds, and then crept.
   Slow enough that it read as something broken rather than as something
   floating. Twice the distance in half the time is about 4px per second: still
   a drift you would not call motion if asked, but one the eye registers. */
const FIGURE_DRIFT_MIN_PX = 8;
const FIGURE_DRIFT_JITTER_PX = 6;
const FIGURE_DRIFT_MIN_MS = 4_000;
const FIGURE_DRIFT_JITTER_MS = 2_000;
/* Each clipping gets a gradual fade and a gentle settle on separate curves.
   A tighter stagger keeps the four arrivals connected: the last settles at
   660ms, while each image has 480ms to become visible. */
const FIGURE_ENTRANCE_MS = 480;
const FIGURE_ENTRANCE_STAGGER_MS = 60;

/** FNV-1a, the same one `buildHighlightId` uses: short, stable, and enough to
 *  tell four slots of one paper apart. */
function figureHash(fingerprint: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * The scatter of one clipping, as custom properties the stylesheet reads.
 *
 * Derived from the paper's own identity and the figure's slot, never from
 * `Math.random()`: a re-render must not walk the figures around the card while
 * someone is reading. Two hashes because five values need more than the four
 * bytes one gives.
 */
function figureScatterStyle(identity: string, index: number, total: number) {
  // The slot goes in front of the identity, not behind it. FNV-1a only
  // avalanches forwards: with the index last, four figures of one paper came
  // out with the same middle bytes and so with the same shift — measured, not
  // assumed. Fed in first, it stirs the whole hash.
  const angles = figureHash(`${index}#${identity}`);
  const motion = figureHash(`${index}#drift#${identity}`);
  const unit = (hash: number, shift: number) => ((hash >>> shift) & 0xff) / 255;
  const signed = (hash: number, shift: number) => unit(hash, shift) * 2 - 1;
  // Slots one and two hug the left edge of the card, three and four the right,
  // so the shift always pushes inward and no amount of jitter can walk a
  // clipping off the page or over the text column. The exception is the pair:
  // with exactly two clippings the second one crosses to the bottom-right
  // corner — see `.pc-figure:nth-child(2):last-child` — and inward for it
  // means leftward, like the right-hand slots.
  const onRight = total === 2 ? index === 1 : index >= 2;
  const inward = onRight ? -1 : 1;
  return {
    '--fig-tilt': `${(signed(angles, 0) * FIGURE_TILT_JITTER_DEG).toFixed(2)}deg`,
    '--fig-shift-x': `${(unit(angles, 8) * FIGURE_SHIFT_JITTER_PX * inward).toFixed(1)}px`,
    '--fig-shift-y': `${(signed(angles, 16) * FIGURE_SHIFT_JITTER_PX).toFixed(1)}px`,
    '--fig-drift': `${(FIGURE_DRIFT_MIN_PX + unit(motion, 0) * FIGURE_DRIFT_JITTER_PX).toFixed(1)}px`,
    '--fig-drift-duration': `${Math.round(FIGURE_DRIFT_MIN_MS + unit(motion, 8) * FIGURE_DRIFT_JITTER_MS)}ms`,
    // The stagger is a delay, and the duration is the same for every slot.
    // The old worry about `animation-fill-mode: backwards` inside the feed's
    // `content-visibility: auto` subtree — that a held first frame is how a
    // figure ends up invisible for good — does not survive the gate this
    // animation already sits behind: the first frame it holds is
    // `opacity: 0`, which is exactly what `.pc-figure:not(.is-loaded)` paints
    // anyway, the class is only on while the card is at least 15% on screen
    // (so the subtree is not being skipped), and it is re-armed on every
    // return. Nothing can be held past the card leaving.
    '--fig-in-delay': `${index * FIGURE_ENTRANCE_STAGGER_MS}ms`,
    '--fig-in-duration': `${FIGURE_ENTRANCE_MS}ms`,
  };
}

function mergeResearchResources(...groups: PaperResearchResource[][]) {
  const seen = new Set();
  return groups.flat().filter(Boolean).filter(resource => {
    const key = `${resource.kind || ''}:${resource.url || resource.id || ''}`.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function RelatedPaperCardSkeleton({ label }: { label: string }) {
  return (
    <div className="related-card-loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="related-card-loading-content" aria-hidden="true">
        <span className="related-card-loading-line related-card-loading-meta" />
        <span className="related-card-loading-line related-card-loading-title" />
        <span className="related-card-loading-line related-card-loading-title related-card-loading-title-short" />
        <span className="related-card-loading-line related-card-loading-author" />
        <div className="related-card-loading-abstract">
          <span className="related-card-loading-line" />
          <span className="related-card-loading-line" />
          <span className="related-card-loading-line related-card-loading-copy-short" />
        </div>
      </div>
    </div>
  );
}

/**
 * The rail toggles sit on the card, which has its own pointer handlers; a
 * press on like, save or read is theirs alone. Base UI runs this before its
 * own click handler, so the state still flips through `onPressedChange`.
 */
const swallowClick = (event: SyntheticEvent) => event.stopPropagation();

const PaperCard = memo(function PaperCard({ 
  paper, 
  isLiked = false, 
  isSaved = false, 
  isRead = false, 
  onLike = () => {},
  onNotInterested = () => {},
  // Deliberately without a default: its absence is what tells this card the
  // surface has no list to drop a paper from, so a visitor is asked for the
  // account instead. Only the guest feed supplies it.
  onGuestNotInterested,
  onMarkAsRead = () => {},
  onUnmarkAsRead = () => {},
  trackViewTime = () => {},
  trackSkip = () => {},
  onOpenPdf = () => {},
  onSaveToList = () => {},
  getInteractionState = () => ({}),
  hideScrollHint = false,
  showFollowReason = false,
  // The title's level: an h2 wherever the card is one of many, the page's h1
  // where it is the page (PublicPaperPage).
  titleAs = 'h2',
  publicMode = false,
  onAuthRequired,
  analyticsSurface = 'feed',
  position,
}: PaperCardProps) {
  // `position` is optional and PaperCard renders on five different surfaces,
  // so it cannot anchor a stable, collision-free id for aria-controls.
  const abstractId = useId();
  const [expanded, setExpanded] = useState(false);
  // Whether the collapsed panel is actually hiding words. The toggle below the
  // abstract only earns its place when there is something to reveal: a short
  // abstract needs no control, and a paper that carries none at all must not
  // offer to expand what it does not have.
  // `null` until the panel has been measured, which is not the same as "fits":
  // the fade below is the honest state to show while the answer is unknown, so
  // a long abstract — the common case — never has one ease in over words that
  // were already painted clear. The toggle keeps treating anything but a firm
  // `true` as "nothing hidden", exactly as it did.
  const [abstractClipped, setAbstractClipped] = useState<boolean | null>(null);
  // On a phone a clipped abstract is read in a sheet rather than unfolded in
  // place (AbstractSheet): on a touch screen, or at phone width (useIsPhone,
  // 600px) whatever the pointer, where the unfolded panel is a few lines tall
  // and scrolls inside the card (2026-10-17). Wider windows unfold in place.
  const [showAbstractSheet, setShowAbstractSheet] = useState(false);
  const closeAbstractSheet = useCallback(() => setShowAbstractSheet(false), []);
  const coarsePointer = useMemo(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }, []);
  // Read by the measurement below, which must not re-run when the panel opens:
  // a reading taken while it travels between its two heights is of the height
  // the animation is passing through, not the one it rests at.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [showHeart, setShowHeart] = useState(false);
  const heartTimer = useRef<number | null>(null);
  useEffect(() => () => clearTimeout(heartTimer.current!), []);
  const [showAuthorsModal, setShowAuthorsModal] = useState(false);
  // On a desktop the dots unfold every author under them; a phone
  // keeps the sheet (a tap on the row).
  const [authorsExpanded, setAuthorsExpanded] = useState(false);
  const authorsListId = useId();
  // The sheet is leaving with the page: an author was picked from it. It
  // closes in its leaving pose (`is-leaving`, PaperCard.css) — a short drop
  // and a fade on the page's own leaving curve, 0.18 s against the page's
  // 0.2 s — instead of the drawer's slide back down the screen (~0.4 s),
  // which the page's unmount cut off part-way when the card went.
  const [authorsSheetLeaving, setAuthorsSheetLeaving] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
  // On a wider screen the connections take the abstract's place in the card;
  // a phone has no room for them there and keeps the bottom sheet.
  const isPhone = useIsPhone();
  const relatedInline = showRelated && !isPhone;
  // Once the connections have stood in the slot, the abstract coming back is
  // a swap, not the card's arrival: it slides in and does not replay that.
  const [slotSwapped, setSlotSwapped] = useState(false);
  const [showReader, setShowReader] = useState(false);
  // Back closes the reader instead of leaving PaperTok: see useOverlayHistory.js.
  // It must ASK the reader to close (its own `requestClose`, which the X and
  // Escape also use) rather than unmount it here — the dialog owns `open` and
  // tells this card only once its leave has played. `setShowReader(false)` is
  // the fallback for the one window where there is nothing to ask: the lazy
  // chunk has not mounted yet, so the ref is still empty.
  const readerCloseRef = useRef<(() => void) | null>(null);
  const requestReaderClose = useCallback(() => {
    if (readerCloseRef.current) readerCloseRef.current();
    else setShowReader(false);
  }, []);
  useOverlayHistory(showReader, requestReaderClose, 'reader');
  /* Where the reader should grow from. The rewrite button's rectangle at the
     moment it was pressed, so the full-screen reader can open out of it and
     collapse back into it rather than appearing from nowhere. */
  const [readerOrigin, setReaderOrigin] = useState<ComponentProps<typeof PaperReader>['originRect']>(null);
  const [pendingRelatedPaper, setPendingRelatedPaper] = useState<Paper | null>(null);
  const [selectedRelatedPaper, setSelectedRelatedPaper] = useState<Paper | null>(null);
  const [isClosingRelatedCard, setIsClosingRelatedCard] = useState(false);
  const [isResolvingAccess, setIsResolvingAccess] = useState(false);
  const [resolvedAccess, setResolvedAccess] = useState<{ paperId: string | null; copy: OpenCopy }>({ paperId: null, copy: null });
  // The reader's library's answer, for this paper at this institution. Keyed by
  // both, so unlinking or switching accounts discards it without an effect.
  const [institutionAccess, setInstitutionAccess] = useState<{ paperId: string | null; domain: string | null; access: Awaited<ReturnType<typeof findInstitutionAccess>> }>({ paperId: null, domain: null, access: null });
  // The library is being asked about this paper at this institution and has
  // not answered within LIBRARY_CHECKING_DELAY_MS: the button says "Checking".
  const [checkingLibraryFor, setCheckingLibraryFor] = useState<string | null>(null);
  // The face the primary button is pushing out (PaperCard.css, `.pc-action-out`)
  // and which way: forward to "Checking" or the library, back to the record.
  const [actionPush, setActionPush] = useState<{ from: 'record' | 'checking'; dir: 'forward' | 'back' } | null>(null);
  const readButtonRef = useRef<HTMLButtonElement | null>(null);
  // The button's width before its label changes, and whether the change pushes.
  const readButtonFrom = useRef<{ width: number; push: boolean } | null>(null);
  const [linkedResources, setLinkedResources] = useState<{ paperId: string | null; items: PaperResearchResource[] }>({ paperId: null, items: [] });
  const [isCardVisible, setIsCardVisible] = useState(false);
  // Whether the clippings are lit. Deliberately NOT `isCardVisible`: the two
  // ends of a card's turn on screen want different thresholds, and one flag
  // cannot hold both. It is armed at the same 15% that starts the fetch — late
  // enough that the entrance is still running when the card is centred — and
  // disarmed only once the card is out of view ENTIRELY. Disarming at 15% too
  // meant the outgoing card cut its figures from 0.62 to 0 in one frame with a
  // sliver of it still on screen, which is a flicker the reader would catch on
  // every swipe; a card that is fully gone can be undressed for free.
  const [figuresLit, setFiguresLit] = useState(false);
  const [isCardSettled, setIsCardSettled] = useState(false);
  const [isCardIdle, setIsCardIdle] = useState(false);
  // Which clippings this card has. Born with them when the cache already holds
  // them: `peekPaperFigures` is a plain Map read, so this costs nothing, and it
  // is the difference between a card that arrives whole and one that arrives
  // empty and fills in afterwards. Measured 2026-09-11 coming back from
  // Research: the page reached rest at 237ms and the figures — cached, bytes in
  // the browser, no request — did not exist until 290ms, so their entrance
  // played over a card that had already stopped moving.
  const [figures, setFigures] = useState(() => peekPaperFigures(paper)?.slice(0, 4) ?? []);
  const { followedByType, isFollowing } = useFollowing();
  const { institution } = useAuth();
  const { language } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  // Not `useNavigate`: that subscribes every mounted card to the location
  // (hooks/useStableNavigate.js says what it cost).
  const navigate = useStableNavigate();
  
  const hasFollowedAuthor = useMemo(() => {
    if (!paper?.authors?.length || !followedByType.author?.length) return false;
    return paper.authors.some(author => isFollowing({
      type: 'author',
      id: (author as PaperAuthor)?.id || (author as PaperAuthor)?.name || author as string,
      name: (author as PaperAuthor)?.name || author as string,
    }));
  }, [followedByType.author, isFollowing, paper]);

  const lastTap = useRef(0);
  const abstractRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const viewStartTime = useRef<number | null>(null);
  const totalViewTime = useRef(0);
  const relatedCardClosingRef = useRef(false);
  const relatedPreparationRef = useRef<{ identity: string; promise: Promise<Partial<Paper> | null> } | null>(null);
  const relatedHydrationRequestRef = useRef(0);
  const analyticsViewedPaperRef = useRef<string | null>(null);
  const paperViewKey = paper?.id || paper?.doi || paper?.arxivId || 'paper';

  // A NEW paper in the same card. The feed keys its cards by paper so this
  // never fires there, but the overlay surfaces (the explorer, search) hand
  // one mounted card a different paper, and the old paper's
  // clippings must not be painted against the new one. Adjusted during render
  // — React's documented way to reset state when a prop changes — because an
  // effect only runs AFTER the frame that already showed them.
  const [figuresPaperKey, setFiguresPaperKey] = useState(paperViewKey);
  if (figuresPaperKey !== paperViewKey) {
    setFiguresPaperKey(paperViewKey);
    setFigures(peekPaperFigures(paper)?.slice(0, 4) ?? []);
  }

  useEffect(() => {
    if (!isCardVisible) {
      setIsCardSettled(false);
      setIsCardIdle(false);
      return undefined;
    }

    const settleTimer = setTimeout(() => setIsCardSettled(true), ENRICHMENT_SETTLE_DELAY_MS);
    const idleTimer = setTimeout(() => setIsCardIdle(true), SECONDARY_NETWORK_DELAY_MS);
    return () => {
      clearTimeout(settleTimer);
      clearTimeout(idleTimer);
    };
  }, [isCardVisible]);

  useEffect(() => {
    let active = true;
    if (!isCardIdle || !paper?.doi || paper.openAccess || paper.pdfUrl || paper.openAccessPdfUrl || paper.citationMetadataResolved) {
      return () => { active = false; };
    }

    findOpenAccessCopy(paper.doi).then(openCopy => {
      if (active && openCopy) setResolvedAccess({ paperId: paper.id, copy: openCopy });
    });

    return () => { active = false; };
  }, [isCardIdle, paper?.citationMetadataResolved, paper?.doi, paper?.id, paper?.openAccess, paper?.openAccessPdfUrl, paper?.pdfUrl]);

  useEffect(() => {
    let active = true;
    const baseResources = paper?.researchResources || [];
    setLinkedResources({ paperId: paper?.id, items: baseResources });
    if (!isCardIdle) return () => { active = false; };

    const providers = new Set([paper?.sources?.primary, ...(paper?.sources?.enrichedBy || [])]);
    const requests = [];
    if (paper?.doi) requests.push(getRelatedResearchResources(paper.doi, { title: paper.title }));
    if (paper?.arxivId && providers.has('huggingface')) {
      requests.push(getHuggingFaceResearchResources(paper.arxivId));
    }
    if (requests.length === 0) return () => { active = false; };

    Promise.allSettled(requests).then(results => {
      if (!active) return;
      const remoteResources = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
      setLinkedResources({
        paperId: paper.id,
        items: mergeResearchResources(baseResources, remoteResources),
      });
    });
    return () => { active = false; };
  }, [isCardIdle, paper?.arxivId, paper?.doi, paper?.id, paper?.researchResources, paper?.sources, paper?.title]);

  useEffect(() => {
    if (!cardRef.current || showRelated || selectedRelatedPaper) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        setIsCardVisible(entry.isIntersecting && entry.intersectionRatio >= 0.15);
        if (entry.isIntersecting && entry.intersectionRatio >= 0.15) setFiguresLit(true);
        else if (!entry.isIntersecting) setFiguresLit(false);
        if (entry.isIntersecting && entry.intersectionRatio > 0.5) {
          if (analyticsViewedPaperRef.current !== paperViewKey) {
            analyticsViewedPaperRef.current = paperViewKey;
            trackEvent('paper_view', { surface: analyticsSurface, position });
          }
          if (!viewStartTime.current) viewStartTime.current = Date.now();
        } else {
          if (viewStartTime.current) {
            totalViewTime.current += (Date.now() - viewStartTime.current) / 1000;
            viewStartTime.current = null;
            
            // Paper just went out of view. Report time and trigger re-rank!
            if (totalViewTime.current >= 1.0) {
              trackViewTime(paper, totalViewTime.current);
            } else if (totalViewTime.current > 0.1 && totalViewTime.current < 1.0) {
              trackSkip(paper);
            }
            
            // Reset to prevent double counting if they scroll back up
            totalViewTime.current = 0;
          }
        }
      },
      { threshold: [0, 0.15, 0.5] }
    );
    observer.observe(cardRef.current);

    return () => {
      observer.disconnect();
      if (viewStartTime.current) {
        totalViewTime.current += (Date.now() - viewStartTime.current) / 1000;
        if (totalViewTime.current >= 1.0) {
          trackViewTime(paper, totalViewTime.current);
        } else if (totalViewTime.current > 0.1 && totalViewTime.current < 1.0) {
          trackSkip(paper);
        }
      }
    };
  }, [analyticsSurface, paper, paperViewKey, position, selectedRelatedPaper, showRelated, trackEvent, trackViewTime, trackSkip]);

  useEffect(() => {
    let active = true;
    // The settle timer is for a card that arrived WITHOUT its clippings: it
    // keeps a fetch off the frames the card is still arriving on. One that was
    // born with them has nothing to wait for and nothing to ask.
    if (!isCardSettled || figures.length > 0) return () => { active = false; };
    getPaperFigures(paper).then(found => {
      // Four is what the margins hold either side of the sheet.
      if (active && found.length > 0) setFigures(found.slice(0, 4));
    });
    return () => { active = false; };
  }, [isCardSettled, paper, figures.length]);

  // Held still across renders: the scatter is already deterministic, and a
  // stable object means React never rewrites the inline styles either.
  const scatteredFigures = useMemo(
    () => figures.map((item, index) => ({
      item,
      style: figureScatterStyle(paperViewKey, index, figures.length),
    })),
    [figures, paperViewKey],
  );

  // Which clippings have their picture. A figure is not shown on the strength of
  // having a URL — see `.pc-figure:not(.is-loaded)` — so this is what lets it in.
  //
  // Having the bytes is only half of it. The entrance is a CSS animation that
  // starts when the element is given it, so gating it on `load` alone tied it to
  // something that happens exactly once in a picture's life, and the reader
  // often was not looking when it did. Measured 2026-09-11, production build,
  // real session, the reader's own path (feed -> institution -> back): coming
  // back, the FIRST frame the figures existed they already carried `is-loaded`
  // and `figureClipIn@0` — the pictures were in the browser's cache, so
  // `complete` was true the instant the <img> attached — and the 620ms entrance
  // ran 262ms into a 300ms page transition. From then on `figureClipIn` was gone
  // from `getAnimations()` altogether: four of seven clippings reached the
  // screen with their entrance already spent, which is the "they are just there"
  // the reader reported.
  //
  // So `is-loaded` means the picture is in hand AND the card is in front of the
  // reader. It falls away when the card leaves — off screen, where nothing is
  // seen going — and comes back when the card does, and an element being given
  // an animation again is what restarts it. This is also what the rest of the
  // card already does: `pcArrive` is on the pieces unconditionally and plays
  // every time they mount, rather than once per paper.
  const [loadedFigures, setLoadedFigures] = useState(() => new Set<string>());

  // A new paper means new URLs; carrying the old set over would flash the next
  // paper's frames in before their images.
  useEffect(() => { setLoadedFigures(new Set()); }, [paperViewKey]);

  const markFigureLoaded = useCallback((url: string) => {
    setLoadedFigures(current => (current.has(url) ? current : new Set(current).add(url)));
  }, []);

  // A clipping comes back WITH its page, not on a clock of its own.
  //
  // Coming back to the feed the card remounts, the pictures are cached, and
  // `is-loaded` lands within a frame or two — so the full entrance replays while
  // the page is still travelling. Measured 2026-09-12 (production build, real
  // session, back from an author page onto a card with four clippings): it
  // started on the FIRST frame of the return and was still running 450ms after
  // the page had stopped; at the frame the page came to rest the four sat at
  // 0.49, 0.33, 0.10 and 0.00 of their resting 0.62, the last finishing near
  // 750ms — while the card's own words were already where they had been left.
  //
  // Same rule the entity hero's settle answers to: ONE OWNER PER ARRIVAL. Ask
  // `useIsPageArriving` at the instant the clippings are handed the entrance,
  // and if the page is travelling right then they RESUME instead — the stagger,
  // the rise and the scale go, a plain fade on the page's clock stays
  // (PaperCard.css). Taking the animation away altogether was tried the same
  // night and reverted: the clippings then appeared in one frame, and a jump
  // reads worse than a tail.
  //
  // It is not the page's arrival DIRECTION: that attribute stays on the root for
  // the whole visit and would silence every card scrolled to afterwards, which
  // is what 41cd627 fixed. This gate lasts exactly as long as the transition.
  const isPageArriving = useIsPageArriving();
  const [figuresResumed, setFiguresResumed] = useState(false);
  const figuresVerdictRef = useRef(false);
  const figuresShown = figuresLit && figures.some((item) => loadedFigures.has(item.url));

  // A layout effect, so the verdict is in before the frame is painted: React
  // flushes a state update made here before paint, and the entrance never gets
  // a frame of its own to flash in.
  useLayoutEffect(() => {
    if (!figuresShown) {
      figuresVerdictRef.current = false;
      setFiguresResumed(false);
      return;
    }
    if (figuresVerdictRef.current) return;
    figuresVerdictRef.current = true;
    if (isPageArriving()) setFiguresResumed(true);
  }, [figuresShown, isPageArriving]);

  const [project, setProject] = useState<Awaited<ReturnType<typeof getProjectForPaper>>>(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    let isMounted = true;
    if (!isCardIdle || !paper) return;
    getProjectForPaper(paper.arxivId, paper.doi).then(proj => {
      if (isMounted && proj) {
        setProject(proj);
      }
    });
    return () => { isMounted = false; };
  }, [isCardIdle, paper]);

  /* Opening the abstract or the author list must only grow the card
     downward. Two things anchored it elsewhere: the sheet is centred in the
     card (on a tall screen it grew both ways), and its content is bottom-
     anchored inside it (once at full height, growing pushed the title up).
     While either is open, both are pinned where they stand: the sheet's top
     in the card, the body's top in the sheet. Measured on the press, before
     the state flips: the open abstract changes its flex and its ceiling in
     the very commit that opens it, so by the layout effect the centred sheet
     had already grown and re-centred, and the pin froze the shifted position
     (the kicker sat 55px higher while open, measured 2026-10-16). Closing
     shrinks back from the bottom; once that has finished everything is where
     it started, and the pins are let go. */
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetGrown = expanded || authorsExpanded || relatedInline;
  const pinSheet = () => {
    const sheet = sheetRef.current;
    const frame = sheet?.parentElement;
    const body = sheet?.querySelector<HTMLElement>(':scope > .pc-body');
    if (!sheet || !frame || !body || sheet.dataset.pinned) return;
    const sheetTop = sheet.getBoundingClientRect().top - frame.getBoundingClientRect().top
      - parseFloat(getComputedStyle(frame).paddingTop);
    const bodyTop = body.getBoundingClientRect().top - sheet.getBoundingClientRect().top
      - parseFloat(getComputedStyle(sheet).paddingTop);
    sheet.dataset.pinned = 'true';
    sheet.style.alignSelf = 'flex-start';
    sheet.style.marginTop = `${sheetTop}px`;
    sheet.style.maxHeight = `calc(100% - ${sheetTop}px)`;
    sheet.style.justifyContent = 'flex-start';
    body.style.marginTop = `${bodyTop}px`;
  };
  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const body = sheet?.querySelector<HTMLElement>(':scope > .pc-body');
    if (!sheet || !body) return undefined;
    if (sheetGrown) {
      // Opened some other way than a press: pin late rather than not at all.
      pinSheet();
      return undefined;
    }
    if (!sheet.dataset.pinned) return undefined;
    // The longest of the closing transitions: the abstract's 0.42s.
    const release = setTimeout(() => {
      delete sheet.dataset.pinned;
      sheet.style.alignSelf = '';
      sheet.style.marginTop = '';
      sheet.style.maxHeight = '';
      sheet.style.justifyContent = '';
      body.style.marginTop = '';
    }, 460);
    return () => clearTimeout(release);
  }, [sheetGrown]);

  /* The panel's height, opening and closing. Its ceiling goes from a length
     to `100%` of a body with no definite height, which no transition can
     interpolate, so it used to jump open in one frame. The height it had on
     the press and the one it lands on are both measurable; the panel travels
     between them on the card's clock. Reduced motion keeps the jump. */
  const abstractFromHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const panel = abstractRef.current;
    const from = abstractFromHeight.current;
    abstractFromHeight.current = null;
    if (!panel || from == null || prefersReducedMotion) return;
    // `overflowY: hidden` for the length of the travel: the open panel
    // scrolls (`overflow-y: auto`), and with its content taller than the box
    // mid-way a scrollbar would come and go and re-wrap the text.
    animateSize(panel, 'maxHeight', from, CARD_DURATION_MS, EASE_OUT_EXPO, { overflowY: 'hidden' });
  }, [expanded, prefersReducedMotion]);

  /* And the slot's height morphs from the face it had to the one it gets, on
     a CSS transition (PaperCard.css, CARD_DURATION_MS) that a second press
     retargets from wherever it is. The target is read before the first
     frame: the arriving face as the column will finally hold it, squeezed on
     a short card. The face is laid out at that size from the start and the
     slot opens over it, so the map measures its plot once. Read later, the
     face first stood at its full height and then shrank when the slot let
     go, and the map laid its papers out twice. A face that cannot render yet
     (its chunk still loading) has no height to go to, and simply arrives. */
  const slotRef = useRef<HTMLDivElement | null>(null);
  const slotTrackRef = useRef<HTMLDivElement | null>(null);
  const slotFromHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const track = slotTrackRef.current;
    const from = slotFromHeight.current;
    slotFromHeight.current = null;
    if (!slot || !track || from == null || prefersReducedMotion) return undefined;
    slot.classList.remove('pc-slot--morphing');
    slot.style.height = '';
    track.style.height = '';
    const to = slot.offsetHeight;
    if (to === 0 || Math.abs(to - from) < 2) return undefined;
    track.style.height = `${to}px`;
    slot.style.height = `${from}px`;
    slot.classList.add('pc-slot--morphing');
    // Commit the starting height, so the next one is a transition to it.
    slot.getBoundingClientRect();
    slot.style.height = `${to}px`;
    const land = setTimeout(() => {
      slot.classList.remove('pc-slot--morphing');
      slot.style.height = '';
      track.style.height = '';
    }, SLOT_MORPH_MS + 60);
    return () => clearTimeout(land);
  }, [relatedInline, prefersReducedMotion]);

  const toggleExpanded = (e: SyntheticEvent, newState: boolean) => {
    e.stopPropagation();
    // A panel that hides nothing has nothing to open. Without this, tapping an
    // abstract that fits whole flipped `expanded` on, and the toggle — reserved
    // beneath it, invisible — came up saying "Show less" for a panel that had
    // never been anything but open (measured 2026-09-18, guest feed, desktop).
    if (newState && abstractClipped !== true) return;
    if (newState) pinSheet();
    // Only opening travels. Closing is done reading, and the panel is simply
    // back at its first line (2026-10-17): no height travel, no scroll back.
    abstractFromHeight.current = newState ? abstractRef.current?.offsetHeight ?? null : null;
    setExpanded(newState);
    if (!newState && abstractRef.current) abstractRef.current.scrollTop = 0;
  };

  /**
   * What the panel is showing, and a key that changes only when the words do.
   *
   * A list hands this card a stored copy of a paper, which carries no
   * abstract at all: `serializeLibraryPaper` keeps a
   * title, authors and a truncated summary, not the text. So a paper opened
   * from Favourites paints "Abstract unavailable." and then, a beat later,
   * arXiv and OpenAlex answer with the real thing.
   *
   * The key is not the text itself. A 1,500-character paragraph as a React key
   * is paid for on every render, and all this has to answer is whether these
   * are the same words as before.
   */
  const abstractText = hasUsableAIAbstract(paper.abstract) ? paper.abstract : null;
  // The words, or the state that says there are none, cross on these.
  const abstractSwap = {
    initial: { opacity: 0 },
    animate: {
      opacity: 1,
      transition: { duration: prefersReducedMotion ? 0.1 : 0.34, ease: EASE_OUT_EXPO },
    },
    exit: {
      opacity: 0,
      transition: { duration: prefersReducedMotion ? 0.08 : 0.18, ease: EASE_OUT },
    },
  };
  /* The map slides in from the right as the abstract leaves to the left;
     `popLayout` lifts the leaving face out of the flow, so the slot measures
     only the arriving one. Going back is a return, not an arrival: the
     abstract is simply there again and the map goes at once, and only the
     slot's height eases. Reduced motion keeps the fade and drops the travel. */
  const slotSlide = {
    enter: (direction: number) => ({
      opacity: 0,
      transform: `translateX(${prefersReducedMotion ? 0 : direction * 40}px)`,
    }),
    center: {
      opacity: 1,
      transform: 'translateX(0px)',
      transition: { duration: prefersReducedMotion ? 0.12 : SLOT_MORPH_MS / 1000, ease: EASE_IN_OUT },
    },
    exit: (direction: number) => (direction < 0
      ? { opacity: 0, transition: { duration: 0 } }
      : {
        opacity: 0,
        transform: `translateX(${prefersReducedMotion ? 0 : -40}px)`,
        transition: { duration: prefersReducedMotion ? 0.08 : 0.2, ease: EASE_OUT },
      }),
  };
  const abstractKey = abstractText
    ? `abstract:${abstractText.length}:${abstractText.slice(0, 24)}`
    : 'abstract:none';

  // The paragraph the panel is showing, the height it stands at, and the way to
  // end a resize that is still running.
  const lastAbstractParagraph = useRef<HTMLParagraphElement | null>(null);
  const lastAbstractHeight = useRef<number | null>(null);
  const settleAbstractResize = useRef<(() => void) | null>(null);

  /**
   * The height is tracked by an observer rather than measured on every render,
   * and that is not a micro-optimisation: the swap below is committed by
   * AnimatePresence's own state, which re-renders the paragraph WITHOUT
   * re-rendering this card. Measuring per render was therefore both too often
   * and, at the one moment it matters, not often enough — the first build of
   * this ran the panel's growth 390ms after the words had already changed,
   * which is the jump it was meant to remove plus a bounce afterwards.
   */
  useEffect(() => {
    const node = abstractRef.current;
    if (!node) return undefined;
    lastAbstractHeight.current = node.offsetHeight;
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      lastAbstractHeight.current = node.offsetHeight;
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      settleAbstractResize.current?.();
    };
    // The panel is a new node each time the connections give its place back.
  }, [relatedInline]);

  /**
   * Whether the collapsed panel is hiding words, which is the only thing that
   * earns the toggle below it a place on the card.
   *
   * Two things make the reading harder than `scrollHeight > clientHeight`.
   *
   * The panel is sized by the flex room its siblings leave, and that is not
   * resolved in the commit that mounts it — measuring there reads a box with no
   * height yet and calls every abstract clipped. Hence the frame's wait.
   *
   * And a collapse looks from here like a storm of resizes whose early frames
   * still report the open height, so they answer "nothing is hidden" about a
   * panel that is mid-travel. Reading only once the size has been quiet for a
   * moment takes the settled answer instead of one the transition passed
   * through, which is also what stops the button blinking out and back.
   *
   * `expandedRef` rather than `expanded` keeps all of this out of the effect's
   * dependencies: an open panel clips nothing, and re-running on open would
   * throw away the verdict that earned the button its place.
   */
  useEffect(() => {
    if (!abstractText) {
      setAbstractClipped(false);
      return undefined;
    }
    // With the connections up the abstract is only leaving: the verdict it
    // had stays, or its button blinks on the face sliding out.
    if (relatedInline) return undefined;
    let alive = true;
    let settleTimer: number | null = null;
    const read = () => {
      const node = abstractRef.current;
      if (!alive || !node || expandedRef.current) return;
      // While the slot holds a passing height the box is not the abstract's
      // own, and an answer read from it blinks the button: ask again later.
      if (slotRef.current?.classList.contains('pc-slot--morphing')) {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(read, ABSTRACT_SETTLE_MS);
        return;
      }
      const clipped = node.scrollHeight - node.clientHeight > 1;
      setAbstractClipped(clipped);
      // The panel's height is whatever the flex room leaves, so its edge
      // fell mid-line and the fade ended on half a row of letters. The mask
      // stops at the last whole line instead (`--pc-abstract-cut`, PaperCard.css).
      const words = node.querySelector<HTMLElement>(':scope > p');
      const line = words ? parseFloat(getComputedStyle(words).lineHeight) : 0;
      const shown = node.clientHeight - (words?.offsetTop ?? 0);
      const cut = clipped && line > 0 ? shown % line : 0;
      node.style.setProperty('--pc-abstract-cut', `${cut}px`);
    };
    const settle = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(read, ABSTRACT_SETTLE_MS);
    };
    const frame = requestAnimationFrame(() => requestAnimationFrame(read));
    const node = abstractRef.current;
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(settle);
    if (node && observer) observer.observe(node);
    window.addEventListener('resize', settle);
    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      if (settleTimer) clearTimeout(settleTimer);
      observer?.disconnect();
      window.removeEventListener('resize', settle);
    };
  }, [abstractKey, abstractText, relatedInline]);

  /* A card with no abstract shows the empty state in the middle of the room
     the abstract would take, which is lower than the card's centre, where the
     rail sits. The rail follows the state instead (`--rail-shift`, applied as
     a `translate` in PaperCard.css), kept inside the card. Every other card
     keeps its rail at the centre. */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    if (abstractText || relatedInline) {
      card.style.removeProperty('--rail-shift');
      return undefined;
    }
    const measure = () => {
      const state = card.querySelector<HTMLElement>('.pc-abstract-empty .empty-state');
      const rail = card.querySelector<HTMLElement>('.pc-side-actions');
      if (!state || !rail) {
        card.style.removeProperty('--rail-shift');
        return;
      }
      const box = card.getBoundingClientRect();
      const words = state.getBoundingClientRect();
      const room = Math.max(0, (box.height - rail.offsetHeight) / 2 - 8);
      const shift = (words.top + words.height / 2) - (box.top + box.height / 2);
      card.style.setProperty('--rail-shift', `${Math.round(Math.max(-room, Math.min(room, shift)))}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(card);
    // The state keeps its size while the rows above it settle (chips, a
    // late badge) and move it; the box around it is what resizes then.
    const room = card.querySelector<HTMLElement>('.pc-abstract');
    if (room) observer?.observe(room);
    return () => observer?.disconnect();
  }, [abstractText, relatedInline]);

  /**
   * The other half of the swap: the panel eases between the height it had and
   * the height the new words need, on the card's own curve and duration.
   *
   * The words were the smaller half of the problem. The sheet is bottom
   * anchored (`justify-content: flex-end`), so one line of "Abstract
   * unavailable." becoming a full column of text threw the title, the authors
   * and the badges upward in a single frame — the reader's eye lost the line it
   * was on.
   *
   * It hangs off the paragraph's ref, which is the only hook that fires in the
   * commit that actually replaces the element, and it fires before the browser
   * paints it: the height the panel jumped to is measured and put back in the
   * same breath, so what is painted is the first frame of the transition rather
   * than the jump.
   */
  const attachAbstractBody = useCallback((paragraph: HTMLParagraphElement | null) => {
    const previous = lastAbstractParagraph.current;
    // Detaching. `previous` has to survive it: it is what the attach of the
    // paragraph replacing this one compares itself against.
    if (!paragraph) return;
    lastAbstractParagraph.current = paragraph;

    const node = abstractRef.current;
    const from = lastAbstractHeight.current;
    // First words on the card, or a re-attach of the same ones (this callback
    // changes identity when the panel opens): nothing has been replaced.
    if (!node || !previous || previous === paragraph || from === null) return;
    // Open, the panel is sized by the room its siblings leave rather than by
    // its own text, so there is no height to travel — only the words change.
    if (expanded || prefersReducedMotion) return;

    // A swap on top of a swap starts from wherever the panel has got to, which
    // is what `from` already holds; this only hands the height back so the
    // measurement below is of the text and not of the animation.
    settleAbstractResize.current?.();
    const target = node.offsetHeight;
    if (Math.abs(target - from) < 1) return;

    node.style.height = `${from}px`;
    node.classList.add('pc-abstract--resizing');
    // Read back, or the browser folds both heights into one style change and
    // there is nothing left to transition between.
    void node.offsetHeight;
    node.style.height = `${target}px`;

    let backstop: number | null = null;
    const settle = () => {
      clearTimeout(backstop!);
      settleAbstractResize.current = null;
      node.style.height = '';
      node.classList.remove('pc-abstract--resizing');
      lastAbstractHeight.current = node.offsetHeight;
    };
    // `transitionend` below does the finishing. This only covers the case where
    // it never arrives — an interrupted transition fires nothing — because an
    // inline height left behind would pin the panel at that size for good.
    backstop = setTimeout(settle, CARD_DURATION_MS + 120);
    settleAbstractResize.current = settle;
  }, [expanded, prefersReducedMotion]);

  // The clipped abstract's door on a phone: the sheet, not the fold. Once the
  // panel is open (a fine pointer got it there) the toggle closes it as ever.
  const readsInSheet = (coarsePointer || isPhone) && abstractClipped === true && !expanded;
  const openAbstract = (e: SyntheticEvent) => {
    if (readsInSheet) {
      e.stopPropagation();
      setShowAbstractSheet(true);
      return;
    }
    toggleExpanded(e, !expanded);
  };

  const handleAbstractTransitionEnd = (event: TransitionEvent) => {
    // The panel has finished travelling between two abstracts: hand its height
    // back to the layout before anything else moves it.
    if (event.propertyName === 'height') settleAbstractResize.current?.();
    if (!expanded && event.propertyName === 'max-height' && abstractRef.current) {
      abstractRef.current.scrollTop = 0;
    }
  };

  const isReadActive = isRead;
  const activeRelatedPaper = selectedRelatedPaper || pendingRelatedPaper;
  const selectedRelatedState = activeRelatedPaper
    ? getInteractionState(activeRelatedPaper) || {}
    : {};
  const visiblePrimaryCategory = useMemo(
    () => [paper.primaryCategory, ...(paper.categories || [])]
      .find(category => category
        && !isTechnicalClassification(category)
        && !isOpaqueQueryTopicText(category)) || '',
    [paper.categories, paper.primaryCategory]
  );

  /**
   * The related card is a Base UI Dialog (ui/dialog.jsx). Closing — the back
   * button, Escape, all of them arrive as `onOpenChange(false)` — flips
   * `isClosingRelatedCard`, which takes `open` down and lets the primitive
   * play `relatedCardOut` (PaperCard.css); the paper is only let go of in
   * `finishRelatedCardClose`, from `onOpenChangeComplete(false)`, once that
   * has finished. No timer stands in for the animation any more, and with
   * reduced motion (no animation) the primitive reports the close at once.
   */
  const closeRelatedCard = useCallback(() => {
    if (relatedCardClosingRef.current) return;
    relatedCardClosingRef.current = true;
    relatedHydrationRequestRef.current += 1;
    setIsClosingRelatedCard(true);
  }, []);

  const finishRelatedCardClose = useCallback(() => {
    if (!relatedCardClosingRef.current) return;
    relatedCardClosingRef.current = false;
    relatedPreparationRef.current = null;
    setPendingRelatedPaper(null);
    setSelectedRelatedPaper(null);
    setIsClosingRelatedCard(false);
  }, []);

  useEffect(() => () => {
    relatedHydrationRequestRef.current += 1;
  }, []);

  const closeRelatedSheet = useCallback(() => {
    setShowRelated(false);
  }, []);

  const prepareRelatedPaper = useCallback((relatedPaper: Paper) => {
    const identity = getRelatedPaperIdentity(relatedPaper);
    const promise = resolveWithin(
      hydrateCitationGraphPaper(relatedPaper),
      RELATED_PAPER_HYDRATION_TIMEOUT_MS,
      relatedPaper,
    );
    relatedPreparationRef.current = { identity, promise };
    return promise;
  }, []);

  const selectRelatedPaper = useCallback((relatedPaper: Paper) => {
    trackEvent('select_content', {
      content_type: 'paper',
      surface: analyticsSurface,
      position,
    });
    relatedCardClosingRef.current = false;
    setIsClosingRelatedCard(false);
    setShowRelated(false);
    setPendingRelatedPaper(relatedPaper);
    setSelectedRelatedPaper(null);

    const identity = getRelatedPaperIdentity(relatedPaper);
    const preparation = relatedPreparationRef.current?.identity === identity
      ? relatedPreparationRef.current.promise
      : prepareRelatedPaper(relatedPaper);
    const requestId = relatedHydrationRequestRef.current + 1;
    relatedHydrationRequestRef.current = requestId;
    Promise.resolve(preparation).then(preparedPaper => {
      if (relatedHydrationRequestRef.current !== requestId || relatedCardClosingRef.current) return;
      setSelectedRelatedPaper((preparedPaper || relatedPaper) as Paper);
      setPendingRelatedPaper(null);
    });
  }, [analyticsSurface, position, prepareRelatedPaper, trackEvent]);

  const requireAuthentication = useCallback((action: string) => {
    onAuthRequired?.(action);
  }, [onAuthRequired]);
  // Describes «Leer en simple» to a guest: it needs an account. A
  // description, not part of the name, so the name stays what the button
  // shows (WCAG 2.5.3, see the button).
  const rewriteHintId = useId();
  const TitleTag = titleAs === 'h1' ? 'h1' : 'h2';

  // Marking a paper read used to fade the whole card out and, 1.5 s later,
  // pull it from the feed — the paper the reader had just finished with
  // vanished under their thumb. It stays now: the eye turns into a tick and
  // the label says so, and the feed drops it on the next load, not this one.
  // The button is a toggle: a second press takes the mark back, the tick
  // folds away and the eye springs back in.
  const handleMarkAsRead = () => {
    if (publicMode) {
      requireAuthentication('mark_read');
      return;
    }
    if (isRead) {
      onUnmarkAsRead(paper.id);
      return;
    }
    onMarkAsRead(paper);
  };

  // Get area info for the gradient background
  const getCategoryLabelText = () => {
    const cat = visiblePrimaryCategory;
    const area = Object.values(CATEGORIES).find(a => a.subcategories && (a.subcategories as Record<string, { label: string }>)[cat]);
    if (area) {
      return (area.subcategories as Record<string, { label: string }>)[cat].label || (area.subcategories as Record<string, { label: string }>)[cat].label;
    }
    // Not `cat` raw. For anything from OpenAlex that is a concept, not a
    // field — "QUBIT", "Toric code" — so the kicker announced a keyword where
    // it meant to announce a branch of science, and disagreed with the colour
    // beside it. The branch, resolved through the same chain as the ink.
    const branch = areaLabelForPaper(paper);
    if (branch) return branch;
    if (paper.journal) return paper.journal;
    return 'Research Paper';
  };

  const categoryLabel = getCategoryLabelText();
  const primaryTopic = useMemo(
    () => visiblePrimaryCategory ? resolvePaperTopic({
      categoryId: visiblePrimaryCategory,
      categoryIds: [visiblePrimaryCategory],
      display_name: categoryLabel,
      query: visiblePrimaryCategory,
      source: 'category',
    }) : null,
    [categoryLabel, visiblePrimaryCategory]
  );
  const paperTopicTags = useMemo(
    () => buildPaperTopicTags({
      categories: paper.categories,
      concepts: paper.concepts,
      primaryCategory: paper.primaryCategory,
    }, 4),
    [paper.categories, paper.concepts, paper.primaryCategory]
  );

  const openTopic = useCallback((event: MouseEvent, topic: NonNullable<ReturnType<typeof resolvePaperTopic>>) => {
    event.stopPropagation();
    const path = publicMode
      ? getPublicEntityPath(topic.type, topic.id)
      : topicExplorerPath(topic);
    trackEvent('select_content', {
      content_type: topic.type === 'concept' ? 'topic' : topic.type,
      surface: analyticsSurface,
      position,
    });
    if (path) navigate(path);
  }, [analyticsSurface, navigate, position, publicMode, trackEvent]);

  /* The watermark for the paper's branch of science.
   *
   * It used to accept only an exact arXiv subcategory and fall back to physics
   * for everything else — so a `cs.NE` paper, and every paper in Research,
   * whose categories are OpenAlex topic names rather than arXiv codes, wore an
   * atom. Resolved through the same chain as the accent ink now, so the mark
   * and the colour cannot disagree, and nothing is drawn at all when the branch
   * is genuinely unknown: a wrong field is worse than no field. */
  const WatermarkIcon = useMemo(
    () => AREA_WATERMARK_ICONS[areaKeyForPaper(paper) as keyof typeof AREA_WATERMARK_ICONS] || null,
    [paper],
  );

  // Only a tap on the card itself. The sheets, the related card and the
  // reader are portaled to the body, and React still bubbles their clicks
  // up this tree — the old overlays stopped propagation by hand; the DOM
  // check covers every surface at once. The connections panel in the slot is
  // a control in the card: two quick presses on the map are not a like.
  const handleDoubleTap = useCallback((event: MouseEvent) => {
    if (event?.target instanceof Node && !cardRef.current?.contains(event.target)) return;
    if (event?.target instanceof Element && event.target.closest('.related-sheet')) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isLiked) {
        if (publicMode) {
          requireAuthentication('like');
          lastTap.current = now;
          return;
        }
        onLike(paper);
        // One timer per card: a second double tap restarts it instead of
        // letting the first one cut the new heart short.
        clearTimeout(heartTimer.current!);
        setShowHeart(true);
        heartTimer.current = setTimeout(() => setShowHeart(false), 1200);
      }
    }
    lastTap.current = now;
  }, [isLiked, onLike, paper, publicMode, requireAuthentication]);

  const handleLike = () => {
    if (publicMode) {
      requireAuthentication('like');
      return;
    }
    // The button is its own feedback (the icon fills); the big heart is the
    // double tap's, not a second celebration on every like (2026-10-15).
    onLike(paper);
  };

  // The graph and the similar list are session-only in the Worker: a guest
  // used to get a sheet that could only say «No se pudieron cargar» (audit
  // 2026-09-23, issue 2).
  const hasRelated = Boolean(getSemanticScholarPaperId(paper));
  const openRelated = () => {
    if (publicMode) {
      requireAuthentication('related');
      return;
    }
    setShowRelated(true);
  };

  // The slot swap only grows the card downward: pinned on the press, before
  // the panel changes the column's height (see pinSheet).
  useEffect(() => {
    if (isCardIdle && hasRelated && !isPhone && !publicMode) RelatedPapersSheet.preload();
  }, [isCardIdle, hasRelated, isPhone, publicMode]);

  const toggleRelated = (next: boolean) => {
    if (!isPhone && !publicMode) {
      pinSheet();
      setSlotSwapped(true);
      slotFromHeight.current = slotRef.current?.offsetHeight ?? null;
    }
    if (next) openRelated();
    else setShowRelated(false);
  };

  const handleNotInterested = (e: MouseEvent) => {
    e.stopPropagation();
    if (publicMode) {
      if (onGuestNotInterested) {
        onGuestNotInterested(paper?.id);
        return;
      }
      requireAuthentication('not_interested');
      return;
    }
    onNotInterested(paper);
  };

  const handleSave = () => {
    if (publicMode) {
      requireAuthentication('save');
      return;
    }
    onSaveToList(paper);
  };

  // Derived before the handlers that close over it (no-use-before-define).
  const resolvedOpenCopy = resolvedAccess.paperId === paper.id ? resolvedAccess.copy : null;
  const currentInstitutionAccess = institution
    && institutionAccess.paperId === paper.id
    && institutionAccess.domain === institution.domain
    ? institutionAccess.access
    : null;
  // Derived, so an unlinked library, another paper or a card scrolled away
  // never keeps saying "Checking".
  const isCheckingLibrary = isCardIdle
    && !currentInstitutionAccess
    && checkingLibraryFor === `${paper.id}|${institution?.domain}`;
  // Judged by the record alone, like the chip (`accessTagForPaper`): a free
  // copy found elsewhere must not decide whether the library is asked, or the
  // button's label would depend on which lookup answered first.
  const isOpenByRecord = accessStatusForPaper(paper) === 'open';

  // Whether the reader's library has the published version. Asked only for a
  // paper whose own record is not open, and after the card settles, like the
  // open-copy lookup above.
  useEffect(() => {
    let active = true;
    if (!isCardIdle || !paper?.doi || !institution?.domain || isOpenByRecord) {
      return () => { active = false; };
    }
    const paperId = paper.id;
    const { domain } = institution;
    // Each label change records the button's width first, for the layout
    // effect below to travel from.
    const measure = (push: boolean) => {
      const width = readButtonRef.current?.offsetWidth;
      readButtonFrom.current = width ? { width, push } : null;
    };
    let checking = false;
    const slow = setTimeout(() => {
      checking = true;
      measure(true);
      setActionPush({ from: 'record', dir: 'forward' });
      setCheckingLibraryFor(`${paperId}|${domain}`);
    }, LIBRARY_CHECKING_DELAY_MS);
    findInstitutionAccess(paper.doi, institution).then(access => {
      clearTimeout(slow);
      if (!active) return;
      const entitled = access?.status === 'entitled';
      if (checking) {
        // "Checking" leaves either way: forward to the library, or back to
        // the record's label, where it came from.
        measure(true);
        setActionPush({ from: 'checking', dir: entitled ? 'forward' : 'back' });
      } else if (entitled) {
        measure(false);
      }
      setCheckingLibraryFor(null);
      if (access) setInstitutionAccess({ paperId, domain, access });
    });
    return () => {
      active = false;
      clearTimeout(slow);
      // A card that stops being looked at mid-check starts over when it is
      // looked at again, rather than coming back already saying "Checking".
      setCheckingLibraryFor(null);
    };
  }, [institution, isCardIdle, isOpenByRecord, paper?.doi, paper?.id]);

  const handleOpenPaper = async (event: MouseEvent) => {
    event.stopPropagation();
    // Pressed while the library is still being asked: its answer decides
    // where the paper opens, so it is waited for, briefly.
    let libraryAccess = currentInstitutionAccess;
    if (isCheckingLibrary) {
      setIsResolvingAccess(true);
      libraryAccess = await resolveWithin(findInstitutionAccess(paper.doi, institution), LIBRARY_PRESS_WAIT_MS, null);
      setIsResolvingAccess(false);
    }
    // The library's resolver lands on the publisher's version of record.
    const destination = libraryAccess?.status === 'entitled'
      ? 'publisher'
      : resolvedOpenCopy?.pdfUrl
      || paper.openAccessPdfUrl
      || isTrustedInlinePdfUrl(paper.pdfUrl)
      ? 'pdf'
      : paper.arxivId
        ? 'arxiv'
        : paper.landingPageUrl || resolvedOpenCopy?.landingPageUrl
          ? 'publisher'
          : paper.doi
            ? 'doi'
            : 'other';
    trackEvent('paper_open', { surface: analyticsSurface, destination, position });

    // Cada destino se intenta de verdad, y solo se para cuando uno abre. Antes
    // la cascada daba por bueno el primer candidato con URL: si el navegador la
    // rechazaba -- un `http://` de repositorio, lo más común en las copias que
    // este botón ofrece -- el clic terminaba ahí, en silencio.
    const openBestTarget = (openCopy: OpenCopy) => openFirstTarget(openTargetsForPaper(paper, openCopy, libraryAccess), {
      inline: (target) => {
        onOpenPdf({ ...paper, ...(openCopy || {}), pdfUrl: target.url, openAccess: true });
        return true;
      },
      external: (url) => openExternalUrl(url),
    });

    if (openBestTarget(resolvedOpenCopy)) return;

    // Nada abrió y el paper no traía copia resuelta: es el momento de preguntar
    // por una, con el botón en «Buscando acceso...».
    if (paper.doi && !resolvedOpenCopy) {
      setIsResolvingAccess(true);
      const openCopy = await findOpenAccessCopy(paper.doi);
      setIsResolvingAccess(false);
      if (openCopy) {
        setResolvedAccess({ paperId: paper.id, copy: openCopy });
        if (openBestTarget(openCopy)) return;
      }
    }

    // El enlace de rendirse: la ficha del editor, que al menos existe siempre.
    openExternalUrl(safeDoiUrl(paper.doi));
  };

  // What the status row is allowed to claim. `resolvedOpenCopy` is only ever
  // set by the open-access lookup, which only runs for a paper with no
  // readable copy of its own. The copy decides the word: the published version
  // free at the publisher is open access, anything else is a weaker "open
  // version" (`paperStatus.js`).
  const reviewTag = reviewTagForPaper(paper);
  const accessTag = accessTagForPaper(paper, { openCopy: resolvedOpenCopy });
  const researchResources = linkedResources.paperId === paper.id ? linkedResources.items : [];
  const readablePaper = useMemo(() => resolvedOpenCopy ? {
    ...paper,
    openAccess: true,
    openAccessPdfUrl: resolvedOpenCopy.pdfUrl || paper.openAccessPdfUrl,
  } : paper, [paper, resolvedOpenCopy]);
  const canRequestRewrite = canRewritePaper(readablePaper);
  // Never the library link: it only opens for readers at that institution.
  const bestAvailableUrl = safeExternalUrl(resolvedOpenCopy?.pdfUrl)
    || safeExternalUrl(resolvedOpenCopy?.landingPageUrl)
    || safeExternalUrl(paper.openAccessPdfUrl)
    || safeExternalUrl(paper.pdfUrl)
    || safeExternalUrl(paper.landingPageUrl)
    || safeDoiUrl(paper.doi);
  const shareUrl = getPublicPaperUrl(paper)
    || bestAvailableUrl
    || (paper.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}` : '');

  // Every way the link leaves the share panel (SharePanel): `clipboard`,
  // `instagram` (which copies) or a network's id, reported in the analytics
  // `method` vocabulary, which has no network names.
  const handleShared = (method: string) => {
    const reported = method === 'clipboard' || method === 'instagram' ? 'clipboard' : 'other';
    trackEvent('share', { method: reported, content_type: 'paper', surface: analyticsSurface });
  };
  // What the button says from the paper's own record.
  const recordActionLabel = resolvedOpenCopy
    ? ('Read open version')
    : paper.openAccessPdfUrl
      ? ('Read full text')
      : (!paper.pdfUrl && !paper.arxivId)
        ? ('Source')
        : ('Read article');
  // The library's short name when the button goes through it: an entitled
  // answer puts the library's version of record first among the open targets
  // (`paperOpenTargets.ts`), so the button says so instead of "Source", and
  // the chip above it keeps saying what the record says for everyone.
  const libraryLabel = currentInstitutionAccess?.status === 'entitled' ? institutionLabel(institution) : '';
  const restingActionLabel = libraryLabel
    ? `Via ${libraryLabel}`
    : isCheckingLibrary
      ? ('Checking')
      : recordActionLabel;
  const primaryActionLabel = isResolvingAccess
    ? ('Finding access...')
    : restingActionLabel;
  // What the phone shows, where the full label does not fit: its first word
  // ("Read", "Source"), or the library's name alone, since "Via" says nothing
  // by itself. Derived rather than written twice, so it cannot drift from the
  // full label, which is the accessible name and so always contains the word
  // on screen (WCAG 2.5.3). While access is being looked up the word is hidden
  // under the spinner (PaperCard.css), so the resting one keeps the button's
  // width: "Finding" would not fit the row at 360px.
  const primaryActionShortLabel = libraryLabel || restingActionLabel.split(' ')[0];
  const actionFace = libraryLabel ? 'library' : isCheckingLibrary ? 'checking' : 'record';
  const actionFaceClass = libraryLabel ? ' pc-action-swap' : isCheckingLibrary ? ' pc-action-checking' : '';
  /* A label change changes the button's width, and "Read in plain words"
     beside it jumped in one frame. The button travels from the width it had
     to the one it lands on; the sibling rides on the layout. With the push
     (record → "Checking" → library or back) it travels on the push's clock;
     a direct swap (a cached answer) on the fade's. `overflow: hidden` keeps
     the arriving word inside a box still narrower than it. Reduced motion
     keeps the jump and the fade. */
  useLayoutEffect(() => {
    const button = readButtonRef.current;
    const from = readButtonFrom.current;
    readButtonFrom.current = null;
    if (!button || !from || prefersReducedMotion) return;
    if (from.push) animateSize(button, 'width', from.width, 280, EASE_IN_OUT, { overflow: 'hidden' });
    else animateSize(button, 'width', from.width, 220, EASE_OUT, { overflow: 'hidden' });
  }, [actionFace, prefersReducedMotion]);
  /* El `aria-label` repite EL MISMO rótulo, no uno mejor. En móvil
   `.pc-action-label` es `display: none` (PaperCard.css), y eso no
   esconde el texto: lo saca del árbol de accesibilidad, así que el
   botón se quedaba sin nombre — quince por pantalla. Repetirlo
   literalmente es también lo que pide el criterio 2.5.3 en
   escritorio, donde el rótulo sí se lee: el nombre accesible tiene
   que CONTENER lo que se ve, o quien maneja la interfaz por voz no
   puede pulsarlo diciendo lo que lee. En móvil se ve la primera
   palabra (`--short`), que el nombre contiene por construcción: la
   acción principal era la única de la barra sin rótulo, y el mismo
   icono servía para leer aquí y para salir a la fuente. */
  // With no abstract to read, the way to the paper sits under the empty state
  // that says so, a size down, instead of in the bar below it.
  const readAction = (
    <Button
      ref={readButtonRef}
      className={`pc-action-read${isResolvingAccess ? ' is-resolving' : ''}`}
      size={abstractText ? 'default' : 'sm'}
      onClick={handleOpenPaper}
      disabled={isResolvingAccess}
      aria-label={primaryActionLabel}
      data-push={actionPush?.dir}
    >
      {isResolvingAccess
        ? <CircleNotch className="spinning" size={16} />
        : libraryLabel ? <GraduationCap className="pc-action-swap" size={16} /> : isCheckingLibrary ? null : <FileText size={16} />}
      {/* Keyed on the face so each word mounts fresh when it changes, and
          slides in with the push or, for a cached answer, fades in
          (`.pc-action-swap`), instead of the text teleporting under the
          reader's eyes. The record's own labels keep one key: their changes
          come before the card is looked at. */}
      <span key={actionFace} className={`pc-action-label${actionFaceClass}`}>{primaryActionLabel}</span>
      <span key={`${actionFace}-short`} className={`pc-action-label--short${actionFaceClass}`}>{primaryActionShortLabel}</span>
      {/* The face being pushed out, drawn again over the arriving one until
          its animation ends. Decorative: the name is the arriving label. */}
      {actionPush && (
        <span
          key={`${actionPush.from}-${actionPush.dir}`}
          className="pc-action-out"
          aria-hidden="true"
          onAnimationEnd={(event) => { if (event.target === event.currentTarget) setActionPush(null); }}
        >
          {actionPush.from === 'record' && <FileText size={16} />}
          <span className="pc-action-label">{actionPush.from === 'record' ? recordActionLabel : 'Checking'}</span>
          <span className="pc-action-label--short">{actionPush.from === 'record' ? recordActionLabel.split(' ')[0] : 'Checking'}</span>
        </span>
      )}
    </Button>
  );
  return (
    <div ref={cardRef} className={`pc ${isCardVisible ? 'pc--visible' : ''}`} onClick={handleDoubleTap}>
      {/* DEBUG PANEL */}
      {SHOW_RANKING_DEBUG && paper._debugScore && (
        <div className="pc-debug-panel">
          <div><strong>TOTAL SCORE: {paper._debugScore.total!.toFixed(2)}</strong></div>
          <div>Why: {paper._debugScore.explanation}</div>
          <div>Affinity: {paper._debugScore.affinity!.toFixed(2)}</div>
          <div>Preference Match: {paper._debugScore.preference!.toFixed(2)}</div>
          <div>Recency Boost: {paper._debugScore.recency!.toFixed(2)}</div>
          {paper._debugScore.semantic! > 0 && (
            <div style={{color: 'var(--brand)'}}>Semantic: {paper._debugScore.semantic!.toFixed(2)}</div>
          )}
          {paper._debugScore.citations! > 0 && (
            <div style={{color: 'var(--primary)'}}>Citation Boost: {paper._debugScore.citations!.toFixed(2)}</div>
          )}
          {(paper._debugScore.learnedAuthor ?? 0) !== 0 && (
            <div>Learned Authors: {paper._debugScore.learnedAuthor!.toFixed(2)}</div>
          )}
          {(paper._debugScore.sessionInterest ?? 0) !== 0 && (
            <div>Session: {paper._debugScore.sessionInterest!.toFixed(2)}</div>
          )}
          {paper._debugScore.graphBoost! > 0 && (
            <div style={{color: 'var(--warning)'}}>Graph Connection: {paper._debugScore.graphBoost!.toFixed(2)}</div>
          )}
          {paper._debugScore.personalBoost! > 0 && (
            <div style={{color: 'var(--warning)'}}>Personal Recommendation: {paper._debugScore.personalBoost!.toFixed(2)}</div>
          )}
          <div>Exploration: {paper._debugScore.isExploration ? 'YES' : 'NO'}</div>
        </div>
      )}

      {scatteredFigures.length > 0 && (
        <div className="pc-figures" aria-hidden="true">
          {scatteredFigures.map(({ item, style }) => (
            <figure
              key={item.url}
              className={`pc-figure${loadedFigures.has(item.url) && figuresLit ? ' is-loaded' : ''}${figuresResumed ? ' is-resumed' : ''}`}
              style={style}
            >
              <img
                src={item.url}
                alt=""
                loading="lazy"
                decoding="async"
                // `.pc-figure` (this img's parent) is already sized per slot
                // via clamp() -- roughly 1.28:1, not 4:3 -- and `.pc-figure
                // img` fills it at width/height: 100% with object-fit:
                // contain framing the source image's own ratio inside that
                // box. With both CSS dimensions explicit, these attributes
                // cannot reserve space or shift layout either way; a literal
                // 4:3/height:auto pair would instead fight object-fit against
                // a box it does not describe. They stay only as an honest
                // intrinsic-size hint (the four slots' average ratio) for
                // tooling that flags images with no width/height at all.
                width="256"
                height="200"
                // A cached image can finish before React attaches `onLoad`, and
                // then the event never comes and the clipping never appears. The
                // ref catches the ones that were already done on mount; `onLoad`
                // catches the rest.
                ref={(node) => { if (node?.complete && node.naturalWidth > 0) markFigureLoaded(item.url); }}
                onLoad={() => markFigureLoaded(item.url)}
              />
            </figure>
          ))}
        </div>
      )}

      <article ref={sheetRef} className="pc-sheet" data-connections={relatedInline || undefined} style={{ '--area-accent': areaAccentForPaper(paper) }}>
        {WatermarkIcon && (
          <span className="pc-watermark" aria-hidden="true">
            <WatermarkIcon size={220} weight="fill" />
          </span>
        )}

        <div className="pc-body">
        {showFollowReason && (() => {
          const reason = buildFollowReasonLabel(
            (paper._followedEntityMatches || []).filter(match => typeof match === 'object'),
          );
          if (!reason) return null;
          // A plain element: its entrance is the first step of the card's
          // own arrival (`pcArrive` in the stylesheet), so it lands with the
          // kicker and the title instead of on a fade of its own that ran
          // inside — and finished before — the sheet's.
          return (
            <div className="pc-follow-reason">
              <UserCheck size={13} aria-hidden="true" />
              <span>{reason}</span>
            </div>
          );
        })()}
        <div className="pc-meta">
          {primaryTopic ? (
            <button
              type="button"
              className="pc-category-pill pc-topic-link"
              onClick={(event) => openTopic(event, primaryTopic)}
              title={`${'Explore'} ${categoryLabel}`}
            >
              {categoryLabel}
            </button>
          ) : (
            <span className="pc-category-pill">{categoryLabel}</span>
          )}
          {hasFollowedAuthor && (
            <>
              <span className="pc-meta-dot">·</span>
              <span className="pc-followed-badge">
                <UserCheck size={12} /> {'Followed author'}
              </span>
            </>
          )}
          <span className="pc-meta-dot">·</span>
          <span className="pc-date">{paper.year}</span>

          {(paper.citationCountKnown || paper.citationCount! > 0) && (
            <>
              {/* El modificador es lo que le da a este punto el mismo fundido
                  que al chip: los dos montan juntos, y cuando el
                  enriquecimiento se pasa del techo montan tarde juntos. */}
              <span className="pc-meta-dot pc-meta-dot--citations">·</span>
              {paper.sources?.primary === 'scopus' && paper.scopusCitedByUrl ? (
                <a
                  className="pc-citations"
                  href={safeExternalUrl(paper.scopusCitedByUrl) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`${paper.citationCount} ${'citations on Scopus'}`}
                >
                  {paper.citationCount} {'Citations on Scopus'}
                </a>
              ) : (
                <span className="pc-citations">
                  {paper.citationCount} {'Citations'}
                </span>
              )}
            </>
          )}
        </div>

        {/* What the paper is filed under. Machine data, so it belongs with the
            meta line above the headline — not in the
            action row, where a paper with many concepts used to push the
            reading buttons past the sheet and out of sight. */}
        {paperTopicTags.length > 0 && (
          <div
            className="pc-topics"
            role="group"
            aria-label={'Paper topics'}
          >
            {paperTopicTags.map((tag) => {
              const topic = resolvePaperTopic(tag.value);
              if (!topic) return null;
              return (
                <button
                  key={tag.key}
                  type="button"
                  className={`pc-semantic-tag pc-topic-link ${tag.source === 'concept' && !topic.reliable ? 'pc-topic-link--external' : ''}`}
                  lang={tag.lang}
                  onClick={(event) => openTopic(event, topic)}
                  title={`${'Explore'} ${topic.label}`}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Their own line under the topic tags: what this paper is, whether it
            opens, and where the record of it lives. Each chip carries the
            sentence behind its word in `title`, because "Preprint" is not a
            word a reader outside academia arrives knowing. */}
        <div className="pc-chips">
          {reviewTag && (() => {
            const Glyph = STATUS_CHIP_ICONS[reviewTag.key as keyof typeof STATUS_CHIP_ICONS];
            return (
              <span className="pc-chip" data-tone={reviewTag.tone} title={reviewTag.hint}>
                <Glyph size={12} /> {reviewTag.label}
              </span>
            );
          })()}

          {/* The availability chip resolves late: a paper with no readable copy
              of its own goes to Unpaywall after the card settles, and the answer
              can turn Suscripción into Versión abierta a second in. Swapping the
              word outright reads as a glitch, so the slot cross-fades. */}
          <AnimatePresence mode="wait" initial={false}>
            {accessTag && (() => {
              const Glyph = STATUS_CHIP_ICONS[accessTag.key as keyof typeof STATUS_CHIP_ICONS];
              return (
                <motion.span
                  key={accessTag.key}
                  className="pc-chip"
                  data-tone={accessTag.tone}
                  title={accessTag.hint}
                  // Full transform strings, not the `scale` shorthand: this lands
                  // mid-scroll and has to stay on the compositor.
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.92)' }}
                  animate={{ opacity: 1, transform: 'scale(1)' }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.92)' }}
                  transition={{
                    duration: prefersReducedMotion ? 0.1 : 0.24,
                    ease: EASE_OUT_EXPO,
                  }}
                >
                  <Glyph size={12} /> {accessTag.label}
                </motion.span>
              );
            })()}
          </AnimatePresence>

          {paper.doi && (
            <a
              className="pc-chip pc-chip--link"
              href={safeDoiUrl(paper.doi)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={'Open the DOI record'}
            >
              <ArrowSquareOut size={12} /> DOI
            </a>
          )}
        </div>

        <AnimatePresence initial={false}>
          {project && (
            <motion.div
              key="project-badge"
              className="pc-project-badge-slot"
              // The badge arrives async, so at mount time the space it needs
              // does not exist yet and something below has to move: the
              // title, on a card that is being read. Reserving the space in
              // one layout pass made the title jolt down a full row in a
              // single frame. So did, very nearly, the 200ms expo-out that
              // replaced it: measured on the guest feed, that curve put
              // 10, 9.6 and 7.9px of the 37px opening into its first three
              // frames -- three quarters of the travel in 50ms -- with the
              // badge already at half opacity on the first frame, over a
              // title that had not yet moved. Nobody asked for this space,
              // so it does not open on a click's curve: the measured
              // `height: 0 -> auto` tween runs on `--ease-out-quad`, the
              // curve the app moves pages with, over the arrival's own
              // 320ms -- 3.6px per frame at most, 60% open at 120ms. It is
              // a layout property, knowingly, once per card, on this slot's
              // subtree. The pill itself waits those 120ms and then fades
              // in over 200ms via the inner `.pc-project-badge-motion`,
              // which animates only opacity and a full `transform` string
              // -- no `y`/`scale` shorthands -- so it composites off the
              // main thread and lands together with the space. No overflow
              // clip on this slot on purpose: the global `:focus-visible`
              // ring overhangs the pill by 4px and a hard clip would cut it.
              initial={prefersReducedMotion
                ? { opacity: 0 }
                : { height: 0 }}
              animate={prefersReducedMotion
                ? { opacity: 1 }
                : { height: 'auto' }}
              exit={prefersReducedMotion
                ? { opacity: 0 }
                : { height: 0, opacity: 0 }}
              transition={prefersReducedMotion
                ? { duration: 0.12 }
                : { duration: 0.32, ease: [0.25, 0.46, 0.45, 0.94] }}
            >
              <div className="pc-project-badge-slot-inner">
                <motion.div
                  className="pc-project-badge-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, transform: 'translateY(6px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px)' }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : { delay: 0.12, duration: 0.2, ease: EASE_OUT }}
                >
                  <button
                    type="button"
                    className="pc-project-badge"
                    disabled={!(project.id || project.code)}
                    onClick={(e) => {
                      e.stopPropagation();
                      const paperId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
                      const projectRouteId = project.id || project.code;
                      // The name rides along on the public route too: without
                      // it the project hero has nothing to paint optimistically
                      // and a logged-out reader waits through the whole
                      // skeleton. The funder is not needed here — the
                      // identifier is the OpenAIRE id, which names one project.
                      const path = publicMode
                        ? getPublicEntityPath('project', projectRouteId, { includeName: true, name: project.acronym })
                        : `/explorer/project/${encodeURIComponent(projectRouteId!)}?name=${encodeURIComponent(project.acronym!)}&funder=${encodeURIComponent(project.funder!)}&arxivId=${paperId}`;
                      trackEvent('select_content', {
                        content_type: 'project',
                        surface: analyticsSurface,
                        position,
                      });
                      if (path) navigate(path);
                    }}
                    title={(project.id || project.code)
                      ? ('Open research project')
                      : undefined}
                  >
                    <Briefcase size={12} />
                    <span>
                      {[project.funderLevel, project.funder].find(value => value && value !== 'Unknown Funder')
                        || ('Project')}: {project.acronym}
                    </span>
                  </button>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <TitleTag className="pc-title" lang="en">
          <ScientificText>{paper.title}</ScientificText>
        </TitleTag>

        <div 
          className="pc-authors pc-authors--mobile-clickable"
          onClick={(e) => {
            if (window.innerWidth <= 768) {
              e.stopPropagation();
              setShowAuthorsModal(true);
            }
          }}
        >
          {/* The authors as dots, their initials (past three, a last dot
              counts the rest): one button that unfolds every author under
              them. */}
          {(paper.authors || []).length > 0 && (
            <button
              type="button"
              className="pc-author-avatars pc-authors-more"
              aria-expanded={authorsExpanded}
              aria-controls={authorsListId}
              onClick={(e) => {
                e.stopPropagation();
                if (!authorsExpanded) pinSheet();
                setAuthorsExpanded((open) => !open);
              }}
              aria-label={paper.authors.length > 3
                ? `+${paper.authors.length - 3} authors, show all ${paper.authors.length} authors`
                : `Show the ${paper.authors.length === 1 ? 'author' : `${paper.authors.length} authors`}`}
            >
              {paper.authors.slice(0, 3).map((author, i) => (
                <span key={i} className="pc-author-avatar" style={{ '--i': i }} aria-hidden="true">
                  {((author as PaperAuthor).name || author as string).charAt(0).toUpperCase()}
                </span>
              ))}
              {paper.authors.length > 3 && (
                <span className="pc-author-avatar" style={{ '--i': 3 }} aria-hidden="true">
                  {`+${paper.authors.length - 3}`}
                </span>
              )}
            </button>
          )}
          {(paper.authors || []).length > 0 && (
            <div id={authorsListId} className="pc-authors-list" data-open={authorsExpanded || undefined} inert={!authorsExpanded}>
              <ul>
                {paper.authors.map((author, idx) => {
                  const authorName = (author as PaperAuthor).name || author as string;
                  const path = authorExplorerPath(author, paper, { publicMode });
                  const inner = (
                    <>
                      <span className="pc-author-avatar" style={{ '--i': 0 }} aria-hidden="true">
                        {authorName.charAt(0).toUpperCase()}
                      </span>
                      <ClippedName name={authorName} />
                    </>
                  );
                  return (
                    <li key={idx} style={{ '--i': idx }}>
                      {path ? (
                        <Link
                          to={path}
                          className="pc-authors-list-item pc-author-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            trackEvent('select_content', {
                              content_type: 'author',
                              surface: analyticsSurface,
                              position,
                            });
                          }}
                        >
                          {inner}
                        </Link>
                      ) : (
                        <span className="pc-authors-list-item">{inner}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div ref={slotRef} className="pc-slot">
        <div ref={slotTrackRef} className="pc-slot-track">
        <AnimatePresence mode="popLayout" initial={false} custom={relatedInline ? 1 : -1}>
        {relatedInline ? (
          <motion.div
            key="connections"
            className="pc-slot-face"
            variants={slotSlide}
            custom={1}
            initial="enter"
            animate="center"
            exit="exit"
          >
            <Suspense fallback={null}>
              <RelatedPapersSheet
                inline
                paper={paper}
                onClose={closeRelatedSheet}
                onPreparePaper={prepareRelatedPaper}
                onSelectPaper={selectRelatedPaper}
              />
            </Suspense>
          </motion.div>
        ) : (
        <motion.div
          key="abstract"
          className="pc-slot-face"
          variants={slotSlide}
          custom={-1}
          initial={false}
          animate="center"
          exit="exit"
        >
        <div
          ref={abstractRef}
          id={abstractId}
          className={`pc-abstract ${expanded ? 'pc-abstract--open' : ''} ${abstractClipped === false ? 'pc-abstract--whole' : ''} ${slotSwapped ? 'pc-abstract--swapped' : ''}`}
          onClick={openAbstract}
          onTransitionEnd={handleAbstractTransitionEnd}
        >
          {/* The words are replaced, not swapped. A stored copy of a paper
              carries no abstract, so this panel goes from "Abstract
              unavailable." to a full column of text the moment the providers
              answer, and doing that in one frame reads as a glitch — the same
              reason the access chip above cross-fades.

              `mode="wait"` rather than two paragraphs at once: superimposing
              two different texts at half opacity is not a cross-fade, it is a
              smudge. The old text leaves, the new one arrives as the panel
              makes room for it — the ref below is what starts that. */}
          <AnimatePresence mode="wait" initial={false}>
            {abstractText ? (
              <motion.p
                key={abstractKey}
                ref={attachAbstractBody}
                lang="en"
                {...abstractSwap}
              >
                <ScientificText>{abstractText}</ScientificText>
              </motion.p>
            ) : (
              // No abstract in the record: the shared empty state, centred in
              // the abstract's place like every other one, not set as the first
              // line of an article (drop cap and all).
              <motion.div
                key={abstractKey}
                ref={attachAbstractBody}
                className="pc-abstract-empty"
                {...abstractSwap}
              >
                <EmptyState
                  as="p"
                  art={<Petri pose="blankPage" className="pc-abstract-empty-petri" />}
                  title={'No abstract'}
                  actions={readAction}
                >
                  {"This paper's record has no abstract."}
                </EmptyState>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Its box is on the card from the first frame; the verdict only
            decides whether the label is on. Shown when the panel is hiding
            words, and kept on once opened, since an open panel clips nothing
            and would otherwise take away the control that closes it. It used
            to be mounted by that verdict, which is a measurement and cannot
            be taken before the panel has a height: on a phone, where the
            column is bottom-anchored, the button joining the layout two
            frames in pushed the abstract, the authors and the title 25 px up
            in one frame, in the middle of their arrival. */}
        {abstractText && (
        <button
          type="button"
          className={`pc-abstract-toggle${abstractClipped === true || expanded ? '' : ' pc-abstract-toggle--reserved'}`}
          aria-expanded={readsInSheet ? undefined : expanded}
          aria-haspopup={readsInSheet ? 'dialog' : undefined}
          aria-controls={readsInSheet ? undefined : abstractId}
          onClick={openAbstract}
        >
          {expanded
            ? ('Show less')
            : ('Read full abstract')}
        </button>
        )}
        </motion.div>
        )}
        </AnimatePresence>
        </div>
        </div>

        <AnimatePresence initial={false}>
          {researchResources.length > 0 && (
            <motion.div
              key={`linked-resources-${paperViewKey}`}
              className="pc-linked-resources-slot"
              // This used to be the same choreography as
              // `.pc-project-badge-slot` above; it no longer is. That badge
              // moved to 200ms on the compositor (task 12) and this block
              // still runs the older shape they once shared: a measured
              // `height: 0 -> auto` tween at 0.45s, and inside it the whole
              // label-and-chips block on `y`/`scale` after a 300ms delay --
              // main-thread motion inside the feed, knowingly left as-is
              // here (a follow-up task, not this one, owns bringing it to
              // the badge's 200ms shape). Reserving the height in one layout
              // pass made everything below jolt down in a single frame, and
              // that snap -- not the easing -- read as abrupt; the measured
              // tween eases the space open instead, and the block only fades
              // in once the space has mostly opened. No overflow clip here
              // either -- the resource chips are links whose
              // `:focus-visible` ring overhangs by 4px -- so it is the fade
              // delay that keeps content from ghosting over what sits below
              // while the space opens.
              initial={prefersReducedMotion
                ? { opacity: 0 }
                : { height: 0 }}
              animate={prefersReducedMotion
                ? { opacity: 1 }
                : { height: 'auto' }}
              exit={prefersReducedMotion
                ? { opacity: 0 }
                : { height: 0, opacity: 0 }}
              transition={prefersReducedMotion
                ? { duration: 0.12 }
                : { duration: 0.45, ease: [0.25, 0.1, 0.25, 1] }}
            >
              <div className="pc-linked-resources-slot-inner">
                <motion.div
                  className="pc-linked-resources-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, transform: 'translateY(10px) scale(0.98)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px) scale(1)' }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : {
                      opacity: { delay: 0.3, duration: 0.5, ease: 'easeOut' },
                      default: { delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] },
                    }}
                >
                  <div className="pc-linked-resources" aria-label={'Associated research resources'}>
                    <span className="pc-linked-resources-label"><Database size={14} /> {'Resources'}</span>
                    <div className="pc-linked-resources-list">
                      {researchResources.map((resource, index) => {
                        const config = RESOURCE_KIND_CONFIG[resource.kind as keyof typeof RESOURCE_KIND_CONFIG] || RESOURCE_KIND_CONFIG.material;
                        const ResourceIcon = config.Icon;
                        const resourceLabel = config.label[language];
                        const resourceKey = resource.id || `${resource.kind}:${resource.url || resource.title}`;
                        return (
                          <motion.a
                            key={resourceKey}
                            className={`pc-linked-resource pc-linked-resource--${resource.kind}`}
                            href={safeExternalUrl(resource.url) || undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            title={resource.title}
                            aria-label={`${resourceLabel}: ${resource.title}`}
                            initial={prefersReducedMotion ? false : { opacity: 0, transform: 'translateY(3px)' }}
                            animate={{ opacity: 1, transform: 'translateY(0px)' }}
                            transition={prefersReducedMotion
                              ? { duration: 0.12 }
                              // Base delay sits just after the block starts
                              // fading in (0.3s) -- earlier and the chips
                              // would animate under a still-transparent
                              // parent, wasting the cascade.
                              : { duration: 0.3, delay: 0.42 + Math.min(index, 4) * 0.05, ease: EASE_OUT_EXPO }}
                          >
                            <ResourceIcon size={13} />
                            <span>{resourceLabel}</span>
                            <ArrowSquareOut size={11} />
                          </motion.a>
                        );
                      })}
                    </div>
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Two reading actions first, then the utilities behind a rule: what to
            read is the decision, sharing and related work are afterthoughts. */}
        <div className="pc-action-bar">
          <div className="pc-action-primary">
            {abstractText && readAction}

            {canRequestRewrite && (
              <Button
                variant="brand"
                aria-describedby={publicMode ? rewriteHintId : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (publicMode) {
                    requireAuthentication('paper_rewrite');
                    return;
                  }
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setReaderOrigin({
                    left: bounds.left,
                    top: bounds.top,
                    width: bounds.width,
                    height: bounds.height,
                  });
                  setShowReader(true);
                }}
              >
                {/* Sin `aria-label`. Este botón dibuja DOS rótulos y enseña uno
                    u otro según el ancho, así que un `aria-label` fijo no puede
                    contener a los dos: el que había («Leer este paper en
                    simple») no contenía a ninguno, y fallaba 2.5.3 tanto a 1440
                    como a 390. Sin él, el nombre lo pone el rótulo que de
                    verdad está puesto — «Leer en simple» ancho, «Simple»
                    estrecho — y no puede desviarse de lo que se lee. */}
                <Sparkle size={16} />
                <span className="pc-action-label">{'Read in plain words'}</span>
                <span className="pc-action-label--short">{'Simple'}</span>
                {publicMode && <Lock size={13} className="pc-action-lock" aria-hidden="true" />}
              </Button>
            )}
            {canRequestRewrite && publicMode && (
              <span id={rewriteHintId} className="visually-hidden">
                {'Needs a free account'}
              </span>
            )}
          </div>

        </div>
        </div>
      </article>

      {/* Side actions (TikTok style). Like, save and read are on/off states,
          so they are ui Toggles: Base UI writes `aria-pressed` / `data-pressed`
          from `pressed` and reports the flip through `onPressedChange`. The
          click is swallowed on the way (`swallowClick`) so it never reaches
          the card underneath, as it never did. The `--liked` / `--saved` /
          `--read` classes stay: each names its own colour, and the stylesheet
          and its tests key the pop and the eye-to-tick morph on them. */}
      <div className="pc-side-actions">
        <Toggle
          className={`pc-side-btn pc-side-btn--like ${isLiked ? 'pc-side-btn--liked' : ''}`}
          pressed={isLiked}
          onPressedChange={handleLike}
          onClick={swallowClick}
          title={'Like'}
        >
          <span className="pc-side-icon">
            <Heart size={20} weight={isLiked ? 'fill' : 'regular'} aria-hidden="true" />
          </span>
          <span className="pc-side-label">{'Like'}</span>
        </Toggle>

        <Toggle
          className={`pc-side-btn pc-side-btn--bookmark ${isSaved ? 'pc-side-btn--saved' : ''}`}
          pressed={isSaved}
          onPressedChange={handleSave}
          onClick={swallowClick}
          title={'Save'}
        >
          <span className="pc-side-icon">
            <BookmarkSimple size={20} weight={isSaved ? 'fill' : 'regular'} aria-hidden="true" />
          </span>
          <span className="pc-side-label">{'Save'}</span>
        </Toggle>

        {/* The paper's connections: on a wider screen the map takes the
            abstract's place until the tile is pressed again; on a phone it
            opens as a sheet. */}
        {hasRelated && (
          <Toggle
            className="pc-side-btn pc-side-btn--connections"
            pressed={showRelated}
            onPressedChange={toggleRelated}
            onClick={swallowClick}
            title={'Connections'}
          >
            <span className="pc-side-icon">
              <Graph size={20} weight={showRelated ? 'fill' : 'regular'} aria-hidden="true" />
            </span>
            <span className="pc-side-label">{'Connections'}</span>
          </Toggle>
        )}

        {shareUrl && (
          <SharePanel
            title={paper.title}
            url={shareUrl}
            onShared={handleShared}
            trigger={(
              <button
                type="button"
                className="pc-side-btn pc-side-btn--share"
                onClick={(event) => event.stopPropagation()}
                aria-label="Share"
                title="Share"
              >
                <span className="pc-side-icon">
                  <ShareNetwork size={20} aria-hidden="true" />
                </span>
              </button>
            )}
          />
        )}

        {/* The card's secondary actions, behind one more tile: the rail leads
            with like, save, connections and share, and the rest opens the way
            share does — a menu off the tile, or a drawer on a phone. */}
        <MoreActions
          items={[
            {
              id: 'read',
              label: isReadActive ? 'Mark as unread' : 'Mark as read',
              Icon: isReadActive ? CheckCircle : Eye,
              onSelect: handleMarkAsRead,
            },
            { id: 'skip', label: 'Skip', Icon: Prohibit, onSelect: handleNotInterested },
            { id: 'bibtex', label: 'Export BibTeX', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'bibtex', 'papertok-paper') },
            { id: 'ris', label: 'Export RIS', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'ris', 'papertok-paper') },
          ]}
          trigger={(
            <button
              type="button"
              className="pc-side-btn pc-side-btn--more"
              onClick={swallowClick}
              aria-label="More actions"
              title="More actions"
            >
              <span className="pc-side-icon">
                <DotsThree size={20} weight="bold" aria-hidden="true" />
              </span>
            </button>
          )}
        />
      </div>

      {/* Double-tap heart */}
      {showHeart && (
        <div className="pc-heart-burst">
          <Heart size={88} weight="fill" aria-hidden="true" />
          <div className="pc-heart-ring" />
        </div>
      )}

      {/* Scroll hint on first card */}
      {!hideScrollHint && (
        <div className="pc-scroll-hint">
          <span className="pc-scroll-hint-label">{'Scroll'}</span>
          <span className="pc-scroll-hint-arrow">
            <CaretDown size={16} weight="bold" aria-hidden="true" />
          </span>
        </div>
      )}

      {/* The authors sheet is a Base UI Drawer (ui/drawer.jsx): a bottom
          sheet a thumb can also swipe away, portaled to `document.body` by
          the primitive. Not in the card on purpose: a fixed box inside an
          ancestor with a transform is fixed to that ancestor, and the page
          wrapper takes one the frame a navigation starts (PageTransition
          slides and fades it), so a sheet still on screen while an author
          opened from it — the phone's path to every author — snapped to the
          page's box and slid off with it. The related sheet and the reader
          live outside the routed tree for the same reason. */}
      <Drawer
        open={showAuthorsModal}
        onOpenChange={(nextOpen) => { if (!nextOpen) setShowAuthorsModal(false); }}
        onOpenChangeComplete={(nextOpen) => { if (!nextOpen) setAuthorsSheetLeaving(false); }}
      >
        <DrawerContent
          className={`pc-authors-modal-sheet ${authorsSheetLeaving ? 'is-leaving' : ''}`}
          overlayClassName="pc-authors-modal-overlay"
          aria-modal="true"
        >
          <DrawerHandle />
          <div className="pc-authors-modal-header">
            <DrawerTitle render={<h3 id="pc-authors-dialog-title" />}>{'Authors'}</DrawerTitle>
            <DrawerClose render={<Button variant="ghost" size="icon-sm" aria-label={'Close authors'} />}>
              <X size={16} aria-hidden="true" />
            </DrawerClose>
          </div>
          <div className="pc-authors-modal-list">
            {(paper.authors || []).map((author, idx) => (
              <button
                key={idx}
                type="button"
                className="pc-authors-modal-item"
                onClick={() => {
                  const path = authorExplorerPath(author, paper, { publicMode });
                  // With somewhere to go the sheet leaves with the page, in
                  // its leaving pose; without, it is dismissed as if by the
                  // scrim.
                  if (path) setAuthorsSheetLeaving(true);
                  setShowAuthorsModal(false);
                  trackEvent('select_content', {
                    content_type: 'author',
                    surface: analyticsSurface,
                    position,
                  });
                  if (path) navigate(path);
                }}
              >
                <div className="pc-author-avatar-large" style={{ '--i': idx }} aria-hidden="true">
                  {((author as PaperAuthor).name || author as string).charAt(0).toUpperCase()}
                </div>
                <span>{(author as PaperAuthor).name || author as string}</span>
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
      {/* A Base UI Drawer too, and it portals itself to the body; it is
          mounted here for as long as it is open and unmounted on `onClose`,
          which the sheet only calls once its exit has played. */}
      {showAbstractSheet && (
        <AbstractSheet paper={paper} onClose={closeAbstractSheet} />
      )}

      {showRelated && !relatedInline && (
        <Suspense fallback={null}>
          <RelatedPapersSheet
            key={`papertok-related-sheet:${getRelatedPaperIdentity(paper) || 'current'}`}
            paper={paper}
            onClose={closeRelatedSheet}
            onPreparePaper={prepareRelatedPaper}
            onSelectPaper={selectRelatedPaper}
          />
        </Suspense>
      )}
      {showReader && createPortal(
        // The reader opens over a card that already painted, so there is no
        // layout to hold a place for — fallback={null} is a deliberate no-op
        // while the chunk downloads (a first open only; the browser caches it).
        <Suspense fallback={null}>
          <PaperReader
            paper={readablePaper}
            originRect={readerOrigin}
            closeRef={readerCloseRef}
            onClose={() => setShowReader(false)}
          />
        </Suspense>,
        document.body,
        'papertok-paper-reader',
      )}
      {/* A related paper opens as a full-screen Base UI Dialog over this
          card. The primitive owns the focus trap, Escape and the restore to
          the row that opened it; `open` goes down before the paper is let go
          of, so `relatedCardOut` gets to play (see closeRelatedCard). */}
      <Dialog
        open={Boolean(activeRelatedPaper) && !isClosingRelatedCard}
        onOpenChange={(nextOpen) => { if (!nextOpen) closeRelatedCard(); }}
        onOpenChangeComplete={(nextOpen) => { if (!nextOpen) finishRelatedCardClose(); }}
      >
        <DialogContent
          className="related-card-overlay inset-0 max-w-none translate-x-0 translate-y-0 rounded-none"
          overlayClassName="related-card-scrim"
          showClose={false}
          closeLabel={'Back to previous paper'}
          aria-label={'Related paper'}
        >
          <DialogClose
            className="related-card-back"
            aria-label={'Back to previous paper'}
            title={'Back'}
          >
            <ArrowLeft size={22} />
          </DialogClose>
          {selectedRelatedPaper ? (
            <div className="related-card-content is-ready">
              <PaperCard
                paper={selectedRelatedPaper}
                isLiked={Boolean(selectedRelatedState.isLiked)}
                isSaved={Boolean(selectedRelatedState.isSaved)}
                isRead={Boolean(selectedRelatedState.isRead)}
                onLike={onLike}
                onNotInterested={onNotInterested}
                onMarkAsRead={onMarkAsRead}
                onUnmarkAsRead={onUnmarkAsRead}
                trackViewTime={trackViewTime}
                trackSkip={trackSkip}
                onOpenPdf={onOpenPdf}
                onSaveToList={onSaveToList}
                getInteractionState={getInteractionState}
                hideScrollHint
                publicMode={publicMode}
                onAuthRequired={onAuthRequired}
                analyticsSurface={analyticsSurface}
                position={position}
              />
            </div>
          ) : activeRelatedPaper ? (
            <RelatedPaperCardSkeleton label={'Loading paper details'} />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
});

export default PaperCard;
