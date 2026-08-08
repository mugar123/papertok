import { useState, useRef, useCallback, useMemo, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORIES } from '../../data/categories';
import { 
  ArrowLeft, Share2, FileText, Check, Loader2, Monitor, Calculator, Dna, BarChart2, TrendingUp, Zap, CircleDollarSign, Brain, Cpu, Database, Orbit, Microscope, FlaskConical, Network, Sigma, Binary, Activity, BadgeCheck, Eye, CheckCircle2, UserCheck, Briefcase, Unlock, Lock, ExternalLink,
  Rocket, Settings, Wrench, Cog, PenTool, Building, Map, Compass, Beaker, TestTube, Thermometer, HeartPulse, Stethoscope, Syringe, Pill, Leaf, Bug, Sprout, Landmark, Coins, Radio, Box, Code2, PackageOpen, History, Sparkles
} from 'lucide-react';
import AnimatedAtom from './AnimatedAtom';
import ScientificText from '../ScientificText';
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
import AIExplanationSheet from './AIExplanationSheet';
import { canExplainPaper } from '../../services/aiExplanationService';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { buildPaperTopicTags } from '../../utils/paperTopicTags.js';
import { buildFollowReasonLabel } from '../../utils/followingFeed.js';
import { isTechnicalClassification } from '../../utils/scientificClassification.js';
import {
  getRelatedPaperIdentity,
  getRelatedTransitionAction,
  getRelatedTransitionDuration,
  RELATED_CARD_CLOSE_MS,
} from '../../utils/relatedPaperTransition.js';
import { hydrateCitationGraphPaper } from '../../services/citationGraphService.js';

// Pool of icons for the background constellation per area
const AREA_BG_ICONS = {
  physics: [AnimatedAtom, Orbit, Zap, Activity, Rocket, Microscope],
  cs: [Monitor, Cpu, Database, Brain, Network, Binary],
  math: [Calculator, Sigma, Activity, Orbit, Network, Box],
  stat: [BarChart2, TrendingUp, Sigma, Activity, Database, Brain],
  econ: [TrendingUp, BarChart2, CircleDollarSign, Landmark, Coins, Activity],
  'q-fin': [CircleDollarSign, TrendingUp, BarChart2, Network, Sigma, Activity],
  eess: [Zap, Monitor, Radio, Cpu, Network, Orbit],
  mech: [Settings, Wrench, Cog, PenTool, Activity, Box],
  civil: [Building, Map, Compass, Activity, Box, Network],
  chemeng: [Beaker, FlaskConical, TestTube, Thermometer, AnimatedAtom, Activity],
  med: [HeartPulse, Activity, Stethoscope, Syringe, Pill, Microscope],
  bio: [Dna, Leaf, Microscope, Bug, Sprout, FlaskConical],
};

const RESOURCE_KIND_CONFIG = {
  dataset: { label: { es: 'Datos', en: 'Data' }, Icon: Database },
  model: { label: { es: 'Modelo IA', en: 'AI model' }, Icon: Brain },
  software: { label: { es: 'Código', en: 'Code' }, Icon: Code2 },
  material: { label: { es: 'Material', en: 'Material' }, Icon: PackageOpen },
  version: { label: { es: 'Versión', en: 'Version' }, Icon: History },
};
const ENRICHMENT_SETTLE_DELAY_MS = 240;

function mergeResearchResources(...groups) {
  const seen = new Set();
  return groups.flat().filter(Boolean).filter(resource => {
    const key = `${resource.kind || ''}:${resource.url || resource.id || ''}`.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
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
  getInteractionState = () => ({}),
  hideScrollHint = false,
  showFollowReason = false
}) {
  const [expanded, setExpanded] = useState(false);
  const [showHeart, setShowHeart] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isMarkingRead, setIsMarkingRead] = useState(false);
  const [showAuthorsModal, setShowAuthorsModal] = useState(false);
  const [showRelated, setShowRelated] = useState(false);
  const [showAIExplanation, setShowAIExplanation] = useState(false);
  const [selectedRelatedPaper, setSelectedRelatedPaper] = useState(null);
  const [isHydratingRelatedPaper, setIsHydratingRelatedPaper] = useState(false);
  const [isClosingRelatedCard, setIsClosingRelatedCard] = useState(false);
  const [isResolvingAccess, setIsResolvingAccess] = useState(false);
  const [resolvedAccess, setResolvedAccess] = useState({ paperId: null, copy: null });
  const [linkedResources, setLinkedResources] = useState({ paperId: null, items: [] });
  const [isCardVisible, setIsCardVisible] = useState(false);
  const [isCardSettled, setIsCardSettled] = useState(false);
  const { followedByType, isFollowing } = useFollowing();
  const { language, isEnglish } = useLanguage();
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
  const relatedHydrationRef = useRef(0);

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
  }, [paper, selectedRelatedPaper, showRelated, trackViewTime, trackSkip]);

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
    if (!newState && abstractRef.current) {
      // Small delay to allow the DOM to start updating before resetting scroll
      setTimeout(() => {
        if (abstractRef.current) abstractRef.current.scrollTop = 0;
      }, 50);
    }
  };

  const isReadActive = isRead || isMarkingRead;
  const selectedRelatedState = selectedRelatedPaper
    ? getInteractionState(selectedRelatedPaper) || {}
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
    setIsClosingRelatedCard(true);
    if (getRelatedTransitionDuration(RELATED_CARD_CLOSE_MS, prefersReducedMotion) === 0) {
      relatedCardClosingRef.current = false;
      setSelectedRelatedPaper(null);
      setIsClosingRelatedCard(false);
    }
  }, [prefersReducedMotion]);

  const handleRelatedCardAnimationEnd = useCallback((event) => {
    if (event.target !== event.currentTarget || getRelatedTransitionAction(event.animationName) !== 'close') return;
    if (!relatedCardClosingRef.current) return;
    relatedCardClosingRef.current = false;
    setSelectedRelatedPaper(null);
    setIsClosingRelatedCard(false);
  }, []);

  const closeRelatedSheet = useCallback(() => {
    setShowRelated(false);
  }, []);

  const selectRelatedPaper = useCallback(async (relatedPaper) => {
    const hydrationId = relatedHydrationRef.current + 1;
    relatedHydrationRef.current = hydrationId;
    relatedCardClosingRef.current = false;
    setIsClosingRelatedCard(false);
    setShowRelated(false);
    setIsHydratingRelatedPaper(true);
    try {
      const hydratedPaper = await hydrateCitationGraphPaper(relatedPaper);
      if (relatedHydrationRef.current === hydrationId) setSelectedRelatedPaper(hydratedPaper);
    } finally {
      if (relatedHydrationRef.current === hydrationId) setIsHydratingRelatedPaper(false);
    }
  }, []);

  const handleMarkAsRead = (e) => {
    e.stopPropagation();
    setIsMarkingRead(true);
    setTimeout(() => {
      onMarkAsRead(paper);
    }, 1500); // give time for animation before unmounting
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
    return { icon: FileText, gradient: 'linear-gradient(135deg, #667eea, #764ba2)' };
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
    const path = topicExplorerPath(topic);
    if (path) navigate(path);
  }, [navigate]);

  // Generate scattered background icons (stable per paper id)
  const bgIcons = useMemo(() => {
    const cat = visiblePrimaryCategory;
    let areaKey = 'physics';
    for (const [key, area] of Object.entries(CATEGORIES)) {
      if (area.subcategories && area.subcategories[cat]) {
        areaKey = key;
        break;
      }
    }
    const iconPool = AREA_BG_ICONS[areaKey] || AREA_BG_ICONS.physics;
    let seed = 0;
    for (let i = 0; i < (paper.id || '').length; i++) seed += paper.id.charCodeAt(i);
    const seededRandom = (i) => {
      const x = Math.sin(seed + i * 127.1) * 43758.5453;
      return x - Math.floor(x);
    };
    return Array.from({ length: 12 }).map((_, i) => ({
      id: i,
      Icon: iconPool[i % iconPool.length],
      x: 5 + seededRandom(i * 2) * 90,
      y: 5 + seededRandom(i * 2 + 1) * 60,
      size: 18 + seededRandom(i * 3) * 40,
      opacity: 0.03 + seededRandom(i * 4) * 0.06,
      delay: seededRandom(i * 5) * 6,
      duration: 10 + seededRandom(i * 6) * 8,
      rotate: seededRandom(i * 7) * 360,
    }));
  }, [paper.id, visiblePrimaryCategory]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isLiked) {
        onLike(paper);
        setShowHeart(true);
        setTimeout(() => setShowHeart(false), 1200);
      }
    }
    lastTap.current = now;
  }, [isLiked, onLike, paper]);

  const handleLike = (e) => {
    e.stopPropagation();
    onLike(paper);
    if (!isLiked) {
      setShowHeart(true);
      setTimeout(() => setShowHeart(false), 1200);
    }
  };

  const handleNotInterested = (e) => {
    e.stopPropagation();
    onNotInterested(paper);
  };

  const handleOpenPaper = async (event) => {
    event.stopPropagation();
    if (resolvedOpenCopy?.pdfUrl) {
      onOpenPdf({ ...paper, ...resolvedOpenCopy, openAccess: true });
      return;
    }
    if (resolvedOpenCopy?.landingPageUrl) {
      window.open(resolvedOpenCopy.landingPageUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (paper.openAccessPdfUrl) {
      window.open(paper.openAccessPdfUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    const hasValidPdf = paper.pdfUrl && (paper.pdfUrl.includes('arxiv.org') || /\.pdf(?:$|[?#])/i.test(paper.pdfUrl));
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
        onOpenPdf({ ...paper, ...openCopy, openAccess: true });
        return;
      }
      if (openCopy?.landingPageUrl) {
        setResolvedAccess({ paperId: paper.id, copy: openCopy });
        window.open(openCopy.landingPageUrl, '_blank', 'noopener,noreferrer');
        return;
      }
    }

    const fallbackUrl = paper.pdfUrl || paper.landingPageUrl || (paper.doi ? `https://doi.org/${paper.doi}` : '');
    if (fallbackUrl) window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
  };

  const isPreprint = paper.publicationStatus === 'preprint';
  const resolvedOpenCopy = resolvedAccess.paperId === paper.id ? resolvedAccess.copy : null;
  const researchResources = linkedResources.paperId === paper.id ? linkedResources.items : [];
  const isOpenAccess = Boolean(paper.openAccess || resolvedOpenCopy);
  const aiExplanationPaper = useMemo(() => resolvedOpenCopy ? {
    ...paper,
    openAccess: true,
    openAccessPdfUrl: resolvedOpenCopy.pdfUrl || paper.openAccessPdfUrl,
  } : paper, [paper, resolvedOpenCopy]);
  const canRequestAIExplanation = canExplainPaper(aiExplanationPaper);
  const openAccessLabel = resolvedOpenCopy
    ? (isEnglish ? 'Open version available' : 'Versión abierta disponible')
    : paper.accessSource === 'europepmc'
      ? (isEnglish ? 'Open full text' : 'Texto completo abierto')
      : 'Open Access';
  const bestAvailableUrl = resolvedOpenCopy?.pdfUrl
    || resolvedOpenCopy?.landingPageUrl
    || paper.openAccessPdfUrl
    || paper.pdfUrl
    || paper.landingPageUrl
    || (paper.doi ? `https://doi.org/${paper.doi}` : '');
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
      <div className="pc-bg" style={{ background: areaInfo.gradient }} />
      <div className="pc-bg-overlay" />

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

      <div className="pc-bg-constellation">
        {bgIcons.map((item) => (
          <span
            key={item.id}
            className="pc-bg-icon"
            style={{
              '--bg-x': `${item.x}%`,
              '--bg-y': `${item.y}%`,
              '--bg-delay': `${item.delay}s`,
              '--bg-duration': `${item.duration}s`,
              '--bg-rotate': `${item.rotate}deg`,
              '--bg-opacity': item.Icon === AnimatedAtom ? Math.max(item.opacity, 0.10) : item.opacity,
            }}
          >
            <item.Icon size={item.size} strokeWidth={1} />
          </span>
        ))}
      </div>

      <svg className="pc-mesh" viewBox="0 0 400 400" preserveAspectRatio="none">
        <line x1="0" y1="80" x2="400" y2="120" className="pc-mesh-line" style={{ '--mesh-delay': '0s' }} />
        <line x1="50" y1="0" x2="350" y2="200" className="pc-mesh-line" style={{ '--mesh-delay': '1s' }} />
        <line x1="400" y1="0" x2="0" y2="300" className="pc-mesh-line" style={{ '--mesh-delay': '2s' }} />
        <line x1="200" y1="0" x2="100" y2="400" className="pc-mesh-line" style={{ '--mesh-delay': '3s' }} />
        <line x1="0" y1="200" x2="400" y2="350" className="pc-mesh-line" style={{ '--mesh-delay': '0.5s' }} />
        <line x1="300" y1="0" x2="380" y2="400" className="pc-mesh-line" style={{ '--mesh-delay': '1.5s' }} />
        <circle cx="80" cy="90" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '0s' }} />
        <circle cx="320" cy="140" r="2.5" className="pc-mesh-dot" style={{ '--mesh-delay': '1s' }} />
        <circle cx="200" cy="60" r="1.5" className="pc-mesh-dot" style={{ '--mesh-delay': '2s' }} />
        <circle cx="150" cy="220" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '3s' }} />
        <circle cx="350" cy="280" r="2" className="pc-mesh-dot" style={{ '--mesh-delay': '0.5s' }} />
        <circle cx="50" cy="300" r="1.5" className="pc-mesh-dot" style={{ '--mesh-delay': '1.5s' }} />
      </svg>

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
                  style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                  href={paper.scopusCitedByUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`${paper.citationCount} ${isEnglish ? 'citations on Scopus' : 'citas en Scopus'}`}
                >
                  {paper.citationCount} {isEnglish ? 'Citations on Scopus' : 'Citas en Scopus'}
                </a>
              ) : (
                <span className="pc-citations" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {paper.citationCount} {isEnglish ? 'Citations' : 'Citas'}
                </span>
              )}
            </>
          )}
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px', fontSize: '11px', fontWeight: '500' }}>
          {isPreprint ? (
             <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
               <FileText size={12} /> Preprint
             </span>
           ) : (
             <>
               <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#3b82f6', background: 'rgba(59, 130, 246, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
                 <BadgeCheck size={12} /> Verified
               </span>
               {paper.doi && (
                 <a 
                   href={`https://doi.org/${paper.doi}`} 
                   target="_blank" 
                   rel="noopener noreferrer"
                   style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#8b5cf6', background: 'rgba(139, 92, 246, 0.1)', padding: '2px 6px', borderRadius: '4px', textDecoration: 'none' }}
                   onClick={(e) => e.stopPropagation()}
                 >
                   <ExternalLink size={12} /> DOI
                 </a>
               )}
             </>
          )}

          {isOpenAccess ? (
             <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
               <Unlock size={12} /> {openAccessLabel}
             </span>
          ) : (
             <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>
               <Lock size={12} /> {isEnglish ? 'Subscription' : 'Suscripción'}
             </span>
          )}
        </div>
        
        {paperTopicTags.length > 0 && (
          <div className="pc-semantic-tags" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
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
                      navigate(`/explorer/project/${encodeURIComponent(project.code)}?name=${encodeURIComponent(project.acronym)}&funder=${encodeURIComponent(project.funder)}&arxivId=${paperId}`);
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
          <div className="pc-author-names" style={{ position: 'relative' }}>
            {(paper.authors || []).slice(0, 3).map((author, index) => (
               <span
                 key={index}
                 onClick={(e) => {
                   e.stopPropagation(); 
                   const pId = paper.id.startsWith('arxiv:') ? paper.id.split(':')[1] : paper.id;
                   navigate(`/explorer/author/${encodeURIComponent(author.name || author)}?arxivId=${pId}`); 
                 }}
                 style={{ cursor: 'pointer', padding: '4px 0' }}
                 onMouseOver={(e) => e.currentTarget.style.textDecoration = 'underline'}
                 onMouseOut={(e) => e.currentTarget.style.textDecoration = 'none'}
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
        >
          <p>
            {hasUsableAIAbstract(paper.abstract)
              ? <ScientificText>{paper.abstract}</ScientificText>
              : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
          </p>
        </div>

        {researchResources.length > 0 && (
          <div className="pc-linked-resources" aria-label={isEnglish ? 'Associated research resources' : 'Recursos de investigación asociados'}>
            <span className="pc-linked-resources-label"><Database size={14} /> {isEnglish ? 'Resources' : 'Recursos'}</span>
            <div className="pc-linked-resources-list">
              {researchResources.map(resource => {
                const config = RESOURCE_KIND_CONFIG[resource.kind] || RESOURCE_KIND_CONFIG.material;
                const ResourceIcon = config.Icon;
                const resourceLabel = config.label[language];
                return (
                  <a
                    key={resource.id}
                    className={`pc-linked-resource pc-linked-resource--${resource.kind}`}
                    href={resource.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    title={resource.title}
                    aria-label={`${resourceLabel}: ${resource.title}`}
                  >
                    <ResourceIcon size={13} />
                    <span>{resourceLabel}</span>
                    <ExternalLink size={11} />
                  </a>
                );
              })}
            </div>
          </div>
        )}

        <div className="pc-action-bar">
          <button 
            className="pc-read-btn"
            onClick={handleOpenPaper}
            disabled={isResolvingAccess}
          >
            {isResolvingAccess ? <Loader2 className="spinning" size={18} /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>}
            <span>{primaryActionLabel}</span>
          </button>
          <button
            className="pc-read-btn pc-read-btn--secondary"
            onClick={(e) => { 
              e.stopPropagation(); 
              const url = bestAvailableUrl || (paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '');
              if (navigator.share) {
                navigator.share({ title: paper.title, url });
              } else {
                navigator.clipboard.writeText(url);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            {copied
              ? <><Check size={16} /><span className="pc-share-label">{isEnglish ? 'Copied' : 'Copiado'}</span></>
              : <><Share2 size={16} /><span className="pc-share-label">{isEnglish ? 'Share' : 'Compartir'}</span></>}
          </button>
          {canRequestAIExplanation && (
            <button
              className="pc-ai-btn"
              onClick={(event) => { event.stopPropagation(); setShowAIExplanation(true); }}
              aria-label={isEnglish ? 'Explain this paper with AI' : 'Explicar este paper con IA'}
              title={isEnglish ? 'Explain with AI' : 'Explicar con IA'}
            >
              <Sparkles size={17} />
              <span className="pc-ai-label pc-ai-label--full">{isEnglish ? 'Explain with AI' : 'Explicar con IA'}</span>
              <span className="pc-ai-label pc-ai-label--short">{isEnglish ? 'Explain' : 'Explicar'}</span>
            </button>
          )}
          {(paper.doi || paper.arxivId || paper.semanticScholarId) && (
            <button
              className="pc-related-btn"
              onClick={(event) => { event.stopPropagation(); setShowRelated(true); }}
              aria-label={isEnglish ? 'View related papers' : 'Ver papers relacionados'}
              title={isEnglish ? 'Related papers' : 'Papers relacionados'}
            >
              <Network size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Side actions (TikTok style) */}
      <div className="pc-side-actions">
        <button className={`pc-side-btn ${isLiked ? 'pc-side-btn--liked' : ''}`} onClick={handleLike}>
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isLiked ? '#ff2d55' : 'none'} stroke={isLiked ? '#ff2d55' : 'currentColor'} strokeWidth="2" style={isLiked ? { filter: 'drop-shadow(0 0 8px rgba(255, 45, 85, 0.6))' } : {}}>
              <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
            </svg>
          </div>
          <span style={isLiked ? { color: '#ff2d55' } : {}}>{isEnglish ? 'Like' : 'Me gusta'}</span>
        </button>

        <button className={`pc-side-btn ${isSaved ? 'pc-side-btn--saved' : ''}`} onClick={(e) => { e.stopPropagation(); onSaveToList(paper); }}>
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill={isSaved ? '#ffd60a' : 'none'} stroke={isSaved ? '#ffd60a' : 'currentColor'} strokeWidth="2" style={isSaved ? { filter: 'drop-shadow(0 0 8px rgba(255, 214, 10, 0.6))' } : {}}>
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <span style={isSaved ? { color: '#ffd60a' } : {}}>{isEnglish ? 'Save' : 'Guardar'}</span>
        </button>

        <button className={`pc-side-btn ${isReadActive ? 'pc-side-btn--read' : ''}`} onClick={handleMarkAsRead}>
          <div className="pc-side-icon">
            {isReadActive ? <CheckCircle2 size={24} color="#10b981" /> : <Eye size={24} />}
          </div>
          <span style={{ fontSize: '10px', textAlign: 'center', lineHeight: '1.2' }}>
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
          <div className="pc-side-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          </div>
          <span>{isEnglish ? 'Skip' : 'Pasar'}</span>
        </button>
      </div>

      {/* Double-tap heart */}
      {showHeart && (
        <div className="pc-heart-burst">
          <svg viewBox="0 0 24 24" fill="#ff2d55" width="90" height="90">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          <div className="pc-heart-ring" />
        </div>
      )}

      {/* Scroll hint on first card */}
      {!hideScrollHint && (
        <div className="pc-scroll-hint">
          <div className="pc-scroll-hint-arrow">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>
      )}

      <AnimatePresence>
        {showAuthorsModal && (
          <motion.div 
            className="pc-authors-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={(e) => { e.stopPropagation(); setShowAuthorsModal(false); }}
          >
            <motion.div 
              className="pc-authors-modal-sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="pc-authors-modal-header">
                <h3>{isEnglish ? 'Authors' : 'Autores'}</h3>
                <button onClick={() => setShowAuthorsModal(false)}>
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
                      navigate(`/explorer/author/${encodeURIComponent(authorStr)}?arxivId=${paper.arxivId || ''}`);
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
          onSelectPaper={selectRelatedPaper}
        />,
        document.body,
        `papertok-related-sheet:${getRelatedPaperIdentity(paper) || 'current'}`,
      )}
      {showAIExplanation && createPortal(
        <AIExplanationSheet paper={aiExplanationPaper} onClose={() => setShowAIExplanation(false)} />,
        document.body,
        'papertok-ai-explanation',
      )}
      {isHydratingRelatedPaper && createPortal(
        <div className="related-card-overlay related-card-overlay--loading" role="status" aria-live="polite" aria-busy="true">
          <AnimatedAtom size={62} strokeWidth={1} className="related-card-loading-atom" />
          <p>{isEnglish ? 'Preparing the paper…' : 'Preparando el paper…'}</p>
        </div>,
        document.body,
        'papertok-related-card-loading',
      )}
      {selectedRelatedPaper && createPortal(
        <div
          className={`related-card-overlay ${isClosingRelatedCard ? 'is-closing' : ''}`}
          onAnimationEnd={handleRelatedCardAnimationEnd}
          onAnimationCancel={handleRelatedCardAnimationEnd}
        >
          <button
            className="related-card-back"
            onClick={closeRelatedCard}
            aria-label={isEnglish ? 'Back to previous paper' : 'Volver al paper anterior'}
            title={isEnglish ? 'Back' : 'Volver'}
          >
            <ArrowLeft size={22} />
          </button>
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
            getInteractionState={getInteractionState}
            hideScrollHint
          />
        </div>,
        document.body,
        `papertok-related-card:${getRelatedPaperIdentity(selectedRelatedPaper) || 'selected'}`,
      )}
    </div>
  );
});

export default PaperCard;
