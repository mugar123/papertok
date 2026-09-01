import { Fragment, useState, useRef, useCallback, useMemo, useEffect, useId, memo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORIES } from '../../data/categories';
import {
  ArrowLeft, Share2, FileText, Check, Loader2, Dna, BarChart2, TrendingUp, Zap,
  CircleDollarSign, Brain, Cpu, Database, Orbit, FlaskConical, Network, Sigma,
  BadgeCheck, Eye, CheckCircle2, UserCheck, Briefcase, ExternalLink,
  Cog, Building, HeartPulse, Code2, PackageOpen, History, Sparkles, MessageCircle,
  Lock, Unlock,
} from 'lucide-react';
import { canonicalPaperIdentity } from '../../utils/paperCanonicalKey.js';
import ScientificText from '../ScientificText';
import { Button } from '../ui/button.jsx';
import { useFollowing } from '../../context/FollowingContext';
import { useLanguage } from '../../context/LanguageContext';
import { getProjectForPaper } from '../../services/openAireService';
import { useNavigate, Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import './PaperCard.css';
const RelatedPapersSheet = lazy(() => import('./RelatedPapersSheet'));
import { findOpenAccessCopy } from '../../services/unpaywallService';
import { getRelatedResearchResources } from '../../services/dataCiteService';
import { getHuggingFaceResearchResources } from '../../services/huggingFaceService';
import { isOpaqueQueryTopicText, resolvePaperTopic, topicExplorerPath } from '../../utils/topicNavigation';
import { canRewritePaper } from '../../services/paperRewriteService.js';
import { getPaperFigures } from '../../services/paperFigureService.js';
import { CARD_DURATION_MS, tweenScrollTop } from '../../utils/scrollTween.js';
import { areaAccentForPaper, areaKeyForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import { accessTagForPaper, reviewTagForPaper } from '../../utils/paperStatus.js';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { buildPaperTopicTags } from '../../utils/paperTopicTags.js';

/**
 * How still the abstract panel has to be before its clipping is believed: the
 * quiet demanded after the LAST size change, not a wait for the whole travel.
 * A 420ms collapse keeps resetting this, so the reading lands once — after it.
 */
const ABSTRACT_SETTLE_MS = 180;

/**
 * A glyph per status, keyed the same way the tags are.
 *
 * The icons stay here rather than in `paperStatus.js` so that module holds no
 * React and can be read straight by `node --test`.
 */
const STATUS_CHIP_ICONS = {
  preprint: FileText,
  verified: BadgeCheck,
  open: Unlock,
  openCopy: Unlock,
  subscription: Lock,
};
import { buildFollowReasonLabel } from '../../utils/followingFeed.js';
import { isTechnicalClassification } from '../../utils/scientificClassification.js';
import {
  getRelatedPaperIdentity,
  getRelatedTransitionAction,
  getRelatedTransitionDuration,
  getRelatedTransitionFallbackDelay,
  RELATED_CARD_CLOSE_MS,
} from '../../utils/relatedPaperTransition.js';
import { hydrateCitationGraphPaper } from '../../services/citationGraphService.js';
import { resolveWithin } from '../../utils/asyncTiming.js';
import {
  isTrustedInlinePdfUrl,
  openExternalUrl,
  safeDoiUrl,
  safeExternalUrl,
} from '../../utils/externalUrl.js';
import { openFirstTarget, openTargetsForPaper } from '../../utils/paperOpenTargets.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { getPublicEntityPath, getPublicPaperUrl } from '../../utils/publicNavigation.js';

// The reader drags in the annotations layer, LaTeX export and their CSS
// (PaperReader.css, Annotations.css, Export.css — ~53 KB raw source, ~28 KB
// once minified) — none of it belongs in the boot graph when most sessions
// never tap "read". It opens over a card that has already painted, so there
// is nothing to placehold while the chunk loads; `fallback={null}` is
// correct here, unlike the route-level `RouteFallback` used for `App.jsx`'s
// lazy routes.
const PaperReader = lazy(() => import('../Reader/PaperReader.jsx'));

// One quiet watermark per research area, drawn as a hairline in the corner of
// the sheet. It replaces the old animated icon constellation: the same visual
// cue about the field, without the haze competing with the type.
const AREA_WATERMARK_ICONS = {
  physics: Orbit,
  cs: Cpu,
  math: Sigma,
  stat: BarChart2,
  econ: TrendingUp,
  'q-fin': CircleDollarSign,
  eess: Zap,
  mech: Cog,
  civil: Building,
  chemeng: FlaskConical,
  med: HeartPulse,
  bio: Dna,
};

const RESOURCE_KIND_CONFIG = {
  dataset: { label: { es: 'Datos', en: 'Data' }, Icon: Database },
  model: { label: { es: 'Modelo IA', en: 'AI model' }, Icon: Brain },
  software: { label: { es: 'Código', en: 'Code' }, Icon: Code2 },
  material: { label: { es: 'Material', en: 'Material' }, Icon: PackageOpen },
  version: { label: { es: 'Versión', en: 'Version' }, Icon: History },
};
const ENRICHMENT_SETTLE_DELAY_MS = 240;
const SECONDARY_NETWORK_DELAY_MS = 900;
const RELATED_PAPER_HYDRATION_TIMEOUT_MS = 8_000;

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
const FIGURE_ENTRANCE_BASE_MS = 620;
const FIGURE_ENTRANCE_STEP_MS = 140;

/** FNV-1a, the same one `buildHighlightId` uses: short, stable, and enough to
 *  tell four slots of one paper apart. */
function figureHash(fingerprint) {
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
function figureScatterStyle(identity, index, total) {
  // The slot goes in front of the identity, not behind it. FNV-1a only
  // avalanches forwards: with the index last, four figures of one paper came
  // out with the same middle bytes and so with the same shift — measured, not
  // assumed. Fed in first, it stirs the whole hash.
  const angles = figureHash(`${index}#${identity}`);
  const motion = figureHash(`${index}#drift#${identity}`);
  const unit = (hash, shift) => ((hash >>> shift) & 0xff) / 255;
  const signed = (hash, shift) => unit(hash, shift) * 2 - 1;
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
    // The stagger is duration, not delay. A delayed entrance would need
    // `animation-fill-mode: backwards` to hold its first frame, and inside the
    // feed's `content-visibility: auto` subtree a held first frame is how a
    // figure ends up invisible for good.
    '--fig-in-duration': `${FIGURE_ENTRANCE_BASE_MS + index * FIGURE_ENTRANCE_STEP_MS}ms`,
  };
}

function mergeResearchResources(...groups) {
  const seen = new Set();
  return groups.flat().filter(Boolean).filter(resource => {
    const key = `${resource.kind || ''}:${resource.url || resource.id || ''}`.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function RelatedPaperCardSkeleton({ label }) {
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

const PaperCard = memo(function PaperCard({ 
  paper, 
  isLiked = false, 
  isSaved = false, 
  isRead = false, 
  onLike = () => {},
  onNotInterested = () => {},
  onMarkAsRead = () => {},
  trackViewTime = () => {},
  trackSkip = () => {},
  onOpenPdf = () => {},
  onSaveToList = () => {},
  // The door to the paper's comment thread. A callback and nothing more:
  // the sheet, its services and every Firestore read live with the host
  // (App.jsx, like the PDF viewer and the save modal), so nothing social
  // enters the feed's module graph and a feed load still costs one read.
  onOpenComments = null,
  getInteractionState = () => ({}),
  hideScrollHint = false,
  showFollowReason = false,
  publicMode = false,
  onAuthRequired,
  analyticsSurface = 'feed',
  position,
}) {
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
  const [abstractClipped, setAbstractClipped] = useState(null);
  // Read by the measurement below, which must not re-run when the panel opens:
  // a reading taken while it travels between its two heights is of the height
  // the animation is passing through, not the one it rests at.
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [showHeart, setShowHeart] = useState(false);
  const [copied, setCopied] = useState(false);
  // Only papers with a canonical identity can anchor a thread; for the rest
  // the button would open a sheet with nowhere to converge, so it does not
  // render. Pure string work — no reads.
  const canOpenComments = useMemo(
    () => Boolean(onOpenComments && canonicalPaperIdentity(paper)),
    [onOpenComments, paper],
  );
  const [isMarkingRead, setIsMarkingRead] = useState(false);
  const [showAuthorsModal, setShowAuthorsModal] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
  const [showReader, setShowReader] = useState(false);
  /* Where the reader should grow from. The rewrite button's rectangle at the
     moment it was pressed, so the full-screen reader can open out of it and
     collapse back into it rather than appearing from nowhere. */
  const [readerOrigin, setReaderOrigin] = useState(null);
  const [pendingRelatedPaper, setPendingRelatedPaper] = useState(null);
  const [selectedRelatedPaper, setSelectedRelatedPaper] = useState(null);
  const [isClosingRelatedCard, setIsClosingRelatedCard] = useState(false);
  const [isResolvingAccess, setIsResolvingAccess] = useState(false);
  const [resolvedAccess, setResolvedAccess] = useState({ paperId: null, copy: null });
  const [linkedResources, setLinkedResources] = useState({ paperId: null, items: [] });
  const [isCardVisible, setIsCardVisible] = useState(false);
  const [isCardSettled, setIsCardSettled] = useState(false);
  const [isCardIdle, setIsCardIdle] = useState(false);
  const [figures, setFigures] = useState([]);
  const { followedByType, isFollowing } = useFollowing();
  const { language, isEnglish } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const navigate = useNavigate();
  
  const hasFollowedAuthor = useMemo(() => {
    if (!paper?.authors?.length || !followedByType.author?.length) return false;
    return paper.authors.some(author => isFollowing({
      type: 'author',
      id: author?.id || author?.name || author,
      name: author?.name || author,
    }));
  }, [followedByType.author, isFollowing, paper]);

  const lastTap = useRef(0);
  const abstractRef = useRef(null);
  // Cancels the in-flight return to the first line, if there is one.
  const stopAbstractScroll = useRef(null);

  // A card swiped away mid-collapse would otherwise leave its frame loop
  // running against a node nobody can see any more.
  useEffect(() => () => stopAbstractScroll.current?.(), []);
  const cardRef = useRef(null);
  const viewStartTime = useRef(null);
  const totalViewTime = useRef(0);
  const relatedCardClosingRef = useRef(false);
  const relatedCardTransitionTimerRef = useRef(null);
  const relatedPreparationRef = useRef(null);
  const relatedHydrationRequestRef = useRef(0);
  const analyticsViewedPaperRef = useRef(null);
  const authorsDialogRef = useDialogFocus(showAuthorsModal, () => setShowAuthorsModal(false));
  const paperViewKey = paper?.id || paper?.doi || paper?.arxivId || 'paper';

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
    if (!isCardSettled) return () => { active = false; };
    getPaperFigures(paper).then(found => {
      // Four is what the margins hold either side of the sheet.
      if (active && found.length > 0) setFigures(found.slice(0, 4));
    });
    return () => { active = false; };
  }, [isCardSettled, paper]);

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
  const [loadedFigures, setLoadedFigures] = useState(() => new Set());

  // A new paper means new URLs; carrying the old set over would flash the next
  // paper's frames in before their images.
  useEffect(() => { setLoadedFigures(new Set()); }, [paperViewKey]);

  const markFigureLoaded = useCallback((url) => {
    setLoadedFigures(current => (current.has(url) ? current : new Set(current).add(url)));
  }, []);

  const [project, setProject] = useState(null);
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

  const toggleExpanded = (e, newState) => {
    e.stopPropagation();
    setExpanded(newState);

    // Whichever way this goes, the previous run stops first. Tapping twice
    // quickly used to leave a scroll still travelling into a panel that had
    // already reopened, so the text crawled while the reader was trying to
    // read it.
    stopAbstractScroll.current?.();

    // Closing puts the reader back at the first line, on the same clock as the
    // panel's height: `scrollTo({ behavior: 'smooth' })` animates on a duration
    // and a curve the browser chooses, so the text and the panel finished at
    // different moments and the motion read as two things, one dragging behind
    // the other. Same easing, same 420ms, and they land together.
    if (!newState && abstractRef.current) {
      stopAbstractScroll.current = tweenScrollTop(abstractRef.current, 0, {
        durationMs: CARD_DURATION_MS,
        immediate: prefersReducedMotion,
      });
    }
  };

  /**
   * What the panel is showing, and a key that changes only when the words do.
   *
   * The screens that hand this card a stored copy of a paper — a list, a
   * profile tab — carry no abstract at all: `serializeLibraryPaper` keeps a
   * title, authors and a truncated summary, not the text. So a paper opened
   * from Favourites paints "Abstract unavailable." and then, a beat later,
   * arXiv and OpenAlex answer with the real thing.
   *
   * The key is not the text itself. A 1,500-character paragraph as a React key
   * is paid for on every render, and all this has to answer is whether these
   * are the same words as before.
   */
  const abstractText = hasUsableAIAbstract(paper.abstract) ? paper.abstract : null;
  const abstractKey = abstractText
    ? `abstract:${abstractText.length}:${abstractText.slice(0, 24)}`
    : 'abstract:none';

  // The paragraph the panel is showing, the height it stands at, and the way to
  // end a resize that is still running.
  const lastAbstractParagraph = useRef(null);
  const lastAbstractHeight = useRef(null);
  const settleAbstractResize = useRef(null);

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
  }, []);

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
    let alive = true;
    let settleTimer = null;
    const read = () => {
      const node = abstractRef.current;
      if (!alive || !node || expandedRef.current) return;
      setAbstractClipped(node.scrollHeight - node.clientHeight > 1);
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
  }, [abstractKey, abstractText]);

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
  const attachAbstractBody = useCallback((paragraph) => {
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

    let backstop = null;
    const settle = () => {
      clearTimeout(backstop);
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

  const handleAbstractTransitionEnd = (event) => {
    // The panel has finished travelling between two abstracts: hand its height
    // back to the layout before anything else moves it.
    if (event.propertyName === 'height') settleAbstractResize.current?.();
    if (!expanded && event.propertyName === 'max-height' && abstractRef.current) {
      abstractRef.current.scrollTop = 0;
    }
  };

  const isReadActive = isRead || isMarkingRead;
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

  const closeRelatedCard = useCallback(() => {
    if (relatedCardClosingRef.current) return;
    relatedCardClosingRef.current = true;
    relatedHydrationRequestRef.current += 1;
    setIsClosingRelatedCard(true);
    const duration = getRelatedTransitionDuration(RELATED_CARD_CLOSE_MS, prefersReducedMotion);
    const finishRelatedCardClose = () => {
      relatedCardClosingRef.current = false;
      relatedPreparationRef.current = null;
      relatedCardTransitionTimerRef.current = null;
      setPendingRelatedPaper(null);
      setSelectedRelatedPaper(null);
      setIsClosingRelatedCard(false);
    };
    if (duration === 0) {
      finishRelatedCardClose();
      return;
    }
    relatedCardTransitionTimerRef.current = setTimeout(
      finishRelatedCardClose,
      getRelatedTransitionFallbackDelay(RELATED_CARD_CLOSE_MS, prefersReducedMotion),
    );
  }, [prefersReducedMotion]);
  const relatedCardDialogRef = useDialogFocus(Boolean(activeRelatedPaper), closeRelatedCard);

  const handleRelatedCardAnimationEnd = useCallback((event) => {
    if (event.target !== event.currentTarget || getRelatedTransitionAction(event.animationName) !== 'close') return;
    if (!relatedCardClosingRef.current) return;
    if (relatedCardTransitionTimerRef.current !== null) clearTimeout(relatedCardTransitionTimerRef.current);
    relatedCardTransitionTimerRef.current = null;
    relatedCardClosingRef.current = false;
    relatedPreparationRef.current = null;
    setPendingRelatedPaper(null);
    setSelectedRelatedPaper(null);
    setIsClosingRelatedCard(false);
  }, []);

  useEffect(() => () => {
    if (relatedCardTransitionTimerRef.current !== null) clearTimeout(relatedCardTransitionTimerRef.current);
    relatedHydrationRequestRef.current += 1;
  }, []);

  const closeRelatedSheet = useCallback(() => {
    setShowRelated(false);
  }, []);

  const prepareRelatedPaper = useCallback((relatedPaper) => {
    const identity = getRelatedPaperIdentity(relatedPaper);
    const promise = resolveWithin(
      hydrateCitationGraphPaper(relatedPaper),
      RELATED_PAPER_HYDRATION_TIMEOUT_MS,
      relatedPaper,
    );
    relatedPreparationRef.current = { identity, promise };
    return promise;
  }, []);

  const selectRelatedPaper = useCallback((relatedPaper) => {
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
      setSelectedRelatedPaper(preparedPaper || relatedPaper);
      setPendingRelatedPaper(null);
    });
  }, [analyticsSurface, position, prepareRelatedPaper, trackEvent]);

  const requireAuthentication = useCallback((action) => {
    onAuthRequired?.(action);
  }, [onAuthRequired]);

  const handleMarkAsRead = (e) => {
    e.stopPropagation();
    if (publicMode) {
      requireAuthentication('mark_read');
      return;
    }
    setIsMarkingRead(true);
    setTimeout(() => {
      onMarkAsRead(paper);
    }, prefersReducedMotion ? 0 : 1500); // give time for animation before unmounting
  };

  // Get area info for the gradient background
  const getCategoryLabelText = () => {
    const cat = visiblePrimaryCategory;
    const area = Object.values(CATEGORIES).find(a => a.subcategories && a.subcategories[cat]);
    if (area) {
      return isEnglish
        ? area.subcategories[cat].labelEn || area.subcategories[cat].label
        : area.subcategories[cat].label;
    }
    // Not `cat` raw. For anything from OpenAlex that is a concept, not a
    // field — "QUBIT", "Toric code" — so the kicker announced a keyword where
    // it meant to announce a branch of science, and disagreed with the colour
    // beside it. The branch, resolved through the same chain as the ink.
    const branch = areaLabelForPaper(paper, { english: isEnglish });
    if (branch) return branch;
    if (paper.journal) return paper.journal;
    return isEnglish ? 'Research Paper' : 'Artículo científico';
  };

  const categoryLabel = getCategoryLabelText();
  const primaryTopic = useMemo(
    () => visiblePrimaryCategory ? resolvePaperTopic({
      categoryId: visiblePrimaryCategory,
      categoryIds: [visiblePrimaryCategory],
      display_name: categoryLabel,
      query: visiblePrimaryCategory,
      source: 'category',
    }, language) : null,
    [categoryLabel, language, visiblePrimaryCategory]
  );
  const paperTopicTags = useMemo(
    () => buildPaperTopicTags({
      categories: paper.categories,
      concepts: paper.concepts,
      primaryCategory: paper.primaryCategory,
    }, 4, language),
    [language, paper.categories, paper.concepts, paper.primaryCategory]
  );

  const openTopic = useCallback((event, topic) => {
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
    () => AREA_WATERMARK_ICONS[areaKeyForPaper(paper)] || null,
    [paper],
  );

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isLiked) {
        if (publicMode) {
          requireAuthentication('like');
          lastTap.current = now;
          return;
        }
        onLike(paper);
        setShowHeart(true);
        setTimeout(() => setShowHeart(false), 1200);
      }
    }
    lastTap.current = now;
  }, [isLiked, onLike, paper, publicMode, requireAuthentication]);

  const handleLike = (e) => {
    e.stopPropagation();
    if (publicMode) {
      requireAuthentication('like');
      return;
    }
    onLike(paper);
    if (!isLiked) {
      setShowHeart(true);
      setTimeout(() => setShowHeart(false), 1200);
    }
  };

  const handleNotInterested = (e) => {
    e.stopPropagation();
    if (publicMode) {
      requireAuthentication('not_interested');
      return;
    }
    onNotInterested(paper);
  };

  const handleSave = (event) => {
    event.stopPropagation();
    if (publicMode) {
      requireAuthentication('save');
      return;
    }
    onSaveToList(paper);
  };

  // Derived before the handlers that close over it (no-use-before-define).
  const resolvedOpenCopy = resolvedAccess.paperId === paper.id ? resolvedAccess.copy : null;

  const handleOpenPaper = async (event) => {
    event.stopPropagation();
    const destination = resolvedOpenCopy?.pdfUrl
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
    const openBestTarget = (openCopy) => openFirstTarget(openTargetsForPaper(paper, openCopy), {
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
  // set by the Unpaywall lookup, and that lookup only runs for a paper with no
  // readable copy of its own, so its presence means exactly "the published
  // version is closed and we found a free one elsewhere" — a weaker claim than
  // open access, and the tag says so.
  const reviewTag = reviewTagForPaper(paper, { english: isEnglish });
  const accessTag = accessTagForPaper(paper, {
    english: isEnglish,
    openCopyFound: Boolean(resolvedOpenCopy),
  });
  const researchResources = linkedResources.paperId === paper.id ? linkedResources.items : [];
  const readablePaper = useMemo(() => resolvedOpenCopy ? {
    ...paper,
    openAccess: true,
    openAccessPdfUrl: resolvedOpenCopy.pdfUrl || paper.openAccessPdfUrl,
  } : paper, [paper, resolvedOpenCopy]);
  const canRequestRewrite = canRewritePaper(readablePaper);
  const bestAvailableUrl = safeExternalUrl(resolvedOpenCopy?.pdfUrl)
    || safeExternalUrl(resolvedOpenCopy?.landingPageUrl)
    || safeExternalUrl(paper.openAccessPdfUrl)
    || safeExternalUrl(paper.pdfUrl)
    || safeExternalUrl(paper.landingPageUrl)
    || safeDoiUrl(paper.doi);
  const shareUrl = getPublicPaperUrl(paper)
    || bestAvailableUrl
    || (paper.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}` : '');

  const handleShare = async (event) => {
    event.stopPropagation();
    if (!shareUrl) return;

    if (navigator.share) {
      try {
        await navigator.share({ title: paper.title, url: shareUrl });
        trackEvent('share', { method: 'native', content_type: 'paper', surface: analyticsSurface });
      } catch (error) {
        if (error?.name !== 'AbortError') console.error('Paper share failed', error);
      }
      return;
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      trackEvent('share', { method: 'clipboard', content_type: 'paper', surface: analyticsSurface });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Could not copy paper link', error);
    }
  };
  const primaryActionLabel = isResolvingAccess
    ? (isEnglish ? 'Finding access...' : 'Buscando acceso...')
    : resolvedOpenCopy
      ? (isEnglish ? 'Read open version' : 'Leer versión abierta')
      : paper.openAccessPdfUrl
        ? (isEnglish ? 'Read full text' : 'Leer texto completo')
        : (!paper.pdfUrl && !paper.arxivId)
          ? (isEnglish ? 'Open source' : 'Abrir fuente')
          : (isEnglish ? 'Read article' : 'Leer artículo');
  return (
    <div ref={cardRef} className={`pc ${isCardVisible ? 'pc--visible' : ''} ${isMarkingRead ? 'pc--fade-out' : ''}`} onClick={handleDoubleTap}>
      {/* DEBUG PANEL */}
      {SHOW_RANKING_DEBUG && paper._debugScore && (
        <div className="pc-debug-panel">
          <div><strong>TOTAL SCORE: {paper._debugScore.total.toFixed(2)}</strong></div>
          <div>Why: {paper._debugScore.explanation}</div>
          <div>Affinity: {paper._debugScore.affinity.toFixed(2)}</div>
          <div>Preference Match: {paper._debugScore.preference.toFixed(2)}</div>
          <div>Recency Boost: {paper._debugScore.recency.toFixed(2)}</div>
          {paper._debugScore.semantic > 0 && (
            <div style={{color: 'var(--brand)'}}>Semantic: {paper._debugScore.semantic.toFixed(2)}</div>
          )}
          {paper._debugScore.citations > 0 && (
            <div style={{color: 'var(--primary)'}}>Citation Boost: {paper._debugScore.citations.toFixed(2)}</div>
          )}
          {paper._debugScore.graphBoost > 0 && (
            <div style={{color: 'var(--warning)'}}>Graph Connection: {paper._debugScore.graphBoost.toFixed(2)}</div>
          )}
          {paper._debugScore.cooldownMultiplier < 1.0 && (
            <div style={{color: 'var(--danger)'}}>Cooldown: x{paper._debugScore.cooldownMultiplier.toFixed(2)}</div>
          )}
          <div>Exploration: {paper._debugScore.isExploration ? 'YES' : 'NO'}</div>
        </div>
      )}

      {scatteredFigures.length > 0 && (
        <div className="pc-figures" aria-hidden="true">
          {scatteredFigures.map(({ item, style }) => (
            <figure
              key={item.url}
              className={`pc-figure${loadedFigures.has(item.url) ? ' is-loaded' : ''}`}
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

      <article className="pc-sheet" style={{ '--area-accent': areaAccentForPaper(paper) }}>
        {WatermarkIcon && (
          <span className="pc-watermark" aria-hidden="true">
            <WatermarkIcon size={220} strokeWidth={0.6} />
          </span>
        )}

        <div className="pc-body">
        {showFollowReason && (() => {
          const reason = buildFollowReasonLabel(
            (paper._followedEntityMatches || []).filter(match => typeof match === 'object'),
            language,
          );
          if (!reason) return null;
          return (
            <motion.div
              className="pc-follow-reason"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}
            >
              <UserCheck size={13} aria-hidden="true" />
              <span>{reason}</span>
            </motion.div>
          );
        })()}
        <div className="pc-meta">
          {primaryTopic ? (
            <button
              type="button"
              className="pc-category-pill pc-topic-link"
              onClick={(event) => openTopic(event, primaryTopic)}
              title={`${isEnglish ? 'Explore' : 'Explorar'} ${categoryLabel}`}
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
                <UserCheck size={12} /> {isEnglish ? 'Followed author' : 'Autor seguido'}
              </span>
            </>
          )}
          <span className="pc-meta-dot">·</span>
          <span className="pc-date">{paper.year}</span>

          {(paper.citationCountKnown || paper.citationCount > 0) && (
            <>
              <span className="pc-meta-dot">·</span>
              {paper.sources?.primary === 'scopus' && paper.scopusCitedByUrl ? (
                <a
                  className="pc-citations"
                  href={safeExternalUrl(paper.scopusCitedByUrl) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`${paper.citationCount} ${isEnglish ? 'citations on Scopus' : 'citas en Scopus'}`}
                >
                  {paper.citationCount} {isEnglish ? 'Citations on Scopus' : 'Citas en Scopus'}
                </a>
              ) : (
                <span className="pc-citations">
                  {paper.citationCount} {isEnglish ? 'Citations' : 'Citas'}
                </span>
              )}
            </>
          )}
        </div>

        {/* Two facts and a link: what this paper is, whether it opens, and where
            the record of it lives. The row used to hang off `!isPreprint`, so a
            preprint — the one case where the caveat is the whole point — showed
            no chips at all, and the availability chips had no JSX left anywhere.
            Each chip carries the sentence behind its word in `title`, because
            "Preprint" is not a word a reader outside academia arrives knowing. */}
        <div className="pc-chips">
          {reviewTag && (() => {
            const Glyph = STATUS_CHIP_ICONS[reviewTag.key];
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
              const Glyph = STATUS_CHIP_ICONS[accessTag.key];
              return (
                <motion.span
                  key={accessTag.key}
                  className="pc-chip"
                  data-tone={accessTag.tone}
                  title={accessTag.hint}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
                  transition={{
                    duration: prefersReducedMotion ? 0.1 : 0.24,
                    ease: [0.16, 1, 0.3, 1],
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
              title={isEnglish ? 'Open the DOI record' : 'Abrir el registro DOI'}
            >
              <ExternalLink size={12} /> DOI
            </a>
          )}
        </div>

        {/* What the paper is filed under. Machine data, so it belongs with the
            meta line and the status chips above the headline — not in the
            action row, where a paper with many concepts used to push the
            reading buttons past the sheet and out of sight. */}
        {paperTopicTags.length > 0 && (
          <div
            className="pc-topics"
            role="group"
            aria-label={isEnglish ? 'Paper topics' : 'Temas del paper'}
          >
            {paperTopicTags.map((tag) => {
              const topic = resolvePaperTopic(tag.value, language);
              if (!topic) return null;
              return (
                <button
                  key={tag.key}
                  type="button"
                  className={`pc-semantic-tag pc-topic-link ${tag.source === 'concept' && !topic.reliable ? 'pc-topic-link--external' : ''}`}
                  onClick={(event) => openTopic(event, topic)}
                  title={`${isEnglish ? 'Explore' : 'Explorar'} ${topic.label}`}
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        )}

        <AnimatePresence initial={false}>
          {project && (
            <motion.div
              key="project-badge"
              className="pc-project-badge-slot"
              // The badge arrives async, so at mount time the space it needs
              // does not exist yet and something below has to move. Reserving
              // it in one layout pass (the previous iteration, after a
              // 620ms `gridTemplateRows` tween proved too heavy) made the
              // title jolt down a full row in a single frame -- that snap,
              // not the easing, read as abrupt. This is the middle ground: a
              // short measured `height: 0 -> auto` tween eases the space
              // open. It is a layout property again, knowingly -- 0.45s once
              // per card, on this slot's subtree. The pill itself stays
              // invisible until the space has mostly opened, then fades in
              // via the inner `.pc-project-badge-motion` (which owns all the
              // opacity/y/scale so the two layers never stack curves). No
              // overflow clip on this slot on purpose: the global
              // `:focus-visible` ring overhangs the pill by 4px and a hard
              // clip would cut it -- the fade delay below is what keeps the
              // pill from ghosting over the title while the space opens.
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
              <div className="pc-project-badge-slot-inner">
                <motion.div
                  className="pc-project-badge-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : {
                      opacity: { delay: 0.3, duration: 0.5, ease: 'easeOut' },
                      default: { delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] },
                    }}
                >
                  <button
                    type="button"
                    className="pc-project-badge"
                    disabled={!project.code}
                    onClick={(e) => {
                      e.stopPropagation();
                      const paperId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
                      const path = publicMode
                        ? getPublicEntityPath('project', project.code)
                        : `/explorer/project/${encodeURIComponent(project.code)}?name=${encodeURIComponent(project.acronym)}&funder=${encodeURIComponent(project.funder)}&arxivId=${paperId}`;
                      trackEvent('select_content', {
                        content_type: 'project',
                        surface: analyticsSurface,
                        position,
                      });
                      if (path) navigate(path);
                    }}
                    title={project.code
                      ? (isEnglish ? 'Open research project' : 'Abrir proyecto de investigación')
                      : undefined}
                  >
                    <Briefcase size={12} />
                    <span>
                      {[project.funderLevel, project.funder].find(value => value && value !== 'Unknown Funder')
                        || (isEnglish ? 'Project' : 'Proyecto')}: {project.acronym}
                    </span>
                  </button>
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <h2 className="pc-title" lang="en">
          <ScientificText>{paper.title}</ScientificText>
        </h2>

        <div 
          className="pc-authors pc-authors--mobile-clickable"
          onClick={(e) => {
            if (window.innerWidth <= 768) {
              e.stopPropagation();
              setShowAuthorsModal(true);
            }
          }}
        >
          <div className="pc-author-avatars">
            {(paper.authors || []).slice(0, 3).map((author, i) => (
              <div key={i} className="pc-author-avatar" style={{ '--i': i }}>
                {(author.name || author).charAt(0).toUpperCase()}
              </div>
            ))}
          </div>
          <div className="pc-author-names">
            {/* The comma and the space live outside the button, not inside it.
                These buttons are inline-block, and a trailing space inside an
                inline-block box is trimmed away, so "Kramer, Alexander" used to
                render as "Kramer,Alexander". Keeping the separator out also
                keeps it out of each button's accessible name. */}
            {(paper.authors || []).slice(0, 3).map((author, index) => {
               const authorName = author.name || author;
               // `path` now doubles as the <Link to> destination, so it has to
               // be known at render time — a <Link> can't compute where it
               // goes lazily inside its own onClick the way the old <button>
               // did.
               const pId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
               const path = publicMode
                 ? getPublicEntityPath('author', author.id || authorName)
                 : `/explorer/author/${encodeURIComponent(authorName)}?arxivId=${pId}`;
               return (
                 <Fragment key={index}>
                   {path ? (
                     <Link
                       to={path}
                       className="pc-author-link pc-author-btn"
                       onClick={(e) => {
                         e.stopPropagation();
                         trackEvent('select_content', {
                           content_type: 'author',
                           surface: analyticsSurface,
                           position,
                         });
                       }}
                     >
                       {authorName}
                     </Link>
                   ) : (
                     // getPublicEntityPath found neither a usable id nor a
                     // name (publicMode only): there is nowhere to send a
                     // click, so render inert text instead of a link to
                     // nowhere.
                     <span className="pc-author-btn pc-author-btn--static">
                       {authorName}
                     </span>
                   )}
                   {index < Math.min((paper.authors || []).length, 3) - 1 ? ', ' : ''}
                 </Fragment>
               );
            })}
            {(paper.authors || []).length > 3 && (
              <>
                {' '}
                <button
                  type="button"
                  className="pc-authors-more"
                  aria-haspopup="dialog"
                  onClick={(e) => { e.stopPropagation(); setShowAuthorsModal(true); }}
                  aria-label={isEnglish ? 'Show all authors' : 'Ver todos los autores'}
                >
                  et al.
                </button>
              </>
            )}
          </div>
        </div>

        <div
          ref={abstractRef}
          id={abstractId}
          className={`pc-abstract ${expanded ? 'pc-abstract--open' : ''} ${abstractClipped === false ? 'pc-abstract--whole' : ''}`}
          onClick={(e) => toggleExpanded(e, !expanded)}
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
            <motion.p
              key={abstractKey}
              ref={attachAbstractBody}
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                transition: {
                  duration: prefersReducedMotion ? 0.1 : 0.34,
                  ease: [0.16, 1, 0.3, 1],
                },
              }}
              exit={{
                opacity: 0,
                transition: { duration: prefersReducedMotion ? 0.08 : 0.18, ease: 'easeIn' },
              }}
            >
              {abstractText
                ? <ScientificText>{abstractText}</ScientificText>
                : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
            </motion.p>
          </AnimatePresence>
        </div>

        {/* Only where there is something to reveal. `expanded` keeps it on
            screen once opened, since an open panel clips nothing and would
            otherwise take away the control that closes it. */}
        {abstractText && (abstractClipped === true || expanded) && (
        <button
          type="button"
          className="pc-abstract-toggle"
          aria-expanded={expanded}
          aria-controls={abstractId}
          onClick={(e) => toggleExpanded(e, !expanded)}
        >
          {expanded
            ? (isEnglish ? 'Show less' : 'Mostrar menos')
            : (isEnglish ? 'Read full abstract' : 'Leer el abstract completo')}
        </button>
        )}

        <AnimatePresence initial={false}>
          {researchResources.length > 0 && (
            <motion.div
              key={`linked-resources-${paperViewKey}`}
              className="pc-linked-resources-slot"
              // Same choreography as `.pc-project-badge-slot` above, for the
              // same reason: reserving the height in one layout pass made
              // everything below jolt down in a single frame, and that snap
              // -- not the easing -- read as abrupt. A short measured
              // `height: 0 -> auto` tween eases the space open (a layout
              // property again, knowingly: 0.45s once per card), and the
              // block only fades in once the space has mostly opened. No
              // overflow clip here either -- the resource chips are links
              // whose `:focus-visible` ring overhangs by 4px -- so it is the
              // fade delay that keeps content from ghosting over what sits
              // below while the space opens.
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
                    : { opacity: 0, y: 10, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : {
                      opacity: { delay: 0.3, duration: 0.5, ease: 'easeOut' },
                      default: { delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] },
                    }}
                >
                  <div className="pc-linked-resources" aria-label={isEnglish ? 'Associated research resources' : 'Recursos de investigación asociados'}>
                    <span className="pc-linked-resources-label"><Database size={14} /> {isEnglish ? 'Resources' : 'Recursos'}</span>
                    <div className="pc-linked-resources-list">
                      {researchResources.map((resource, index) => {
                        const config = RESOURCE_KIND_CONFIG[resource.kind] || RESOURCE_KIND_CONFIG.material;
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
                            initial={prefersReducedMotion ? false : { opacity: 0, y: 3 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={prefersReducedMotion
                              ? { duration: 0.12 }
                              // Base delay sits just after the block starts
                              // fading in (0.3s) -- earlier and the chips
                              // would animate under a still-transparent
                              // parent, wasting the cascade.
                              : { duration: 0.3, delay: 0.42 + Math.min(index, 4) * 0.05, ease: [0.16, 1, 0.3, 1] }}
                          >
                            <ResourceIcon size={13} />
                            <span>{resourceLabel}</span>
                            <ExternalLink size={11} />
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
            <Button onClick={handleOpenPaper} disabled={isResolvingAccess}>
              {isResolvingAccess ? <Loader2 className="spinning" size={16} /> : <FileText size={16} />}
              <span className="pc-action-label">{primaryActionLabel}</span>
            </Button>

            {canRequestRewrite && (
              <Button
                variant="brand"
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
                aria-label={isEnglish ? 'Read this paper in plain words' : 'Leer este paper en simple'}
              >
                <Sparkles size={16} />
                <span className="pc-action-label">{isEnglish ? 'Read in plain words' : 'Leer en simple'}</span>
                <span className="pc-action-label--short">{isEnglish ? 'Simple' : 'Simple'}</span>
              </Button>
            )}
          </div>

          <div className="pc-action-utilities">
            <Button
              variant="outline"
              size="icon"
              onClick={handleShare}
              aria-label={isEnglish ? 'Share' : 'Compartir'}
              title={copied
                ? (isEnglish ? 'Copied' : 'Copiado')
                : (isEnglish ? 'Share' : 'Compartir')}
            >
              {copied ? <Check size={16} /> : <Share2 size={16} />}
            </Button>

            {(paper.doi || paper.arxivId || paper.semanticScholarId) && (
              <Button
                variant="sky"
                size="icon"
                onClick={(event) => { event.stopPropagation(); setShowRelated(true); }}
                aria-label={isEnglish ? 'View related papers' : 'Ver papers relacionados'}
                title={isEnglish ? 'Related papers' : 'Papers relacionados'}
              >
                <Network size={17} />
              </Button>
            )}
          </div>
        </div>
        </div>
      </article>

      {/* Side actions (TikTok style) */}
      <div className="pc-side-actions">
        <button
          className={`pc-side-btn pc-side-btn--like ${isLiked ? 'pc-side-btn--liked' : ''}`}
          onClick={handleLike}
          aria-pressed={isLiked}
        >
          <span className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isLiked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75">
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </span>
          <span className="pc-side-label">{isEnglish ? 'Like' : 'Me gusta'}</span>
        </button>

        {canOpenComments && (
          <button
            className="pc-side-btn"
            onClick={() => onOpenComments(paper)}
            aria-haspopup="dialog"
          >
            <span className="pc-side-icon">
              <MessageCircle size={20} />
            </span>
            <span className="pc-side-label">{isEnglish ? 'Comments' : 'Comentarios'}</span>
          </button>
        )}

        <button
          className={`pc-side-btn pc-side-btn--bookmark ${isSaved ? 'pc-side-btn--saved' : ''}`}
          onClick={handleSave}
          aria-pressed={isSaved}
        >
          <span className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isSaved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.75">

              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span className="pc-side-label">{isEnglish ? 'Save' : 'Guardar'}</span>
        </button>

        <button
          className={`pc-side-btn pc-side-btn--seen ${isReadActive ? 'pc-side-btn--read' : ''}`}
          onClick={handleMarkAsRead}
        >
          <span className="pc-side-icon">
            {isReadActive ? <CheckCircle2 size={20} /> : <Eye size={20} />}
          </span>
          <span className="pc-side-label">
            {resolvedOpenCopy || paper.openAccessPdfUrl
              ? (isEnglish ? 'Open version' : 'Versión abierta')
              : paper.pdfUrl
                ? (isEnglish ? 'Read article' : 'Leer artículo')
                : (paper.landingPageUrl || paper.doi
                  ? (isEnglish ? 'Open source' : 'Abrir fuente')
                  : (isEnglish ? 'Read' : 'Leer'))}
          </span>
        </button>

        <button className="pc-side-btn pc-side-btn--skip" onClick={handleNotInterested}>
          <span className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </span>
          <span className="pc-side-label">{isEnglish ? 'Skip' : 'Pasar'}</span>
        </button>
      </div>

      {/* Double-tap heart */}
      {showHeart && (
        <div className="pc-heart-burst">
          <svg viewBox="0 0 24 24" fill="currentColor" width="88" height="88">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <div className="pc-heart-ring" />
        </div>
      )}

      {/* Scroll hint on first card */}
      {!hideScrollHint && (
        <div className="pc-scroll-hint">
          <span className="pc-scroll-hint-label">{isEnglish ? 'Scroll' : 'Desliza'}</span>
          <span className="pc-scroll-hint-arrow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </div>
      )}

      <AnimatePresence>
        {showAuthorsModal && (
          <motion.div 
            ref={authorsDialogRef}
            className="pc-authors-modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pc-authors-dialog-title"
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.2, ease: 'easeOut' }}
            onClick={(e) => { e.stopPropagation(); setShowAuthorsModal(false); }}
          >
            <motion.div 
              className="pc-authors-modal-sheet"
              initial={prefersReducedMotion ? false : { y: '100%' }}
              animate={{ y: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
              transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 25, stiffness: 200 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pc-authors-modal-header">
                <h3 id="pc-authors-dialog-title">{isEnglish ? 'Authors' : 'Autores'}</h3>
                <button data-dialog-initial-focus onClick={() => setShowAuthorsModal(false)} aria-label={isEnglish ? 'Close authors' : 'Cerrar autores'}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <div className="pc-authors-modal-list">
                {(paper.authors || []).map((author, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="pc-authors-modal-item"
                    onClick={() => {
                      setShowAuthorsModal(false);
                      const authorStr = typeof author === 'string' ? author : author.name;
                      const path = publicMode
                        ? getPublicEntityPath('author', author.id || authorStr)
                        : `/explorer/author/${encodeURIComponent(authorStr)}?arxivId=${paper.arxivId || ''}`;
                      trackEvent('select_content', {
                        content_type: 'author',
                        surface: analyticsSurface,
                        position,
                      });
                      if (path) navigate(path);
                    }}
                  >
                    <div className="pc-author-avatar-large" style={{ '--i': idx }} aria-hidden="true">
                      {(author.name || author).charAt(0).toUpperCase()}
                    </div>
                    <span>{author.name || author}</span>
                  </button>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {showRelated && createPortal(
        <Suspense fallback={null}>
          <RelatedPapersSheet
            paper={paper}
            onClose={closeRelatedSheet}
            onPreparePaper={prepareRelatedPaper}
            onSelectPaper={selectRelatedPaper}
          />
        </Suspense>,
        document.body,
        `papertok-related-sheet:${getRelatedPaperIdentity(paper) || 'current'}`,
      )}
      {showReader && createPortal(
        // The reader opens over a card that already painted, so there is no
        // layout to hold a place for — fallback={null} is a deliberate no-op
        // while the chunk downloads (a first open only; the browser caches it).
        <Suspense fallback={null}>
          <PaperReader
            paper={readablePaper}
            originRect={readerOrigin}
            onClose={() => setShowReader(false)}
          />
        </Suspense>,
        document.body,
        'papertok-paper-reader',
      )}
      {activeRelatedPaper && createPortal(
        <div
          ref={relatedCardDialogRef}
          className={`related-card-overlay ${isClosingRelatedCard ? 'is-closing' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={isEnglish ? 'Related paper' : 'Paper relacionado'}
          tabIndex={-1}
          onAnimationEnd={handleRelatedCardAnimationEnd}
        >
          <button
            className="related-card-back"
            data-dialog-initial-focus
            onClick={closeRelatedCard}
            aria-label={isEnglish ? 'Back to previous paper' : 'Volver al paper anterior'}
            title={isEnglish ? 'Back' : 'Volver'}
          >
            <ArrowLeft size={22} />
          </button>
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
                trackViewTime={trackViewTime}
                trackSkip={trackSkip}
                onOpenPdf={onOpenPdf}
                onSaveToList={onSaveToList}
                onOpenComments={onOpenComments}
                getInteractionState={getInteractionState}
                hideScrollHint
                publicMode={publicMode}
                onAuthRequired={onAuthRequired}
                analyticsSurface={analyticsSurface}
                position={position}
              />
            </div>
          ) : (
            <RelatedPaperCardSkeleton label={isEnglish ? 'Loading paper details' : 'Cargando detalles del paper'} />
          )}
        </div>,
        document.body,
        `papertok-related-card:${getRelatedPaperIdentity(activeRelatedPaper) || 'selected'}`,
      )}
    </div>
  );
});

export default PaperCard;
