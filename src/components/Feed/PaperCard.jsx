import { useState, useRef, useCallback, useMemo, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORIES } from '../../data/categories';
import {
  ArrowLeft, Share2, FileText, Check, Loader2, Dna, BarChart2, TrendingUp, Zap,
  CircleDollarSign, Brain, Cpu, Database, Orbit, FlaskConical, Network, Sigma,
  BadgeCheck, Eye, CheckCircle2, UserCheck, Briefcase, ExternalLink,
  Cog, Building, HeartPulse, Code2, PackageOpen, History, Sparkles, MessageCircle,
} from 'lucide-react';
import { canonicalPaperIdentity } from '../../utils/paperCanonicalKey.js';
import ScientificText from '../ScientificText';
import { Button } from '../ui/button.jsx';
import { useFollowing } from '../../context/FollowingContext';
import { useLanguage } from '../../context/LanguageContext';
import { getProjectForPaper } from '../../services/openAireService';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import './PaperCard.css';
import RelatedPapersSheet from './RelatedPapersSheet';
import { findOpenAccessCopy } from '../../services/unpaywallService';
import { getRelatedResearchResources } from '../../services/dataCiteService';
import { getHuggingFaceResearchResources } from '../../services/huggingFaceService';
import { isOpaqueQueryTopicText, resolvePaperTopic, topicExplorerPath } from '../../utils/topicNavigation';
import PaperReader from '../Reader/PaperReader.jsx';
import { canRewritePaper } from '../../services/paperRewriteService.js';
import { getPaperFigures } from '../../services/paperFigureService.js';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { buildPaperTopicTags } from '../../utils/paperTopicTags.js';
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
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { getPublicEntityPath, getPublicPaperUrl } from '../../utils/publicNavigation.js';

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
const RELATED_PAPER_HYDRATION_TIMEOUT_MS = 8_000;

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
  const [expanded, setExpanded] = useState(false);
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
  const [pendingRelatedPaper, setPendingRelatedPaper] = useState(null);
  const [selectedRelatedPaper, setSelectedRelatedPaper] = useState(null);
  const [isClosingRelatedCard, setIsClosingRelatedCard] = useState(false);
  const [isResolvingAccess, setIsResolvingAccess] = useState(false);
  const [resolvedAccess, setResolvedAccess] = useState({ paperId: null, copy: null });
  const [linkedResources, setLinkedResources] = useState({ paperId: null, items: [] });
  const [isCardVisible, setIsCardVisible] = useState(false);
  const [isCardSettled, setIsCardSettled] = useState(false);
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
      return undefined;
    }

    const timer = setTimeout(() => setIsCardSettled(true), ENRICHMENT_SETTLE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isCardVisible]);

  useEffect(() => {
    let active = true;
    if (!isCardSettled || !paper?.doi || paper.openAccess || paper.pdfUrl || paper.openAccessPdfUrl || paper.citationMetadataResolved) {
      return () => { active = false; };
    }

    findOpenAccessCopy(paper.doi).then(openCopy => {
      if (active && openCopy) setResolvedAccess({ paperId: paper.id, copy: openCopy });
    });

    return () => { active = false; };
  }, [isCardSettled, paper?.citationMetadataResolved, paper?.doi, paper?.id, paper?.openAccess, paper?.openAccessPdfUrl, paper?.pdfUrl]);

  useEffect(() => {
    let active = true;
    const baseResources = paper?.researchResources || [];
    setLinkedResources({ paperId: paper?.id, items: baseResources });
    if (!isCardSettled) return () => { active = false; };

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
  }, [isCardSettled, paper?.arxivId, paper?.doi, paper?.id, paper?.researchResources, paper?.sources, paper?.title]);

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

  const [project, setProject] = useState(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    let isMounted = true;
    if (!isCardSettled || !paper) return;
    getProjectForPaper(paper.arxivId, paper.doi).then(proj => {
      if (isMounted && proj) {
        setProject(proj);
      }
    });
    return () => { isMounted = false; };
  }, [isCardSettled, paper]);

  const toggleExpanded = (e, newState) => {
    e.stopPropagation();
    setExpanded(newState);
    if (!newState && prefersReducedMotion && abstractRef.current) {
      abstractRef.current.scrollTop = 0;
    }
  };

  const handleAbstractTransitionEnd = (event) => {
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
  const getAreaInfo = () => {
    const cat = visiblePrimaryCategory;
    const prefix = cat.split('.')[0].split('-')[0];
    for (const [, area] of Object.entries(CATEGORIES)) {
      if (area.subcategories && area.subcategories[cat]) {
        return area;
      }
      // Try prefix match
      const subcatKeys = Object.keys(area.subcategories || {});
      if (subcatKeys.some(k => k.startsWith(prefix))) {
        return area;
      }
    }
    return { icon: FileText, gradient: 'var(--gradient-brand)' };
  };

  const getCategoryLabelText = () => {
    const cat = visiblePrimaryCategory;
    const area = Object.values(CATEGORIES).find(a => a.subcategories && a.subcategories[cat]);
    if (area) {
      return isEnglish
        ? area.subcategories[cat].labelEn || area.subcategories[cat].label
        : area.subcategories[cat].label;
    }
    if (cat) return cat;
    if (paper.journal) return paper.journal;
    return 'Research Paper';
  };

  const areaInfo = getAreaInfo();
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

  // Watermark icon for the paper's research area.
  const WatermarkIcon = useMemo(() => {
    const cat = visiblePrimaryCategory;
    for (const [key, area] of Object.entries(CATEGORIES)) {
      if (area.subcategories && area.subcategories[cat]) {
        return AREA_WATERMARK_ICONS[key] || AREA_WATERMARK_ICONS.physics;
      }
    }
    return AREA_WATERMARK_ICONS.physics;
  }, [visiblePrimaryCategory]);

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
    if (resolvedOpenCopy?.pdfUrl) {
      if (isTrustedInlinePdfUrl(resolvedOpenCopy.pdfUrl)) {
        onOpenPdf({ ...paper, ...resolvedOpenCopy, openAccess: true });
      } else {
        openExternalUrl(resolvedOpenCopy.pdfUrl);
      }
      return;
    }
    if (resolvedOpenCopy?.landingPageUrl) {
      openExternalUrl(resolvedOpenCopy.landingPageUrl);
      return;
    }
    if (paper.openAccessPdfUrl) {
      if (isTrustedInlinePdfUrl(paper.openAccessPdfUrl)) {
        onOpenPdf({ ...paper, pdfUrl: safeExternalUrl(paper.openAccessPdfUrl), openAccess: true });
      } else {
        openExternalUrl(paper.openAccessPdfUrl);
      }
      return;
    }
    const hasValidPdf = isTrustedInlinePdfUrl(paper.pdfUrl);
    if (paper.arxivId || hasValidPdf) {
      onOpenPdf(paper);
      return;
    }

    if (paper.doi) {
      setIsResolvingAccess(true);
      const openCopy = await findOpenAccessCopy(paper.doi);
      setIsResolvingAccess(false);
      if (openCopy?.pdfUrl) {
        setResolvedAccess({ paperId: paper.id, copy: openCopy });
        if (isTrustedInlinePdfUrl(openCopy.pdfUrl)) {
          onOpenPdf({ ...paper, ...openCopy, openAccess: true });
        } else {
          openExternalUrl(openCopy.pdfUrl);
        }
        return;
      }
      if (openCopy?.landingPageUrl) {
        setResolvedAccess({ paperId: paper.id, copy: openCopy });
        openExternalUrl(openCopy.landingPageUrl);
        return;
      }
    }

    const fallbackUrl = safeExternalUrl(paper.pdfUrl)
      || safeExternalUrl(paper.landingPageUrl)
      || safeDoiUrl(paper.doi);
    openExternalUrl(fallbackUrl);
  };

  const isPreprint = paper.publicationStatus === 'preprint';
  const resolvedOpenCopy = resolvedAccess.paperId === paper.id ? resolvedAccess.copy : null;
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
  const showRankingDebug = typeof window !== 'undefined' && window.localStorage?.getItem('DEBUG_RANKING') === 'true';

  return (
    <div ref={cardRef} className={`pc ${isCardVisible ? 'pc--visible' : ''} ${isMarkingRead ? 'pc--fade-out' : ''}`} onClick={handleDoubleTap}>
      {/* DEBUG PANEL */}
      {showRankingDebug && paper._debugScore && (
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

      {figures.length > 0 && (
        <div className="pc-figures" aria-hidden="true">
          {figures.map(item => (
            <figure key={item.url} className="pc-figure">
              <img src={item.url} alt="" decoding="async" />
            </figure>
          ))}
        </div>
      )}

      <article className="pc-sheet" style={{ '--area-accent': areaInfo.gradient }}>
        <span className="pc-watermark" aria-hidden="true">
          <WatermarkIcon size={220} strokeWidth={0.6} />
        </span>

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

        {!isPreprint && (
          <div className="pc-chips">
            <span className="pc-chip pc-chip--verified">
              <BadgeCheck size={12} /> Verified
            </span>
            {paper.doi && (
              <a
                className="pc-chip pc-chip--doi"
                href={safeDoiUrl(paper.doi)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} /> DOI
              </a>
            )}
          </div>
        )}

        <AnimatePresence initial={false}>
          {project && (
            <motion.div
              key="project-badge"
              className="pc-project-badge-slot"
              initial={prefersReducedMotion
                ? { opacity: 0 }
                : { gridTemplateRows: '0fr', opacity: 0 }}
              animate={{ gridTemplateRows: '1fr', opacity: 1 }}
              exit={prefersReducedMotion
                ? { opacity: 0 }
                : { gridTemplateRows: '0fr', opacity: 0 }}
              transition={prefersReducedMotion
                ? { duration: 0.12 }
                : {
                    gridTemplateRows: { duration: 0.62, ease: [0.22, 1, 0.36, 1] },
                    opacity: { duration: 0.32, delay: 0.06, ease: 'easeOut' },
                  }}
            >
              <div className="pc-project-badge-slot-inner">
                <motion.div
                  className="pc-project-badge-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, y: 5, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: 3, scale: 0.99 }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : { duration: 0.46, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
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

        <h2 className="pc-title">
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
            {(paper.authors || []).slice(0, 3).map((author, index) => (
               <span
                 key={index}
                 className="pc-author-link"
                 onClick={(e) => {
                   e.stopPropagation(); 
                   const pId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
                   const authorName = author.name || author;
                   const path = publicMode
                     ? getPublicEntityPath('author', author.id || authorName)
                     : `/explorer/author/${encodeURIComponent(authorName)}?arxivId=${pId}`;
                   trackEvent('select_content', {
                     content_type: 'author',
                     surface: analyticsSurface,
                     position,
                   });
                   if (path) navigate(path);
                 }}
               >
                 {author.name || author}{index < Math.min((paper.authors || []).length, 3) - 1 ? ', ' : ''}
               </span>
            ))}
            {(paper.authors || []).length > 3 && <span> et al.</span>}
          </div>
        </div>

        <div
          ref={abstractRef}
          className={`pc-abstract ${expanded ? 'pc-abstract--open' : ''}`}
          onClick={(e) => toggleExpanded(e, !expanded)}
          onTransitionEnd={handleAbstractTransitionEnd}
        >
          <p>
            {hasUsableAIAbstract(paper.abstract)
              ? <ScientificText>{paper.abstract}</ScientificText>
              : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
          </p>
        </div>

        <AnimatePresence initial={false}>
          {researchResources.length > 0 && (
            <motion.div
              key={`linked-resources-${paperViewKey}`}
              className="pc-linked-resources-slot"
              initial={prefersReducedMotion
                ? { opacity: 0 }
                : { gridTemplateRows: '0fr', opacity: 0 }}
              animate={{ gridTemplateRows: '1fr', opacity: 1 }}
              exit={prefersReducedMotion
                ? { opacity: 0 }
                : { gridTemplateRows: '0fr', opacity: 0 }}
              transition={prefersReducedMotion
                ? { duration: 0.12 }
                : {
                    gridTemplateRows: { duration: 0.62, ease: [0.22, 1, 0.36, 1] },
                    opacity: { duration: 0.32, delay: 0.06, ease: 'easeOut' },
                  }}
            >
              <div className="pc-linked-resources-slot-inner">
                <motion.div
                  className="pc-linked-resources-motion"
                  initial={prefersReducedMotion
                    ? false
                    : { opacity: 0, y: 5, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: 3, scale: 0.99 }}
                  transition={prefersReducedMotion
                    ? { duration: 0.12 }
                    : { duration: 0.46, delay: 0.12, ease: [0.16, 1, 0.3, 1] }}
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
                              : { duration: 0.26, delay: 0.2 + Math.min(index, 4) * 0.045, ease: [0.16, 1, 0.3, 1] }}
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

        <AnimatePresence initial={false}>
            {paperTopicTags.length > 0 && (
              <motion.div
                className="pc-semantic-tags-slot"
                initial={prefersReducedMotion ? false : { gridTemplateRows: '0fr', opacity: 0 }}
                animate={{ gridTemplateRows: '1fr', opacity: 1 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { gridTemplateRows: '0fr', opacity: 0 }}
                transition={prefersReducedMotion
                  ? { duration: 0 }
                  : { gridTemplateRows: { duration: 0.32, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.2 } }}
              >
              <div className="pc-semantic-tags">
                {paperTopicTags.map((tag) => {
                  const topic = resolvePaperTopic(tag.value, language);
                  if (!topic) return null;
                  return (
                    <motion.button
                      key={tag.key}
                      type="button"
                      className={`pc-semantic-tag pc-topic-link ${tag.source === 'concept' && !topic.reliable ? 'pc-topic-link--external' : ''}`}
                      onClick={(event) => openTopic(event, topic)}
                      title={`${isEnglish ? 'Explore' : 'Explorar'} ${topic.label}`}
                      initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: [0.16, 1, 0.3, 1] }}
                    >
                      {tag.label}
                    </motion.button>
                  );
                })}
              </div>
              </motion.div>
            )}
          </AnimatePresence>

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
                  <div 
                    key={idx} 
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
                    <div className="pc-author-avatar-large" style={{ '--i': idx }}>
                      {(author.name || author).charAt(0).toUpperCase()}
                    </div>
                    <span>{author.name || author}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {showRelated && createPortal(
        <RelatedPapersSheet
          paper={paper}
          onClose={closeRelatedSheet}
          onPreparePaper={prepareRelatedPaper}
          onSelectPaper={selectRelatedPaper}
        />,
        document.body,
        `papertok-related-sheet:${getRelatedPaperIdentity(paper) || 'current'}`,
      )}
      {showReader && createPortal(
        <PaperReader paper={readablePaper} onClose={() => setShowReader(false)} />,
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
