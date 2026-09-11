import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, X, Share2, ExternalLink, Filter, SlidersHorizontal, ChevronRight, ChevronDown, BadgeCheck, Check, FileText, Briefcase, Globe, MapPin, BookOpen, Download, Eye, Award, Tag } from 'lucide-react';
import { getEntityById, peekEntity, getWorksByEntity, getAuthorsByEntity, enrichPapersBatch, fetchPapersByDois, getAuthorProfileExact, getAuthorProfileByOrcid, findInstitution, getEntityRecentImpact, getLocalTopicEntity, enrichAuthorInstitutionLocalization } from '../../services/openAlexService';
import { isOpenAlexRateLimitError } from '../../services/openAlexClient';
import { fetchPapersByIds, getAuthorPapers } from '../../services/arxivService';
import { isScopusEnabled, PubmedAdapter, ScopusAdapter, SemanticScholarAdapter } from '../../services/adapters';
import { getPapersByProject, getProjectDetails } from '../../services/openAireService';
import { PaperBuilder } from '../../services/PaperBuilder';
import { extractOrcid, getOrcidRecord } from '../../services/orcidService';
import {
  EXPLORER_ROW_CHUNK,
  entityPapersRequestKey,
  filterAndSortEntityPapers,
  getPaperCitationCount,
  hasKnownPaperCitationCount,
  nextExplorerRowBudget,
  pinSourcePaper,
} from '../../utils/entityExplorer';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useHeightSettle } from '../../hooks/useHeightSettle';
import { useActiveTabRule } from '../../hooks/useActiveTabRule.js';
import { useIsPageArriving } from '../../hooks/usePageArrival.js';
import { useOverlayHistory } from '../../hooks/useOverlayHistory.js';
import { CATEGORIES } from '../../data/categories';
import { areaAccentForCategory as getAreaGradient, areaAccentForPaper, areaLabelForPaper } from '../../utils/areaAccent.js';
import { explorerSkeletonShape, hasAuthorsTab } from '../../utils/explorerSkeletonShape.js';
import { handedEntityFor } from '../../utils/explorerHandover.js';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Button } from '../ui/button.jsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu.jsx';
import { Input } from '../ui/input.jsx';
import { Label } from '../ui/label.jsx';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../ui/sheet.jsx';
import { Switch } from '../ui/switch.jsx';
import { Toggle } from '../ui/toggle.jsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.jsx';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.jsx';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import PaperCard from '../Feed/PaperCard';
import PaperOverlay from '../Feed/PaperOverlay';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';
import RecentImpactStat from './RecentImpactStat';
import { ExplorerEmptyState } from './ExplorerEmptyState.jsx';
import { pickEmptyVariant } from './explorerEmptyVariant.js';
import { normalizeScientificMarkup } from '../../utils/latex';
import { isOpaqueQueryTopicText, resolveQueryTopicRoute } from '../../utils/topicNavigation';
import { scoreQueryTopicPaper } from '../../utils/queryTopicSearch.js';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { settleWithin } from '../../utils/asyncTiming';
import { fetchTopicPapers } from '../../services/topicRetrievalService.js';
import { getEntityWikiInfo } from '../../services/wikiService';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import { getProjectDisplayName } from '../../utils/entityMetadata.js';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { safeExternalUrl } from '../../utils/externalUrl.js';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { getPublicEntityPath, getPublicEntityUrl } from '../../utils/publicNavigation.js';
import 'katex/dist/katex.min.css';
import './EntityExplorer.css';

const ENTITY_PRIMARY_RENDER_BUDGET_MS = 7000;
const ENTITY_SUPPLEMENT_RENDER_BUDGET_MS = 3500;

// The experience panel arrives open by default (2026-09-04) — up to this many
// rows. Measured on an author with a long history opened from the feed: 590px
// of panel, the tab strip pushed 1108px in 710ms. Past this the panel arrives
// folded and the chevron by the name opens it on the reader's own press.
const EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS = 4;

// The ORCID experience panel's collapse. What travels is the page under
// the panel, and it has to land, so the space rides a gentle ease-in-out
// while the contents leave on the house exit curve. 300ms because this
// is a click's answer — the reader is waiting on it.
//
// The curve itself was chosen by measurement on the Wikipedia fold, back when
// that one still closed its own height (four probe runs, written up in
// `plans/README.md`): what a collapse costs the reader is its worst single
// frame — travel × steepness ÷ frames — not its duration, and a steep
// ease-in-out given too few frames measured WORSE than the front-loaded curve
// it replaced. Shortening this is no free way to make it feel quicker.
const EXPERIENCE_FOLD_OUT = {
  opacity: { duration: 0.16, ease: [0.4, 0, 1, 1] },
  height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
};


/**
 * The ORCID card before it has a name in it.
 *
 * Written once and used twice — by the page's own skeleton while the entity is
 * resolving, and by the ORCID fetch that follows it — because the two run back
 * to back on an author page and any difference between them is a step the
 * reader watches happen. It reserves the card's header and nothing else: that
 * is the part every verified profile has, and the three body lines this used
 * to show were promising a biography most authors do not have, reserving 148px
 * against the 96px that arrives.
 */
const OrcidCardSkeleton = () => (
  <div className="orcid-skeleton" aria-hidden="true">
    <div className="orcid-skeleton-header">
      <div className="ex-skel ex-skel-avatar" />
      <div className="ex-skel-stack">
        <div className="ex-skel ex-skel-sub ex-skel-sub--short" />
        <div className="ex-skel ex-skel-sub ex-skel-orcid-id" />
      </div>
      <div className="ex-skel ex-skel-orcid-action" />
    </div>
  </div>
);

/**
 * The project's summary box before the grant has answered. The live box is
 * three clamped lines of serif at 0.9375rem/1.6 and a show-more toggle, in a
 * box padded 16/16/10 — the same line box `.ehc-wiki-skeleton` already
 * reserves for the Wikipedia paragraph, so it borrows those rows: three of
 * prose and one for the toggle, 16 + 96 + 10 = 122px, which is what landed
 * (measured at 390px). Unreserved, the summary was 122 of the 276px a project
 * hero grew by at the handover.
 */
const ProjectSummarySkeleton = () => (
  <div className="project-summary-box project-summary-box--reserved" aria-hidden="true">
    <div className="ehc-wiki-skeleton">
      <span />
      <span />
      <span />
      <span className="ehc-wiki-skeleton-toggle" />
    </div>
  </div>
);

const handleActivationKey = (event, action) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
};

const ROR_RELATION_LABELS = {
  es: {
    parent: 'Parte de',
    child: 'Incluye',
    related: 'Relacionada',
    predecessor: 'Predecesora',
    successor: 'Sucesora',
  },
  en: {
    parent: 'Part of',
    child: 'Includes',
    related: 'Related',
    predecessor: 'Predecessor',
    successor: 'Successor',
  },
};

export default function EntityExplorer({
  onSaveToList = () => {},
  publicMode = false,
  onAuthRequired = () => {},
  // Under the app's own bar — App.jsx decides, the same way it decides to
  // render the bar — the page starts below it instead of at the top edge.
  appChrome = false,
}) {
  const { type, id } = useParams();
  const appChromeClass = appChrome ? ' explorer--app' : '';
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  // While the route transition is still moving this page, the settle stands
  // down: see the measurement in usePageArrival.js.
  const isPageArriving = useIsPageArriving();
  const { language, isEnglish, locale } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const [searchParams] = useSearchParams();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    interactionIdFor, toggleLike, markNotInterested, markAsRead, unmarkAsRead, trackViewTime, trackSkip,
  } = useFeed();

  // A page can be born live three ways: with the entity a search row handed
  // over in router state (`explorerHandover.js` — measured before this, an
  // author picked from the palette arrived as a skeleton and collapsed 113px,
  // 156px on a phone while the page was still sliding in); as a local topic,
  // resolved from CATEGORIES; or as a free-text topic, resolved from the
  // route. None has a fetch behind it. Born loading instead, the page painted
  // the skeleton for a frame and settled from its height to the real one — a
  // wait that never happened, animated. The effect below still fetches the
  // full record; for a handed entity that is an upgrade, never a wait.
  const location = useLocation();
  const handedEntity = useMemo(() => handedEntityFor(type, id, location.state), [id, location.state, type]);
  const localTopic = useMemo(
    () => (type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null),
    [id, type],
  );
  // The fourth way to be born live (2026-09-09): the record is already in the
  // persistent cache. Measured on a warm institution, born loading instead:
  // the skeleton for 30 ms — two frames — then the hero replacing it, which
  // reads as a flash rather than as a wait. The handed entity still wins when
  // both exist; it is the fresher of the two. The load effect below runs
  // either way and upgrades the record.
  const cachedEntity = useMemo(() => peekEntity(type, id), [id, type]);
  const bornResolved = Boolean(handedEntity) || Boolean(localTopic) || Boolean(cachedEntity) || (type === 'topic' && isOpaqueQueryTopicText(id));
  const [entity, setEntity] = useState(() => (bornResolved ? (handedEntity || localTopic || cachedEntity || resolveQueryTopicRoute(id, searchParams)) : null));
  const [entityError, setEntityError] = useState(null);
  const [entityReloadKey, setEntityReloadKey] = useState(0);
  const [papers, setPapers] = useState([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(() => !bornResolved);
  // True from the start, and re-armed by every entity load: the live page's
  // first frame comes before the effect that requests the papers, and with
  // this false that frame showed the empty-state copy — "no results matched"
  // — between the hero landing and the rows' shapes taking over.
  const [isLoadingPapers, setIsLoadingPapers] = useState(true);
  const [papersError, setPapersError] = useState(null);
  const [papersReloadKey, setPapersReloadKey] = useState(0);
  const [sortBy, setSortBy] = useState('cited_by_count:desc');
  
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfPaperToView, setPdfPaperToView] = useState(null);
  // Back closes this PDF viewer instead of leaving PaperTok: see useOverlayHistory.js.
  // Through the viewer's own close, the one the X uses — it owns `open` and
  // reports back only when its leave has played; `setPdfPaperToView(null)` is
  // just the fallback for before the lazy chunk has mounted.
  const pdfCloseRef = useRef(null);
  const requestPdfClose = useCallback(() => {
    if (pdfCloseRef.current) pdfCloseRef.current();
    else setPdfPaperToView(null);
  }, []);
  useOverlayHistory(Boolean(pdfPaperToView), requestPdfClose, 'pdf');
  const closeSelectedPaper = useCallback(() => setSelectedPaper(null), []);

  // The paper the overlay is SHOWING, which outlives the one selected. Closing
  // sets `selectedPaper` to null to start the leave; if the card went with it,
  // the surface would spend its 200ms exit fading out over nothing. This is
  // dropped when the leave actually ends (`onExitComplete`).
  //
  // Adjusted during render rather than in an effect: a paper opened while
  // another is still leaving has to take over in the same commit, or the
  // window shows the wrong paper for a frame.
  const [shownPaper, setShownPaper] = useState(null);
  if (selectedPaper && selectedPaper !== shownPaper) {
    setShownPaper(selectedPaper);
  }

  const [wikiInfo, setWikiInfo] = useState(null);
  const [settledWikiRequestKey, setSettledWikiRequestKey] = useState('');
  // Whether this entity's Wikipedia block has opened. Once it has, a re-lookup
  // (the language changed, a localized name landed) keeps it mounted on its
  // rows instead of folding it out and in — see `showWikiBlock`.
  const [wikiBlockOpened, setWikiBlockOpened] = useState(false);
  // The fold's removal is `AnimatePresence`'s own state update, which never
  // reaches this component — so the ~155px the block was holding would drop in
  // an unanimated reflow after its fade. Bumping this on `onExitComplete` gives
  // the settle the commit it needs: it remembered the height WITH the block on
  // the commit that started the exit, and animates from there to the short one.
  const [wikiFoldExits, setWikiFoldExits] = useState(0);
  const [loadedWikiImageUrl, setLoadedWikiImageUrl] = useState('');
  const [orcidInfo, setOrcidInfo] = useState(null);
  const [isLoadingOrcid, setIsLoadingOrcid] = useState(false);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  // True once a fresh-page load has run past 4s with nothing on screen but
  // the skeleton rows — a project's first page can take close to 17s
  // (OpenAIRE's own budget, then arXiv enrichment and DOI lookups) — so the
  // reader gets a word for what is being waited on instead of a silent wait.
  const [isPapersLoadSlow, setIsPapersLoadSlow] = useState(false);
  // How many rows of the list are mounted (utils/entityExplorer.js says why
  // it is not all of them at once).
  const [rowBudget, setRowBudget] = useState(EXPLORER_ROW_CHUNK);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const observerRef = useRef(null);
  const papersRequestRef = useRef(null);

  const [activeTab, setActiveTab] = useState('papers');
  // Whether the Authors tab has been opened on this entity. The list is
  // requested then and kept from then on; `activeTab` no longer drives the
  // fetch, so leaving the tab does not cancel it and coming back does not
  // repeat it.
  const [authorsOpened, setAuthorsOpened] = useState(false);
  // Open by default: the experience is the answer to "who is this person", which
  // is what the page is for. Hiding it behind the briefcase made the page open
  // on numbers alone and left the one human fact a click away. The toggle stays,
  // so it can still be folded out of the way.
  const [isExperienceOpen, setIsExperienceOpen] = useState(true);
  // Whether the reader has toggled the panel since this ORCID record arrived.
  // On arrival the panel mounts already open, and it must mount at its full
  // height: the hero body's `useHeightSettle` measures its `to` in that same
  // commit, and a panel still at `height: 0` under framer's entrance made it
  // measure 130px short — WAAPI then clamped the box for 360ms while framer
  // grew the panel inside it, and the box snapped +130px the frame the settle
  // released (measured on a phone: 650 → 780 in one frame, after two settles
  // in opposite directions). One box, one owner: the settle carries arrival;
  // framer's entrance is for the reader's own toggle.
  const [experienceToggled, setExperienceToggled] = useState(false);
  const [expandedSummary, setExpandedSummary] = useState(false);
  const [participantsExpanded, setParticipantsExpanded] = useState(false);
  const [isWikiDescriptionExpanded, setIsWikiDescriptionExpanded] = useState(false);
  const [projectSummaryExpandedHeight, setProjectSummaryExpandedHeight] = useState(0);
  const [wikiDescriptionExpandedHeight, setWikiDescriptionExpandedHeight] = useState(0);
  const [isProjectSummaryExpandable, setIsProjectSummaryExpandable] = useState(false);
  const [isWikiDescriptionExpandable, setIsWikiDescriptionExpandable] = useState(false);
  const [resolvingParticipant, setResolvingParticipant] = useState(null);
  const [participantNavigationError, setParticipantNavigationError] = useState('');
  const [isResolvingAuthorInstitution, setIsResolvingAuthorInstitution] = useState(false);
  const [authorInstitutionNavigationError, setAuthorInstitutionNavigationError] = useState('');
  const [recentImpact, setRecentImpact] = useState(null);
  const [isLoadingRecentImpact, setIsLoadingRecentImpact] = useState(false);
  const [recentImpactError, setRecentImpactError] = useState(null);
  
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    category: '',
    peerReviewed: false,
    dateRange: ''
  });

  const [entityAuthors, setEntityAuthors] = useState([]);
  const [isLoadingAuthors, setIsLoadingAuthors] = useState(false);
  const [authorsError, setAuthorsError] = useState(null);
  const [authorsReloadKey, setAuthorsReloadKey] = useState(0);
  const [isFetchingMoreAuthors, setIsFetchingMoreAuthors] = useState(false);
  const [authorsPage, setAuthorsPage] = useState(1);
  const [hasMoreAuthors, setHasMoreAuthors] = useState(false);
  const observerAuthorsRef = useRef(null);
  const viewedEntityRef = useRef('');
  const projectSummaryTextRef = useRef(null);
  const wikiDescriptionTextRef = useRef(null);
  const localizedTopicEntity = useMemo(
    () => entity?._localTopic ? getLocalTopicEntity(entity.id || id, language) : null,
    [entity, id, language],
  );
  const entityOfficialName = localizedTopicEntity?.display_name || entity?.display_name || '';
  const entityDisplayName = type === 'institution'
    ? getLocalizedInstitutionName(entity, language)
    : entityOfficialName;
  const publicEntityPath = useMemo(
    () => entity ? getPublicEntityPath(type, id) : null,
    [entity, id, type],
  );
  // The entity's research field, resolved to a flat ink colour so the header
  // rule, type label and tinted marks read as the field rather than chrome.
  const entityAccent = useMemo(() => getAreaGradient(
    entity?.categoryIds?.[0] || entity?.categories?.[0] || entity?.primaryCategory || '',
  ), [entity]);
  const publicEntityUrl = useMemo(
    () => entity ? getPublicEntityUrl(type, id) : null,
    [entity, id, type],
  );
  const metadataConfig = useMemo(() => {
    if (!entity || !entityDisplayName || !publicEntityPath) return { noIndex: true };
    const typeLabel = {
      author: { en: 'Author', es: 'Autor' },
      institution: { en: 'Institution', es: 'Institución' },
      project: { en: 'Research project', es: 'Proyecto de investigación' },
      source: { en: 'Scientific journal', es: 'Revista científica' },
      concept: { en: 'Research topic', es: 'Tema de investigación' },
      topic: { en: 'Research topic', es: 'Tema de investigación' },
    }[type] || { en: 'Scientific entity', es: 'Entidad científica' };

    return {
      title: {
        en: `${entityDisplayName} - ${typeLabel.en} | PaperTok`,
        es: `${entityDisplayName} - ${typeLabel.es} | PaperTok`,
      },
      description: {
        en: `Explore scientific papers, citations, and research connected to ${entityDisplayName} on PaperTok.`,
        es: `Explora artículos científicos, citas e investigación relacionada con ${entityDisplayName} en PaperTok.`,
      },
      route: publicEntityPath,
      ogType: 'profile',
    };
  }, [entity, entityDisplayName, publicEntityPath, type]);
  usePublicPageMetadata(metadataConfig);

  const analyticsEntityType = ['author', 'institution', 'project'].includes(type)
    ? type
    : ['topic', 'concept'].includes(type)
      ? 'topic'
      : 'other';
  const navigateToEntity = useCallback((nextType, nextId) => {
    if (publicMode) {
      const publicPath = getPublicEntityPath(nextType, nextId);
      if (publicPath) navigate(publicPath);
      return;
    }
    navigate(`/explorer/${nextType}/${encodeURIComponent(nextId)}`);
  }, [navigate, publicMode]);
  // What the masthead can say before the entity answers: the `?name=` a link
  // hands over (an author opened by OpenAlex id, a project), or the name the
  // route is keyed by when an author is opened by name.
  const seedName = useMemo(() => {
    const handed = (searchParams.get('name') || '').trim();
    if (handed) return handed;
    if (type === 'author' && !/^A\d+$/i.test(id) && !/openalex\.org\/A\d+/i.test(id) && !extractOrcid(id)) {
      return String(id || '').trim();
    }
    return '';
  }, [id, searchParams, type]);
  const handleBack = useCallback(() => {
    const historyIndex = typeof window !== 'undefined' ? window.history.state?.idx : null;
    if (Number.isInteger(historyIndex) && historyIndex > 0) navigate(-1);
    else navigate('/');
  }, [navigate]);
  // The first visit to Authors requests the list and keeps it from then on, so
  // a return to the tab finds the rows rather than a second skeleton. The
  // loading flag goes up here, with the tab, rather than in the effect that
  // fetches: the frame the tab opens on then already shows the rows' shapes
  // and never the empty-state copy.
  const openTab = useCallback((tab) => {
    setActiveTab(tab);
    if (tab === 'authors' && !authorsOpened) {
      setAuthorsOpened(true);
      setIsLoadingAuthors(true);
    }
  }, [authorsOpened]);
  const authorInstitution = type === 'author'
    ? entity?.institutionData || entity?.last_known_institutions?.[0] || (entity?.institution ? { display_name: entity.institution } : null)
    : null;
  const authorInstitutionDisplayName = getLocalizedInstitutionName(authorInstitution, language);
  const wikiRequestKey = `${entityReloadKey}:${language}:${type}:${entityDisplayName}`;
  const visibleWikiInfo = wikiInfo?._requestKey === wikiRequestKey ? wikiInfo : null;
  const safeRorUrl = safeExternalUrl(entity?.ror);
  const safeProjectWebsiteUrl = safeExternalUrl(entity?.websiteUrl);
  const safeWikiUrl = safeExternalUrl(visibleWikiInfo?.url);
  const safeHomepageUrl = safeExternalUrl(entity?.homepage_url);
  const canLoadWikiInfo = Boolean(
    entityDisplayName && ['institution', 'concept', 'topic', 'source'].includes(type),
  );
  const isWikiRequestPending = canLoadWikiInfo && settledWikiRequestKey !== wikiRequestKey;
  const topicFallbackDescription = ['concept', 'topic'].includes(type)
    ? localizedTopicEntity?.description
      || (typeof entity?.description === 'string' ? entity.description : '')
    : '';
  // The local description — a category's tagline, an OpenAlex topic's own
  // sentence — is what the block shows once Wikipedia has MISSED, not a first
  // draft to show while it is being asked. Painted as prose with the request
  // still in flight, the box took two heights in a row and the hero settled
  // twice (measured from cold at 1280×900 with `explorer-hero-frames.mjs`: on
  // T11090 the body went 109 → 170px when the OpenAlex description landed,
  // held still for 450ms, then 170 → 243px when Wikipedia did; on hep-ph,
  // born with the tagline at 58px, one 97px settle the moment the paragraph
  // came). Held on the grey rows until the request settles, the box moves
  // once, and by 9px (146 → 155): the rows are measured to the paragraph's
  // own line box for exactly this.
  const wikiDescription = isWikiRequestPending ? '' : (visibleWikiInfo?.extract || topicFallbackDescription);

  // The block opens the first time its lookup settles WITH content — never on
  // `homepage_url` alone while the prose is still out, which would settle the
  // box twice — and stays open from then on through a re-lookup, holding its
  // rows until the new paragraph replaces them in place. Closed only by a
  // settled lookup that finds nothing. Adjusted during render, the documented
  // way to derive state from a prop, so the settling commit is the opening one.
  const wikiHasContent = Boolean(wikiDescription || entity?.homepage_url);
  if (!isWikiRequestPending && wikiHasContent && !wikiBlockOpened) setWikiBlockOpened(true);
  const showWikiBlock = wikiBlockOpened && (wikiHasContent || isWikiRequestPending);
  const hasLoadedWikiImage = Boolean(
    visibleWikiInfo?.thumbnail && loadedWikiImageUrl === visibleWikiInfo.thumbnail,
  );

  // The hero's body settles between its sizes instead of snapping. What it
  // holds arrives in pieces — the skeleton's reservation, the profile, the
  // ORCID card, the Wikipedia paragraph, the impact score — and each one can
  // change its height. Measured on an author opened from a card (390×844):
  // the skeleton stood 550px tall and the live hero 400px, so the tabs and
  // the list jumped 150px in one frame the moment the profile answered. The
  // same ref rides on the skeleton's body and on the live one, so that
  // handover is a settle like the rest. The body, not the whole hero: the tab
  // strip sits inside the hero after the body, and with the outer box
  // animated the strip snapped to its new place while the box closed over
  // it (measured: tabs 515 → 451 in one frame under a 200 ms settle).
  // The tab strip's travelling rule (see the strip below for why). The row is
  // held in STATE, not a ref: the live strip does not exist while the entity
  // loads, and a ref would be read once as null and never again.
  const [tabsRow, setTabsRow] = useState(null);
  const tabRule = useActiveTabRule(tabsRow, `${activeTab}:${isEnglish}`, '.ee-tab.active');

  const heroBodyRef = useRef(null);
  useHeightSettle(
    heroBodyRef,
    // Everything that changes this box's height and is worth a movement. The
    // Wikipedia block's three are here on purpose: for two days they were
    // deliberately left out so the fold could animate its own height, and the
    // settle grew a latch, a re-sync and a hand-over to stay out of its way —
    // measured 2026-09-09, that machinery was the bug. One owner: the block's
    // contents fade in, and its SPACE is carried here like the ORCID card's.
    [isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage, showWikiBlock, wikiDescription, isWikiRequestPending, wikiFoldExits],
    // A gentle ease-in-out rather than the hook's expo-out default. What
    // travels here is everything under the hero — the tab strip, the list —
    // and on a phone a 268px ORCID arrival on the expo-out spent 70px of it
    // in a single frame. The page has to land, not appear.
    // Not while the page is arriving. A settle carries a datum that lands late
    // on a page at rest; under a route transition it is a second owner of the
    // same displacement, on a different clock. Measured stepping back from an
    // author to its institution: four settles in 76ms, each restarting a full
    // 360ms, and the tab strip dipping 16px instead of being where it was left.
    { enabled: !prefersReducedMotion, suspended: isPageArriving, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );

  const getInteractionState = useCallback((paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);

  useEffect(() => {
    if (!entity) return;
    const viewKey = `${type}:${id}`;
    if (viewedEntityRef.current === viewKey) return;
    viewedEntityRef.current = viewKey;
    trackEvent('select_content', { content_type: analyticsEntityType, surface: 'explorer' });
  }, [analyticsEntityType, entity, id, trackEvent, type]);

  const measureExpandableDescriptions = useCallback(() => {
    const measure = (element, setHeight, setExpandable) => {
      if (!element) return;
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      const collapsedHeight = Number.isFinite(lineHeight) ? lineHeight * 3 : element.clientHeight;
      setHeight(element.scrollHeight);
      setExpandable(element.scrollHeight > collapsedHeight + 1);
    };

    measure(projectSummaryTextRef.current, setProjectSummaryExpandedHeight, setIsProjectSummaryExpandable);
    measure(wikiDescriptionTextRef.current, setWikiDescriptionExpandedHeight, setIsWikiDescriptionExpandable);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(measureExpandableDescriptions);
    return () => window.cancelAnimationFrame(frame);
  }, [entity?.summary, measureExpandableDescriptions, wikiDescription]);

  // `resize` fires repeatedly on mobile — as the URL bar collapses while
  // scrolling, and again when the soft keyboard opens — and the unthrottled
  // handler forced a synchronous layout (getComputedStyle + scrollHeight) on
  // every single event. Debounced to the trailing edge: each event just
  // reschedules the timer, so only the resize that actually settles pays for
  // a measurement, and the read still lands inside a rAF. `measureExpandableDescriptions`
  // is a stable callback ([] deps), so this effect subscribes once for the
  // component's life rather than resubscribing on every render.
  useEffect(() => {
    let timer = null;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => requestAnimationFrame(measureExpandableDescriptions), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [measureExpandableDescriptions]);

  const followEntity = useMemo(() => {
    if (!entity || !['author', 'institution', 'project', 'concept', 'topic'].includes(type)) return null;
    // An entity we cannot name cannot be followed. A follow is compared by id
    // and then by name, so any word standing in for a missing name becomes a
    // key shared with every other entity the page could not name — and the
    // second one followed would resolve the click against the first. Nothing
    // stands in here: with no name there is no identity, and no heart.
    const displayName = type === 'institution' ? entityOfficialName : entityDisplayName;
    if (!displayName) return null;
    const followType = type === 'concept' ? 'topic' : type;
    const metadata = entity._queryTopic
      ? {
          query: entity.metadata?.query || entity.query,
          source: entity.metadata?.source || 'free-text',
          categoryIds: entity.metadata?.categoryIds || entity.categoryIds || [],
        }
      : {
          funder: entity.funder,
          categoryIds: entity.categoryIds,
          localizedNames: type === 'institution' ? entity.localized_names : undefined,
        };
    return {
      type: followType,
      id: entity.id || entity.code || id,
      displayName,
      source: type === 'project' ? 'openaire' : type === 'concept' || type === 'topic' ? 'papertok' : 'openalex',
      externalIds: {
        orcid: entity.orcid,
        ror: entity.ror,
      },
      metadata,
    };
  }, [entity, entityDisplayName, entityOfficialName, id, type]);
  const entityIsFollowing = Boolean(!publicMode && followEntity && isFollowing(followEntity));
  const entityFollowPending = Boolean(!publicMode && followEntity && isFollowPending(followEntity));

  // Reset overlays when navigating to a different entity
  useEffect(() => {
    setTimeout(() => {
      setSelectedPaper(null);
      setPdfPaperToView(null);
      setOrcidInfo(null);
      setActiveTab('papers');
      setAuthorsOpened(false);
      setIsExperienceOpen(true);
      setExperienceToggled(false);
      setExpandedSummary(false);
      setParticipantsExpanded(false);
    }, 0);
  }, [type, id]);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
      setAuthorsPage(1);
    }, 600);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    setTimeout(() => {
      setPage(1);
      setAuthorsPage(1);
    }, 0);
  }, [type, id, sortBy, filters]);

  useEffect(() => {
    let isCancelled = false;

    async function loadEntity() {
      setEntityError(null);
      const bornWith = handedEntity || cachedEntity;
      if (bornWith) {
        setEntity(bornWith);
        setIsLoadingEntity(false);
      } else {
        setIsLoadingEntity(true);
        setEntity(null);
      }
      setPapers([]);
      setIsLoadingPapers(true);
      setEntityAuthors([]);
      setSearchQuery('');
      setWikiInfo(null);
      setWikiBlockOpened(false);
      setOrcidInfo(null);
      setIsLoadingOrcid(false);
      setIsExperienceOpen(true);
      setExperienceToggled(false);
      setExpandedSummary(false);
      setIsWikiDescriptionExpanded(false);
      setIsProjectSummaryExpandable(false);
      setIsWikiDescriptionExpandable(false);
      setResolvingParticipant(null);
      setParticipantNavigationError('');
      setRecentImpact(null);
      setIsLoadingRecentImpact(false);
      setRecentImpactError(null);
      setShowFilters(false);
      setPapersError(null);
      setAuthorsError(null);

      if (type === 'topic' && isOpaqueQueryTopicText(id)) {
        setEntity(resolveQueryTopicRoute(id, searchParams));
        setIsLoadingEntity(false);
        return;
      }

      // Same shortcut for a local topic on a navigation between entities: the
      // resets above and these two land in one batch, so no skeleton commit
      // paints in between.
      const local = type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null;
      if (local) {
        setEntity(local);
        setIsLoadingEntity(false);
        return;
      }

      if (type === 'project') {
        const name = searchParams.get('name') || '';
        const funder = searchParams.get('funder') || '';

        if (name) {
          // The pill already knows the project's name and funder: paint the
          // hero now, and let it reserve the summary and two stat cells,
          // inside itself, until OpenAIRE answers.
          setEntity({ id, display_name: name, type: 'project', funder, _detailsPending: true });
          setIsLoadingEntity(false);
        }

        // Fetch detailed info
        const details = await getProjectDetails(id, { funder });
        if (isCancelled) return;
        if (details) {
           const displayName = getProjectDisplayName(details);
           setEntity({
             id: id,
             code: details.id || id,
             openaireId: details.openaireId,
             display_name: displayName,
             type: 'project',
             funder: details.funder,
             fundingStream: details.fundingStream,
             summary: details.summary,
             startDate: details.startDate,
             endDate: details.endDate,
             budget: details.budget,
             fundedAmount: details.fundedAmount,
             currency: details.currency,
             callIdentifier: details.callIdentifier,
             contractType: details.contractType,
             subjects: details.subjects,
             participants: details.participants,
             measures: details.measures,
             openAccess: details.openAccess,
             websiteUrl: details.websiteUrl,
           });
        } else {
          // The lookup failed (bad response, parse miss, or thrown error): the
          // hero is already painted (with the pill's name) or was never
          // optimistic (no name at all). Either way, land an entity with no
          // _detailsPending so the reserved summary and two stat cells stop
          // shimmering forever instead of settling — keep the pill's name if
          // there was one.
          //
          // With no name in the URL either, the entity keeps none. A raw
          // `snsf________::daa28096…` is not a title, but neither is a
          // stand-in word a name: `display_name` is what the follow identity
          // is built from, and one stand-in shared by every nameless project
          // made them all the same follow — following one deleted another's
          // document. The hero falls back to the page's own label for the type
          // where it renders the title, in whichever language is on at that
          // moment. And when the route id is an OpenAIRE id it is the one
          // useful thing left to offer: the empty state's link out, which is
          // worth most in exactly this case.
          setEntity({
            id,
            openaireId: id.includes('::') ? id : undefined,
            display_name: name,
            type: 'project',
            funder,
          });
        }
        if (!isCancelled) setIsLoadingEntity(false);
        return;
      }
      
      let data;
      let prefetchedOrcid = null;
      const orcidId = type === 'author' ? extractOrcid(id) : null;
      const isOpenAlexId = /^A\d+$/.test(id) || /openalex\.org\/A\d+/.test(id);
      
      if (orcidId) {
        data = await getAuthorProfileByOrcid(orcidId);
        if (!data) {
          prefetchedOrcid = await getOrcidRecord(orcidId);
          if (prefetchedOrcid?.displayName) {
            data = {
              id: `stub-${orcidId}`,
              display_name: prefetchedOrcid.displayName,
              orcid: `https://orcid.org/${orcidId}`,
              works_count: null,
              cited_by_count: null,
              summary_stats: null,
            };
          }
        }
      } else if (type === 'author' && !isOpenAlexId) {
        const arxivId = searchParams.get('arxivId');
        data = await getAuthorProfileExact(id, arxivId);
      } else {
        data = await getEntityById(type, id);
      }

      if (isCancelled) return;

      if (type === 'author' && data) {
        data = await enrichAuthorInstitutionLocalization(data);
        if (isCancelled) return;
      }
      
      setEntity(data || handedEntity || cachedEntity);
      setIsLoadingEntity(false);

      // Both follow-up requests declare themselves before either starts, in
      // the same batch as the entity, so the live hero mounts with the ORCID
      // card's skeleton and the impact stat's "calculating" already in place.
      // They used to run one after the other, with the ORCID flag raised only
      // once the impact score had answered: the card's reserved space
      // collapsed the frame the hero landed, reopened seconds later, and
      // filled after that — two jumps for the list under it, on every author.
      const wantsRecentImpact = ['institution', 'author'].includes(type) && Boolean(data);
      const wantsOrcid = Boolean(data?.display_name) && type === 'author' && Boolean(data.orcid);
      if (wantsRecentImpact) {
        setIsLoadingRecentImpact(true);
        setRecentImpactError(null);
      }
      if (wantsOrcid) setIsLoadingOrcid(true);

      const loadRecentImpact = async () => {
        try {
          const impact = await getEntityRecentImpact(type, data);
          if (!isCancelled) setRecentImpact(impact);
        } catch (error) {
          if (!isCancelled) {
            setRecentImpactError(
              isOpenAlexRateLimitError(error)
                ? 'rate_limited'
                : error?.code === 'timeout'
                  ? 'timeout'
                  : error?.code === 'network_error'
                    ? 'network_error'
                    : 'unavailable'
            );
            console.error(`Failed to load recent ${type} impact`, error);
          }
        } finally {
          if (!isCancelled) setIsLoadingRecentImpact(false);
        }
      };
      const loadOrcid = async () => {
        try {
          const record = prefetchedOrcid || await getOrcidRecord(data.orcid);
          if (!isCancelled) {
            setOrcidInfo(record);
            setIsExperienceOpen((record?.employments?.length ?? 0) <= EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS);
          }
        } catch (e) {
          if (!isCancelled) console.error("Error loading ORCID", e);
        } finally {
          if (!isCancelled) setIsLoadingOrcid(false);
        }
      };
      await Promise.all([
        wantsRecentImpact ? loadRecentImpact() : null,
        wantsOrcid ? loadOrcid() : null,
      ]);
    }
    loadEntity().catch(error => {
      if (isCancelled) return;
      console.error('Failed to load entity', error);
      // Keep the hero the palette already painted instead of nulling it out
      // — mirrors the success exit above (`setEntity(data || handedEntity)`).
      // `getEntityById` can throw with no network at all (its ROR path
      // does), well after the handed entity is already on screen; the
      // render gate below only shows the full-viewport `.explorer-error`
      // `if (!entity)`, so replacing a hero the reader is looking at would
      // be a worse failure than the fetch itself. A page reached without a
      // handover still falls back to `null` here, correctly: there is
      // genuinely nothing to show.
      // `entityError` is still set even when a handed entity survives it.
      // With entity truthy the full-screen error never renders — nothing
      // today reads this flag while a hero is on screen — but leaving it
      // `null` would be silently pretending the upgrade succeeded. It stays
      // the true record of the failure for `retryEntity`, and for whatever
      // inline notice or telemetry reads it next.
      setEntity(handedEntity || cachedEntity || null);
      setEntityError('ENTITY_LOAD_FAILED');
      setIsLoadingEntity(false);
    });
    return () => {
      isCancelled = true;
    };
  }, [type, id, searchParams, entityReloadKey, handedEntity, cachedEntity]);

  useEffect(() => {
    if (!canLoadWikiInfo) {
      return undefined;
    }

    let isActive = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    const alternateTitle = language === 'en'
      ? localizedTopicEntity?.labelEs
      : localizedTopicEntity?.labelEn;

    getEntityWikiInfo({
      title: entityDisplayName,
      alternateTitle,
      language,
      signal: controller.signal,
      strictTitleMatch: Boolean(entity?._queryTopic),
    }).then(info => {
      if (isActive && !controller.signal.aborted) {
        setWikiInfo(info ? { ...info, _requestKey: wikiRequestKey } : null);
      }
    }).catch(error => {
      if (error?.name !== 'AbortError') console.error('Failed to fetch Wikipedia info', error);
    }).finally(() => {
      window.clearTimeout(timeout);
      if (isActive) setSettledWikiRequestKey(wikiRequestKey);
    });

    return () => {
      isActive = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    canLoadWikiInfo,
    entityDisplayName,
    entity?._queryTopic,
    language,
    localizedTopicEntity?.labelEn,
    localizedTopicEntity?.labelEs,
    type,
    wikiRequestKey,
  ]);

  useEffect(() => {
    if (!entity) return;
    // What this request depends on, so a re-render can be told from a new
    // request. A tab switch used to unmount the list and start the fetch
    // over — `activeTab` was a dependency, and the cleanup cancelled whatever
    // was in flight — so coming back to Papers meant a second skeleton and a
    // second round trip for rows that had already been read. A project paid
    // it once more on its own: its optimistic entity started the request and
    // its details, landing on the same grant code, cancelled and repeated it.
    const requestKey = entityPapersRequestKey({
      type,
      id,
      entity,
      entityDisplayName,
      sortBy,
      page,
      searchQuery: debouncedSearch,
      filters,
      searchParams: searchParams.toString(),
      reloadKey: papersReloadKey,
      entityReloadKey,
    });
    if (papersRequestRef.current?.key === requestKey && !papersRequestRef.current.cancelled) return;
    if (papersRequestRef.current) papersRequestRef.current.cancelled = true;
    const request = { key: requestKey, cancelled: false };
    papersRequestRef.current = request;
    async function loadPapers() {
      if (page === 1) {
        setIsLoadingPapers(true);
        setPapersError(null);
        setRowBudget(EXPLORER_ROW_CHUNK);
        setIsPapersLoadSlow(false);
      }
      else setIsFetchingMore(true);
      
      try {
        let arxivIds = [];
        let dois = [];
        let total = 0;
        let fetchedPapers = [];
        let topicProviderFailure = false;
        // A project's two counts, kept apart because they answer different
        // questions. `projectUsableIds` is how many identifiers OpenAIRE
        // returned for this page; `projectResolvedRows` is how many of them
        // came back as papers. They agree only when every lookup answered,
        // and their zeroes mean opposite things — see the cut further down.
        let projectUsableIds = 0;
        let projectResolvedRows = 0;

        const resolvedId = entity.id || id;

        if (type === 'project') {
           const res = await getPapersByProject(resolvedId, page, { funder: searchParams.get('funder') || entity.funder || '' });
           arxivIds = res.arxivIds;
           dois = res.dois || [];
           // OpenAIRE's total counts every publication of the project, with or
           // without a usable DOI or arXiv id; the ones with neither are
           // already discarded above, so a page that yields none usable does
           // not promise a next one. That verdict is not reached here, though:
           // these identifiers still have to be resolved into papers below,
           // and what OpenAIRE returned is not what the reader ends up seeing.
           projectUsableIds = arxivIds.length + dois.length;
           total = res.total;
        } else if (type === 'author') {
            let papersFromOA = [];
            let arxPapersFromNative = [];
            let primaryError = null;
            const semanticScholarAdapter = new SemanticScholarAdapter();
            const pubmedAdapter = new PubmedAdapter();
            const supplementalPromises = [
              semanticScholarAdapter.search(`"${entity.display_name}"`, page, { type: 'author' }),
              pubmedAdapter.search(`"${entity.display_name}"`, page, { type: 'author' }),
              isScopusEnabled()
                ? new ScopusAdapter().search(entity.display_name, page, { type: 'author', limit: 8 })
                : Promise.resolve({ papers: [] }),
            ];
            const primaryPromise = !resolvedId.startsWith('stub-')
              ? getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity.display_name)
              : getAuthorPapers(entity.display_name, 30);
            const [primaryResult, supplementalResults] = await Promise.all([
              settleWithin(primaryPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
              Promise.all(supplementalPromises.map(sourcePromise => (
                settleWithin(sourcePromise, ENTITY_SUPPLEMENT_RENDER_BUDGET_MS)
              ))),
            ]);

            if (primaryResult.status === 'fulfilled') {
              if (!resolvedId.startsWith('stub-')) {
                papersFromOA = primaryResult.value?.papers || [];
                total = primaryResult.value?.total || 0;
              } else {
                arxPapersFromNative = primaryResult.value || [];
              }
            } else {
              primaryError = primaryResult.reason || new Error('La fuente principal tardó demasiado en responder.');
            }

            const [semanticScholar, pub, scopus] = supplementalResults.map(result => result.status === 'fulfilled' ? result.value?.papers || [] : []);
            
            fetchedPapers.push(...papersFromOA, ...arxPapersFromNative, ...semanticScholar, ...pub, ...scopus);

            const supplementalError = supplementalResults.find(result => result.status === 'rejected')?.reason;
            if (fetchedPapers.length === 0 && (primaryError || supplementalError)) {
              throw primaryError || supplementalError;
            }
            
            if (resolvedId.startsWith('stub-')) {
              total = fetchedPapers.length;
            }
         } else if ((type === 'concept' || type === 'topic') && (entity._localTopic || entity._queryTopic)) {
            const topicResult = await fetchTopicPapers({
              ...entity,
              canonicalId: resolvedId,
              displayName: entityDisplayName,
            }, {
              filters,
              mode: sortBy.includes('publication_date') ? 'recent' : 'relevance',
              page,
              pageSize: 30,
              searchQuery: debouncedSearch,
              sortBy,
              timeoutMs: ENTITY_SUPPLEMENT_RENDER_BUDGET_MS,
            });
            if (topicResult.allFailed) throw new Error('All topic providers timed out.');
            topicProviderFailure = topicResult.partial;
            fetchedPapers.push(...topicResult.papers);
            total = topicResult.hasMore
              ? page * 30 + 1
              : (page - 1) * 30 + fetchedPapers.length;
         } else {
            const primaryResult = await settleWithin(
              getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity.display_name),
              ENTITY_PRIMARY_RENDER_BUDGET_MS,
            );
            if (primaryResult.status !== 'fulfilled') {
              throw primaryResult.reason || new Error('La fuente principal tardó demasiado en responder.');
            }
            const res = primaryResult.value;
            fetchedPapers.push(...(res.papers || []));
            total = res.total;
         }
        
        // Resolve project identifiers concurrently; arXiv availability must not
        // postpone DOI-backed papers that OpenAlex has already returned.
        const arxivPapersPromise = arxivIds.length > 0
          ? Promise.all([
              fetchPapersByIds(arxivIds),
              enrichPapersBatch(arxivIds, { timeoutMs: ENTITY_PRIMARY_RENDER_BUDGET_MS }),
            ]).then(([rawPapers, enrichmentMap]) => rawPapers.map(paper => {
              const enriched = enrichmentMap[paper.id];
              if (!enriched) return paper;
              const merged = PaperBuilder.merge(paper, enriched, 'openalex');
              merged._isOpenAlexEnriched = true;
              return merged;
            }))
          : Promise.resolve([]);
        const doiPapersPromise = dois.length > 0 ? fetchPapersByDois(dois) : Promise.resolve([]);
        const [arxivResult, doiResult] = await Promise.all([
          settleWithin(arxivPapersPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
          settleWithin(doiPapersPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
        ]);
        if (arxivResult.status === 'fulfilled') fetchedPapers.push(...arxivResult.value);
        if (doiResult.status === 'fulfilled') fetchedPapers.push(...doiResult.value);
        
        fetchedPapers = PaperBuilder.deduplicate(fetchedPapers);
        // 3. Guarantee source paper is ALWAYS first in the list
        if (page === 1) {
           const sourceArxivId = searchParams.get('arxivId');
           if (sourceArxivId) {
             const cleanSourceId = sourceArxivId.replace(/v\d+$/, '');
             const sourceIndex = fetchedPapers.findIndex(p => {
               if (!p.id) return false;
               const pClean = p.id.startsWith('arxiv:') ? p.id.split(':')[1] : p.id;
               return pClean.replace(/v\d+$/, '') === cleanSourceId;
             });
             
             if (sourceIndex !== -1) {
               // Paper exists in the list, move it to the front
               const [sourcePaper] = fetchedPapers.splice(sourceIndex, 1);
               fetchedPapers.unshift(sourcePaper);
             } else {
               // Paper is missing, fetch it and put it in front
               try {
                 const sourcePaperReq = await fetchPapersByIds([cleanSourceId]);
                 if (sourcePaperReq && sourcePaperReq.length > 0) {
                   fetchedPapers.unshift(sourcePaperReq[0]);
                 }
               } catch (e) {
                 console.error("Failed to fetch source paper failsafe", e);
               }
             }
           }
        }

        if (type === 'project') {
          projectResolvedRows = fetchedPapers.length;
          fetchedPapers = filterAndSortEntityPapers(fetchedPapers, {
            searchQuery: debouncedSearch,
            filters,
            sortBy,
          });
          fetchedPapers = pinSourcePaper(fetchedPapers, searchParams.get('arxivId'));
        }

        if (request.cancelled) return;

        // The two zeroes, told apart. No usable identifier at all means
        // OpenAIRE has nothing indexed for this project, and the empty state
        // may say so. Identifiers that resolved into no rows means every
        // lookup above timed out or was refused — each is wrapped in
        // `settleWithin` and dropped in silence — which is a load failure,
        // and saying so swaps the empty state's false claim for a Retry
        // button. Either way this page promises no next one. (Past page 1,
        // with rows already on screen, the flag raises the inline banner
        // instead of the empty state, which is the right shape there.)
        if (type === 'project' && (projectUsableIds === 0 || projectResolvedRows === 0)) {
          total = page * 30;
          if (projectUsableIds > 0) setPapersError('PUBLICATIONS_LOAD_FAILED');
        }

        if (topicProviderFailure && fetchedPapers.length > 0) {
          setPapersError('PARTIAL_PUBLICATIONS_LOAD_FAILED');
        }

        if (page === 1) {
          setPapers(fetchedPapers);
        } else {
          setPapers(prev => {
             const combined = PaperBuilder.deduplicate([...prev, ...fetchedPapers]);
             if (type !== 'project') return combined;
             const filtered = filterAndSortEntityPapers(combined, { searchQuery: debouncedSearch, filters, sortBy });
             return pinSourcePaper(filtered, searchParams.get('arxivId'));
          });
        }
        setHasMore(page * 30 < total);
      } catch (err) {
        console.error("Failed to load papers for entity", err);
        if (request.cancelled) return;
        if (page === 1) setPapers([]);
        setPapersError('PUBLICATIONS_LOAD_FAILED');
        setHasMore(false); // Stop infinite looping on errors
      }
      if (request.cancelled) return;
      setIsLoadingPapers(false);
      setIsFetchingMore(false);
    }
    loadPapers();
    // No cleanup: a request is superseded by key, above, and cancelled on
    // unmount, below — not by the next render of the same request.
  }, [type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, searchParams, papersReloadKey, entityReloadKey]);

  useEffect(() => () => {
    if (papersRequestRef.current) papersRequestRef.current.cancelled = true;
  }, []);

  useEffect(() => {
    let isCancelled = false;
    async function loadAuthors() {
      if (!entity || type === 'author' || entity._localTopic || entity._queryTopic || !authorsOpened) return;
      if (authorsPage === 1) {
        setIsLoadingAuthors(true);
        setAuthorsError(null);
      }
      else setIsFetchingMoreAuthors(true);
      
      try {
        const resolvedId = entity.id || id;
        const { authors, total } = await getAuthorsByEntity(
          type,
          resolvedId,
          authorsPage,
          debouncedSearch,
          entity.display_name,
        );
        
        if (isCancelled) return;
        if (authorsPage === 1) {
          setEntityAuthors(authors);
        } else {
          setEntityAuthors(prev => {
            const existingIds = new Set(prev.map(a => a.id));
            const newAuthors = authors.filter(a => !existingIds.has(a.id));
            return [...prev, ...newAuthors];
          });
        }
        setHasMoreAuthors(authorsPage * 30 < total);
      } catch (err) {
        console.error("Failed to load authors for entity", err);
        if (isCancelled) return;
        if (authorsPage === 1) setEntityAuthors([]);
        setAuthorsError('AUTHORS_LOAD_FAILED');
        setHasMoreAuthors(false); // Stop infinite looping on errors
      }
      if (isCancelled) return;
      setIsLoadingAuthors(false);
      setIsFetchingMoreAuthors(false);
    }
    loadAuthors();
    return () => { isCancelled = true; };
  }, [type, id, entity, authorsPage, debouncedSearch, authorsOpened, authorsReloadKey]);


  const filteredPapers = useMemo(() => {
    const sortedPapers = filterAndSortEntityPapers(papers, { sortBy });
    if (!entity?._queryTopic) return sortedPapers;
    return [...sortedPapers].sort((left, right) => (
      scoreQueryTopicPaper(right, entity) - scoreQueryTopicPaper(left, entity)
    ));
  }, [entity, papers, sortBy]);
  // The rows on screen now, and the ones still to come in idle chunks. The
  // "load more" sentinel waits for the whole page to be in, or it would sit
  // right under the first chunk and ask for the next page at once.
  const mountedPapers = useMemo(() => filteredPapers.slice(0, rowBudget), [filteredPapers, rowBudget]);
  const rowsSettled = rowBudget >= filteredPapers.length;
  useEffect(() => {
    if (rowsSettled) return undefined;
    const schedule = typeof window.requestIdleCallback === 'function'
      ? (fn) => window.requestIdleCallback(fn, { timeout: 400 })
      : (fn) => setTimeout(fn, 32);
    const cancel = typeof window.cancelIdleCallback === 'function'
      ? (id) => window.cancelIdleCallback(id)
      : (id) => clearTimeout(id);
    const handle = schedule(() => setRowBudget((budget) => nextExplorerRowBudget(budget, filteredPapers.length)));
    return () => cancel(handle);
  }, [rowsSettled, rowBudget, filteredPapers.length]);
  // The field colour and label of each row, once per list rather than once
  // per row per render: `areaKeyForCategory` was 27 ms of a throttled page
  // load, re-derived every time the page re-rendered around the rows.
  const rowAreas = useMemo(() => mountedPapers.map((paper) => ({
    accent: areaAccentForPaper(paper),
    label: areaLabelForPaper(paper, { english: isEnglish }) || (isEnglish ? 'Paper' : 'Artículo'),
  })), [isEnglish, mountedPapers]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          if (activeTab === 'papers' && hasMore && !isLoadingPapers && !isFetchingMore) {
            setPage(p => p + 1);
          } else if (activeTab === 'authors' && hasMoreAuthors && !isLoadingAuthors && !isFetchingMoreAuthors) {
            setAuthorsPage(p => p + 1);
          }
        }
      },
      { threshold: 0.1 }
    );
    if (activeTab === 'papers' && observerRef.current) observer.observe(observerRef.current);
    if (activeTab === 'authors' && observerAuthorsRef.current) observer.observe(observerAuthorsRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingPapers, isFetchingMore, hasMoreAuthors, isLoadingAuthors, isFetchingMoreAuthors, activeTab, rowsSettled]);

  // Armed only while a fresh page is loading (never for "load more", which has
  // the sentinel's own spinner); a load that lands well under 4s clears this
  // effect before the timeout ever fires, so the note never shows. The flag
  // itself is reset to false where the next page-1 load starts, inside
  // `loadPapers` — not here, so this body stays a pure subscription with no
  // setState of its own (react-hooks/set-state-in-effect). `type`/`id` are
  // dependencies too: without them, navigating from one slow-loading entity
  // straight into another keeps `isLoadingPapers` continuously true, so this
  // effect would never re-run and the new entity's four seconds would be
  // measured on the previous one's clock.
  useEffect(() => {
    if (!(isLoadingPapers && !isFetchingMore)) return undefined;
    const handle = setTimeout(() => setIsPapersLoadSlow(true), 4000);
    return () => clearTimeout(handle);
  }, [isLoadingPapers, isFetchingMore, type, id]);

  const handleShare = async () => {
    if (!publicEntityUrl) return;
    if (navigator.share) {
      trackEvent('share', { method: 'native', content_type: analyticsEntityType, surface: 'explorer' });
      try {
        await navigator.share({
          title: entityDisplayName || 'PaperTok',
          url: publicEntityUrl,
        });
      } catch (error) {
        if (error?.name !== 'AbortError') console.error(error);
      }
      return;
    }

    trackEvent('share', { method: 'clipboard', content_type: analyticsEntityType, surface: 'explorer' });
    try {
      await navigator.clipboard.writeText(publicEntityUrl);
      alert(isEnglish ? 'Link copied to clipboard' : 'Enlace copiado al portapapeles');
    } catch (error) {
      console.error('Failed to copy entity link', error);
    }
  };

  const handleFollow = (event) => {
    event.stopPropagation();
    if (!followEntity) return;

    if (publicMode) {
      trackEvent('select_content', {
        content_type: analyticsEntityType,
        surface: 'explorer',
      });
      onAuthRequired();
      return;
    }
    toggleFollow(followEntity).catch(console.error);
  };

  const retryPapers = () => {
    setPapersError(null);
    setPage(1);
    setPapersReloadKey(key => key + 1);
  };

  const retryEntity = () => {
    setEntityError(null);
    setEntityReloadKey(key => key + 1);
  };

  const retryAuthors = () => {
    setAuthorsError(null);
    setAuthorsPage(1);
    setAuthorsReloadKey(key => key + 1);
  };

  const openParticipantInstitution = async (participant) => {
    setResolvingParticipant(participant.name);
    setParticipantNavigationError('');
    try {
      const institution = await findInstitution({
        name: participant.searchName || participant.name,
        aliases: [participant.name],
      });
      if (institution) {
        navigateToEntity('institution', institution.id);
      } else {
        setParticipantNavigationError(isEnglish
          ? `We could not find an institution profile for ${participant.name}.`
          : `No encontramos el perfil institucional de ${participant.name}.`);
      }
    } catch (error) {
      console.error('Failed to resolve project participant', error);
      setParticipantNavigationError(isEnglish
        ? `We could not open ${participant.name}. Try again.`
        : `No pudimos abrir ${participant.name}. Inténtalo de nuevo.`);
    } finally {
      setResolvingParticipant(null);
    }
  };

  const openAuthorInstitution = async () => {
    const knownInstitution = entity?.last_known_institutions?.[0];
    const institutionName = entity?.institution || knownInstitution?.display_name;
    const institutionId = knownInstitution?.id?.split('/').pop();
    const rorId = knownInstitution?.ror?.split('/').pop();

    if ((!institutionName && !institutionId && !rorId) || isResolvingAuthorInstitution) return;

    setIsResolvingAuthorInstitution(true);
    setAuthorInstitutionNavigationError('');
    try {
      if (institutionId || rorId) {
        navigateToEntity('institution', institutionId || rorId);
        return;
      }

      const institution = await findInstitution({
        name: institutionName,
        aliases: [knownInstitution?.display_name, entity?.institution].filter(Boolean),
      });

      if (institution?.id) {
        navigateToEntity('institution', institution.id.split('/').pop());
      } else {
        setAuthorInstitutionNavigationError(isEnglish
          ? 'We could not find this institution profile.'
          : 'No encontramos el perfil de esta institución.');
      }
    } catch (error) {
      console.error('Failed to resolve author institution', error);
      setAuthorInstitutionNavigationError(isEnglish
        ? 'We could not open this institution. Try again.'
        : 'No pudimos abrir esta institución. Inténtalo de nuevo.');
    } finally {
      setIsResolvingAuthorInstitution(false);
    }
  };

  // The wait was silent to a screen reader: shapes carry nothing, so someone
  // not looking at them heard an empty page until the data landed.
  if (isLoadingEntity) {
    /* Which page is coming is decided by the route, not by the fetch — `type`
       is in the URL — and the three pages this stands in for are not the same
       page. One skeleton served all of them: two tabs always, and nothing at
       all reserved between the stats and the tab strip. On an author that was
       a second tab the page would never render and a 177px drop when the real
       header arrived; on an institution, 242px. */
    const shape = explorerSkeletonShape(type, { hasOrcid: Boolean(extractOrcid(id)) });
    return (
      <div
        className={`explorer-container explorer-skeleton explorer-skeleton--${type || 'entity'}${appChromeClass}`}
        role="status"
        aria-busy="true"
        aria-label={isEnglish ? 'Loading' : 'Cargando'}
      >
        {/* Not `aria-hidden` on the whole hero: the real, working Back button
            lives inside it, and hiding its container would hide a focusable
            control from assistive technology while leaving it reachable by
            Tab (axe's `aria-hidden-focus`). Each decorative placeholder is
            hidden on its own instead, so the Back button is the one thing in
            here a screen reader still announces. */}
        <div className="explorer-hero">
          <div className="explorer-hero-top">
            <div className="eht-left">
              <Button variant="outline" size="icon" onClick={handleBack} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
                <ArrowLeft size={20} />
              </Button>
              <div className="ex-skel ex-skel-type" aria-hidden="true"></div>
            </div>
            <div className="ex-skel ex-skel-action" aria-hidden="true"></div>
          </div>

          {/* The live hero's own nesting, copied rather than approximated:
              header wraps main and aside, and the stats sit inside the aside.
              Flattening it let `.ehc-main` stretch down the whole hero and
              pushed the stats to the floor, with a screen of nothing between. */}
          <div className="explorer-hero-content is-skeleton" ref={heroBodyRef} aria-hidden="true">
            <div className="ehc-header">
              <div className="ehc-main">
                <div className="ehc-visual-slot">
                  <div className="ehc-icon ex-skel"></div>
                </div>
                <div className="ehc-info">
                  {/* The name the link already knew — an author's, a project's —
                      is painted the moment the page opens, in the live hero's
                      own element, so the masthead reads while the profile is
                      on its way. Only a page that opens on nothing but an id
                      shows the bar. */}
                  {seedName
                    ? <h1 className="ehc-name" style={{ margin: 0 }}>{seedName}</h1>
                    : <div className="ex-skel ex-skel-name"></div>}
                  {/* The metadata line every type puts under the name: an
                      author's institution, an institution's city, a project's
                      funder. It lives inside `.ehc-info` on the live page, and
                      the standalone `.ehc-meta` block that used to stand in for
                      it down here was counting the same line twice. */}
                  <div className="ex-skel ex-skel-sub ex-skel-sub--medium"></div>

                  {/* The strip under the name, which is where the two page
                      shapes first part company: an author is identified by the
                      subjects they work on, an institution by its credentials
                      and the organisations inside it. */}
                  {shape.identity === 'topics' && (
                    <div className="ehc-tags ex-skel-strip">
                      {[72, 88, 64, 56].map(width => (
                        <span key={width} className="ex-skel ex-skel-chip" style={{ width }} />
                      ))}
                    </div>
                  )}
                  {shape.identity === 'credentials' && (
                    <>
                      <div className="ehc-institution-identity ex-skel-strip">
                        <span className="ex-skel ex-skel-chip" style={{ width: 104 }} />
                        <span className="ex-skel ex-skel-chip" style={{ width: 72 }} />
                      </div>
                      <div className="ehc-ror-relations ex-skel-strip">
                        {[186, 172, 158].map(width => (
                          <span key={width} className="ex-skel ex-skel-relation" style={{ width }} />
                        ))}
                      </div>
                    </>
                  )}
                  {shape.identity === 'none' && (
                    <div className="ex-skel ex-skel-sub ex-skel-sub--short"></div>
                  )}
                </div>
              </div>

              <div className="ehc-hero-aside">
                <div className="ehc-stats-grid">
                  {Array.from({ length: shape.stats }, (_, i) => {
                    // The last cell IS the recent-impact one on the pages that
                    // carry it, so it takes that cell's class — the stylesheet
                    // pins the grid's width through it — and the detail box
                    // whose two reserved lines are the cell's real height.
                    const isImpact = shape.impact && i === shape.stats - 1;
                    return (
                      <div key={i} className={`ehc-stat-box${isImpact ? ' ehc-stat-box--impact' : ''}`}>
                        <span className="ex-skel ex-skel-stat-value"></span>
                        <span className="ex-skel ex-skel-stat-label"></span>
                        {isImpact && (
                          <span className="ehc-stat-detail"><span className="ex-skel ex-skel-stat-detail"></span></span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {/* Every entity the Explorer serves can be followed, so the
                    button belongs to the spine. Leaving it out took 32px out
                    of the hero on all three. */}
                {shape.follow && <div className="ex-skel ex-skel-follow"></div>}
              </div>
            </div>

            {/* The block beside the header, and the clearest tell of which page
                is loading: an author's ORCID card, a project's summary box.
                The Wikipedia block is not reserved: it arrives under the
                settle once its lookup settles (explorerSkeletonShape.js says
                why a reservation and an arrival cannot both be right). Placed
                here, inside `.explorer-hero-content`, because that is where
                the live ones are: hung off `.explorer-hero` instead it missed
                the container's 16px gap and measured against the wrong
                parent. */}
            {shape.aside === 'orcid' && <OrcidCardSkeleton />}
            {shape.aside === 'summary' && <ProjectSummarySkeleton />}
          </div>

          {/* One tab or two, from the same helper the live strip answers with.
              A page that will only ever show Papers no longer advertises an
              Authors tab it is about to take away. */}
          <div className="ee-tabs" aria-hidden="true">
            {Array.from({ length: shape.tabs }, (_, i) => (
              <div key={i} className="ex-skel ex-skel-tab"></div>
            ))}
          </div>
        </div>

        {/* The search toolbar is not part of the hero, and was missing too. */}
        <div className="explorer-toolbar-wrapper">
          <div className="explorer-toolbar">
            <div className="ex-skel ex-skel-search"></div>
          </div>
        </div>

        {/* The real container, not a stand-in for it: the rows that replace
            these land in the same grid with the same rules, so nothing moves
            when the words arrive. */}
        <div className="explorer-content" aria-hidden="true">
          <div className="explorer-grid">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="explorer-list-item ex-skel-row">
                <div className="ex-skel-row-head">
                  <div className="ex-skel ex-skel-kicker"></div>
                  <div className="ex-skel ex-skel-metrics"></div>
                </div>
                <div className="ex-skel ex-skel-title"></div>
                <div className="ex-skel ex-skel-title"></div>
                <div className="ex-skel ex-skel-authors"></div>
                <div className="ex-skel ex-skel-summary"></div>
                <div className="ex-skel ex-skel-summary ex-skel-summary--short"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!entity) {
    return (
      <div className={`explorer-error${appChromeClass}`}>
        <Button variant="outline" size="icon" onClick={handleBack} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
          <ArrowLeft size={24} />
        </Button>
        <h2>{entityError
          ? (isEnglish ? 'The entity could not be loaded' : 'No se pudo cargar la entidad')
          : (isEnglish ? 'Entity not found' : 'Entidad no encontrada')}</h2>
        {entityError && (
          <>
            <p role="alert">{getUiErrorMessage(entityError, language, 'ENTITY_LOAD_FAILED')}</p>
            <Button variant="outline" size="sm" onClick={retryEntity}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
          </>
        )}
      </div>
    );
  }

  const renderIcon = () => {
    if (type === 'institution') return <Building2 size={36} />;
    if (type === 'concept' || type === 'topic') return <Lightbulb size={36} />;
    if (type === 'source') return <FileText size={36} />;
    if (type === 'project') return <Briefcase size={36} />;
    return <Users size={36} />;
  };

  const entityTypeLabel = type === 'author'
    ? (isEnglish ? 'Author' : 'Autor')
    : type === 'institution'
      ? (isEnglish ? 'University / Institution' : 'Universidad / Institución')
      : type === 'source'
        ? (isEnglish ? 'Journal' : 'Revista')
        : type === 'project'
          ? (isEnglish ? 'Research project' : 'Proyecto de investigación')
          : (isEnglish ? 'Topic' : 'Tema');
  const topConcepts = entity.x_concepts ? entity.x_concepts.slice(0, 4) : [];

  // The type rides on the live container, the way the skeleton already carries
  // it (`explorer-skeleton--${type}`). What a project fills in late — its stat
  // cells, its link menu — needs an entrance the other entity types must not
  // inherit, and there was no hook for that here.
  return (
    <div className={`explorer-container explorer-container--${type || 'entity'}${appChromeClass}`} style={{ '--area-accent': entityAccent }}>
      {/* Immersive Hero */}
      <div className="explorer-hero">
        <AnimatePresence>
          {hasLoadedWikiImage && (
            <motion.div
              key="bg-blur"
              // One owner for this opacity, and it is this one.
              //
              // The stylesheet ran a `bgPulseFade` keyframe on the same element
              // fading to 0.1, while this animated the same property to 1 — ten
              // times stronger than the wash is meant to be. Two animations
              // racing for one property is why the header looked wrong for a
              // beat and then corrected itself: whichever won the first frames
              // decided how much of the photograph you saw. The keyframe is
              // gone; 0.1 is the intended weight and is now stated once.
              // One event, one clock. This fades off the same `hasLoadedWikiImage`
              // flip as the photograph in the visual slot, and that cross-fade
              // takes 280ms — so a second of ease-in-out here left the wash
              // still deepening 720ms after the picture it is made of had
              // settled. It also had no `ease`, which in framer means the
              // built-in `easeInOut`: the one unnamed curve in a hero of ~85
              // hand-typed arrivals. It is a 10% wash; it does not need a
              // second to arrive, it needs to arrive WITH its photograph.
              // The URL rides a custom property because the picture is on
              // the element's `::before`, on a box of its own — see the
              // stylesheet for the measurement that put it there.
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.1 }}
              exit={{ opacity: 0 }}
              transition={prefersReducedMotion
                ? { duration: 0 }
                : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="ehc-bg-blur"
              style={{ '--ehc-wash-image': `url(${visibleWikiInfo.thumbnail})` }}
            ></motion.div>
          )}
        </AnimatePresence>
        
        <div className="explorer-hero-top">
          <div className="eht-left">
            <Button variant="outline" size="icon" onClick={handleBack} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
              <ArrowLeft size={20} />
            </Button>
            <span className="ehc-type">{entityTypeLabel}</span>
          </div>
          <Button variant="ghost" size="icon" onClick={handleShare} aria-label={isEnglish ? 'Share' : 'Compartir'} title={isEnglish ? 'Share' : 'Compartir'}>
            <Share2 size={18} />
          </Button>
        </div>
        
        <div className="explorer-hero-content" ref={heroBodyRef}>
          <div className="ehc-header">
          <div className="ehc-main">
            {/* The tile and the photograph share one box and one clock.
                Measured with 0.32s on the tile against 0.42s on the photo:
                their opacities summed to 0.912 at the crossing point, so the
                card showed through both for two frames and the slot flickered,
                then sat 66ms with the tile gone and the photo not yet opaque.
                On one duration the sum is exactly 1 at every instant — 1 − e(t)
                and e(t) — whatever the curve. The scales still differ on
                purpose: one shrinks away as the other grows in. */}
            <div className="ehc-visual-slot">
              <motion.div
                className="ehc-icon"
                initial={false}
                animate={{ opacity: hasLoadedWikiImage ? 0 : 1, scale: hasLoadedWikiImage ? 0.96 : 1 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                aria-hidden={hasLoadedWikiImage}
              >
                {renderIcon()}
              </motion.div>
              <AnimatePresence>
                {visibleWikiInfo?.thumbnail && (
                  <motion.div
                    key={visibleWikiInfo.thumbnail}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: hasLoadedWikiImage ? 1 : 0, scale: hasLoadedWikiImage ? 1 : 0.96 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    className="ehc-wiki-image"
                  >
                    <img
                      src={visibleWikiInfo.thumbnail}
                      alt={entityDisplayName}
                      onLoad={() => setLoadedWikiImageUrl(visibleWikiInfo.thumbnail)}
                      onError={() => setLoadedWikiImageUrl('')}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="ehc-info">
              <div className="ehc-title-row">
                {/* The type label stands in for a name the entity does not
                    have — a project whose lookup failed on a route with no
                    `?name=`. It stands in HERE, not in `entity.display_name`,
                    which is the follow identity; and being read on every
                    render it follows a language toggle without a remount. */}
                <h1 className="ehc-name" style={{ margin: 0 }}>{entityDisplayName || entityTypeLabel}</h1>
                {type === 'author' && orcidInfo?.employments?.length > 0 && (
                  <button
                    type="button"
                    className={`ehc-name-toggle ${isExperienceOpen ? 'is-open' : ''}`}
                    onClick={() => { setExperienceToggled(true); setIsExperienceOpen(open => !open); }}
                    aria-expanded={isExperienceOpen}
                    aria-controls="ehc-experience-panel"
                    aria-label={isEnglish ? 'Professional experience' : 'Experiencia profesional'}
                    title={isEnglish ? 'Professional experience' : 'Experiencia profesional'}
                  >
                    <Briefcase size={15} aria-hidden="true" />
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              {type === 'institution' && (
                <>
                  <p className="ehc-meta">
                    {[entity.geo?.city, entity.geo?.country].filter(Boolean).join(', ')}
                  </p>
                  {entity.rorVerified && safeRorUrl && (
                    <div className="ehc-institution-identity">
                      <a href={safeRorUrl} target="_blank" rel="noopener noreferrer" title={isEnglish ? 'View official ROR record' : 'Ver registro oficial en ROR'}>
                        <BadgeCheck size={13} /> {isEnglish ? 'ROR verified' : 'ROR verificado'}
                      </a>
                      {entity.established && <span>{isEnglish ? 'Since' : 'Desde'} {entity.established}</span>}
                    </div>
                  )}
                  {entity.relationships?.length > 0 && (
                    <div className="ehc-ror-relations" aria-label={isEnglish ? 'Institutional relationships verified by ROR' : 'Relaciones institucionales verificadas por ROR'}>
                      {entity.relationships.slice(0, 4).map(relationship => (
                        <button
                          key={`${relationship.type}-${relationship.rorId}`}
                          type="button"
                          onClick={() => navigateToEntity('institution', relationship.rorId)}
                          title={`${ROR_RELATION_LABELS[language][relationship.type] || ROR_RELATION_LABELS[language].related}: ${relationship.label}`}
                        >
                          <span>{ROR_RELATION_LABELS[language][relationship.type] || ROR_RELATION_LABELS[language].related}</span>
                          <strong>{relationship.label}</strong>
                          <ChevronRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {type === 'author' && authorInstitutionDisplayName && (
                <div className="ehc-author-institution-wrap">
                  <button
                    type="button"
                    className="ehc-author-institution"
                    onClick={openAuthorInstitution}
                    disabled={isResolvingAuthorInstitution}
                    title={isEnglish ? 'View institution' : 'Ver institución'}
                  >
                    {isResolvingAuthorInstitution ? <Loader2 className="spinning" size={15} /> : <Building2 size={15} />}
                    <span>{authorInstitutionDisplayName}</span>
                  </button>
                  {authorInstitutionNavigationError && (
                    <p className="ehc-author-institution-error" role="alert">{authorInstitutionNavigationError}</p>
                  )}
                </div>
              )}
              {type === 'project' && entity.funder && (
                <p className="ehc-meta">
                  {entity.funder}{entity.fundingStream ? ` — ${entity.fundingStream}` : ''}
                </p>
              )}
              {type === 'project' && (entity.openaireId || safeProjectWebsiteUrl) && (
                <div className="project-links-menu">
                  {/* A menu of links: Base UI's Menu gives it `role="menu"`, arrow
                      keys, Escape and outside-press; the items are `LinkItem`s
                      (`<a role="menuitem">`), which the ui dropdown does not wrap
                      yet, so the part is taken from the primitive. `closeOnClick`
                      because the links open a new tab and the menu has no reason
                      to stay behind. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<button type="button" className="project-links-trigger" />}>
                      <Globe size={15} />
                      <span>{isEnglish ? 'View project' : 'Ver proyecto'}</span>
                      <ChevronDown size={15} aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      className="project-links-dropdown"
                      align="start"
                      side="bottom"
                      sideOffset={8}
                      aria-label={isEnglish ? 'Project links' : 'Enlaces del proyecto'}
                    >
                      {entity.openaireId && (
                        <MenuPrimitive.LinkItem
                          className="project-links-option"
                          href={`https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}`}
                          target="_blank"
                          rel="noreferrer"
                          closeOnClick
                        >
                          <span className="project-links-option-icon"><Building2 size={16} /></span>
                          <span>
                            <strong>{isEnglish ? 'OpenAIRE record' : 'Ficha en OpenAIRE'}</strong>
                            <small>{isEnglish ? 'Data, publications, and participants' : 'Datos, publicaciones y participantes'}</small>
                          </span>
                          <ExternalLink size={14} />
                        </MenuPrimitive.LinkItem>
                      )}
                      {safeProjectWebsiteUrl && (
                        <MenuPrimitive.LinkItem
                          className="project-links-option"
                          href={safeProjectWebsiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          closeOnClick
                        >
                          <span className="project-links-option-icon"><Globe size={16} /></span>
                          <span>
                            <strong>{isEnglish ? 'Official website' : 'Sitio oficial'}</strong>
                            <small>{isEnglish ? 'The project’s own website' : 'Web del propio proyecto'}</small>
                          </span>
                          <ExternalLink size={14} />
                        </MenuPrimitive.LinkItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
              {topConcepts.length > 0 && (
                <div className="ehc-tags">
                  {topConcepts.map((c, i) => (
                    <span key={i} className="ehc-tag">
                      <Lightbulb size={12} /> {c.display_name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="ehc-hero-aside">
          {/* Stats Grid — compact, beside the follow action */}
          <div className="ehc-stats-grid">
            {entity?.works_count != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.works_count.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Publications' : 'Publicaciones'}</span>
              </div>
            )}
            {entity?.cited_by_count != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.cited_by_count.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Total citations' : 'Citas totales'}</span>
              </div>
            )}
            {(entity?.summary_stats?.h_index != null || entity?.h_index != null) && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity?.summary_stats?.h_index ?? entity?.h_index}</span>
                <span className="ehc-stat-label">{type === 'source' ? (isEnglish ? 'Type' : 'Tipo') : 'H-Index'}</span>
              </div>
            )}
            {['institution', 'author'].includes(type) && (
              <RecentImpactStat
                impact={recentImpact}
                isLoading={isLoadingRecentImpact}
                error={recentImpactError}
                isEnglish={isEnglish}
              />
            )}
            {type === 'project' && entity._detailsPending && [1, 2].map((n) => (
              <div key={`stat-reserved-${n}`} className="ehc-stat-box" aria-hidden="true">
                <span className="ex-skel ex-skel-stat-value"></span>
                <span className="ex-skel ex-skel-stat-label"></span>
              </div>
            ))}
            {type === 'project' && entity.budget > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.budget); } catch { return `${entity.budget.toLocaleString(locale)} €`; } })()}
                </span>
                <span className="ehc-stat-label">{isEnglish ? 'Total budget' : 'Presupuesto total'}</span>
              </div>
            )}
            {type === 'project' && entity.fundedAmount > 0 && entity.fundedAmount !== entity.budget && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.fundedAmount); } catch { return `${entity.fundedAmount.toLocaleString(locale)} €`; } })()}
                </span>
                <span className="ehc-stat-label">{isEnglish ? 'Funding' : 'Financiación'}</span>
              </div>
            )}
            {type === 'project' && entity.startDate && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.startDate.split('-')[0]} - {entity.endDate?.split('-')[0] || '...'}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Duration' : 'Duración'}</span>
              </div>
            )}
            {type === 'project' && entity.participants?.length > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.participants.length}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Participants' : 'Participantes'}</span>
              </div>
            )}
            {type === 'project' && entity.measures?.citations > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.measures.citations.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Citations' : 'Citas'}</span>
              </div>
            )}
          </div>
          {followEntity && (
            // A pressed button, not a command: ink while it invites, a bordered
            // chip once the relationship exists (`.entity-follow-btn` in the
            // stylesheet keys the two looks off the `data-pressed` Base UI sets).
            <Toggle
              variant="outline"
              className="entity-follow-btn"
              pressed={entityIsFollowing}
              onClick={handleFollow}
              disabled={entityFollowPending}
            >
              {entityIsFollowing
                  ? <><Check size={14} /> <span>{isEnglish ? 'Following' : 'Siguiendo'}</span></>
                  : <span>{isEnglish ? 'Follow' : 'Seguir'}</span>}
            </Toggle>
          )}
          </div>
          </div>

          {/* Professional experience — a disclosure opened from the chevron by the name */}
          {type === 'author' && orcidInfo?.employments?.length > 0 && (
            // No `initial={false}`: the presence mounts with the panel, when
            // the record lands on a hero that is already live, so the panel
            // arriving is the one entrance this animation exists for. Off, it
            // popped in at full height and shoved the card and the list.
            <AnimatePresence>
              {isExperienceOpen && (
                <motion.div
                  id="ehc-experience-panel"
                  className="ehc-experience-panel"
                  // No `y` any more. It was there to give the panel somewhere
                  // to come from back when the height could not reach zero;
                  // now that it can, a slide on top of the collapse is a
                  // second motion arguing with the first. Height opens the
                  // box, opacity fills it, and nothing else moves.
                  // On arrival the panel is already open when the record
                  // lands, so it mounts at full height and the hero body's
                  // settle is the one animation that carries the SPACE (see
                  // `experienceToggled`). Its contents still arrive: an
                  // opacity-only entrance, which touches no layout, so the
                  // height keeps a single owner. `initial={false}` here used
                  // to switch the fade off with the height, and the bordered
                  // panel popped in at opacity 1 (measured). The entrance from
                  // 0 height is the reader's toggle, where the box is at rest.
                  initial={experienceToggled ? (prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }) : { opacity: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  // Closing is not opening reversed, and framer would make it
                  // so: without a transition of its own the exit inherits the
                  // component's, which is the arrival's expo-out. That is the
                  // same mistake the Wikipedia fold was measured making — the
                  // curve is front-loaded, so everything below the panel leapt
                  // and then crawled (-31.9px in one frame, there). This is the
                  // taller of the hero's two folds AND the only one a click
                  // closes, so it is the one a reader watches.
                  exit={prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, height: 0, transition: EXPERIENCE_FOLD_OUT }}
                  transition={prefersReducedMotion
                    ? { duration: 0 }
                    : {
                      // The contents clear a little before the box finishes
                      // closing, so the last thing seen is an empty fold
                      // rather than text being guillotined by the clip.
                      opacity: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
                      height: { duration: 0.26, ease: [0.16, 1, 0.3, 1] },
                    }}
                >
                  <div className="ehc-experience-inner">
                  <div className="ehc-experience-title">
                    <Briefcase size={13} aria-hidden="true" />
                    {isEnglish ? 'Professional experience' : 'Experiencia profesional'}
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo.employments.map((emp, i) => (
                      <div key={i} className="orcid-timeline-item">
                        <div
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: emp.ror, name: emp.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          }}
                          onKeyDown={(event) => handleActivationKey(event, async () => {
                            const inst = await findInstitution({ rorUrl: emp.ror, name: emp.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          })}
                          role="link"
                          tabIndex={0}
                          title={`${isEnglish ? 'Find and view profile for' : 'Buscar y ver perfil de'} ${emp.organization}`}
                        >
                          {emp.organization}
                        </div>
                        {emp.role && <div className="orcid-item-role">{emp.role}</div>}
                        {emp.startDate && (
                          <div className="orcid-item-dates">
                            {emp.startDate}
                            <span className="dot-separator">→</span>
                            {emp.endDate || (isEnglish ? 'Present' : 'Presente')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          {/* Project metadata chips */}
          {type === 'project' && (entity.callIdentifier || entity.contractType || entity.openAccess || entity.measures?.downloads > 0 || entity.measures?.views > 0) && (
            <div className="project-meta-chips">
              {entity.callIdentifier && (
                <span className="project-chip"><BookOpen size={13} /> {entity.callIdentifier}</span>
              )}
              {entity.contractType && (
                <span className="project-chip"><Award size={13} /> {entity.contractType}</span>
              )}
              {entity.openAccess && (
                <span className="project-chip project-chip--oa"><BookOpen size={13} /> Open Access</span>
              )}
              {entity.measures?.downloads > 0 && (
                <span className="project-chip"><Download size={13} /> {entity.measures.downloads.toLocaleString(locale)} {isEnglish ? 'downloads' : 'descargas'}</span>
              )}
              {entity.measures?.views > 0 && (
                <span className="project-chip"><Eye size={13} /> {entity.measures.views.toLocaleString(locale)} {isEnglish ? 'views' : 'vistas'}</span>
              )}
            </div>
          )}

          {/* Project Summary - expandable */}
          {type === 'project' && entity._detailsPending && <ProjectSummarySkeleton />}
          {type === 'project' && entity?.summary && (
            <div
              className={`project-summary-box ${expandedSummary ? 'is-expanded' : ''} ${isProjectSummaryExpandable ? 'is-expandable' : ''}`}
              onClick={isProjectSummaryExpandable ? () => setExpandedSummary(!expandedSummary) : undefined}
              onKeyDown={isProjectSummaryExpandable ? (event) => handleActivationKey(event, () => setExpandedSummary(!expandedSummary)) : undefined}
              role={isProjectSummaryExpandable ? 'button' : undefined}
              tabIndex={isProjectSummaryExpandable ? 0 : undefined}
              aria-expanded={isProjectSummaryExpandable ? expandedSummary : undefined}
              aria-label={isProjectSummaryExpandable
                ? expandedSummary
                  ? (isEnglish ? 'Collapse project summary' : 'Contraer resumen del proyecto')
                  : (isEnglish ? 'Expand project summary' : 'Ampliar resumen del proyecto')
                : undefined}
            >
              <p
                ref={projectSummaryTextRef}
                className={expandedSummary ? 'expanded' : 'collapsed'}
                style={projectSummaryExpandedHeight ? { '--project-summary-expanded-height': `${projectSummaryExpandedHeight}px` } : undefined}
              >
                {entity.summary}
              </p>
              {isProjectSummaryExpandable && (
                <span className="project-summary-toggle">
                  <ChevronDown size={14} /> {expandedSummary
                    ? (isEnglish ? 'Show less' : 'Mostrar menos')
                    : (isEnglish ? 'Read more' : 'Leer más')}
                </span>
              )}
            </div>
          )}

          {/* Project subjects */}
          {type === 'project' && entity.subjects?.length > 0 && (
            <div className="project-subjects">
              <h4 className="project-section-title"><Tag size={14} /> {isEnglish ? 'Project topics' : 'Temas del proyecto'}</h4>
              <div className="project-subjects-list">
                {entity.subjects.map((s, i) => (
                  <span key={i} className="ehc-tag">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Participating organizations */}
          {type === 'project' && entity.participants?.length > 0 && (
            <div className="project-participants">
              <h4 className="project-section-title"><Building2 size={14} /> {isEnglish ? 'Participating organizations' : 'Organizaciones participantes'}</h4>
              <motion.div
                id="project-participants-list"
                layout={!prefersReducedMotion}
                className="project-participants-grid"
                transition={prefersReducedMotion ? { duration: 0 } : { layout: { duration: 0.28 } }}
              >
                <AnimatePresence initial={false}>
                {entity.participants.slice(0, participantsExpanded ? entity.participants.length : 6).map((p, i) => (
                  <motion.button
                    key={`${p.name}-${p.country || i}`}
                    type="button"
                    className="project-participant-card"
                    layout={!prefersReducedMotion}
                    initial={i < 6 || prefersReducedMotion ? false : { opacity: 0, y: 8, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.99 }}
                    transition={prefersReducedMotion
                      ? { duration: 0 }
                      : { duration: 0.24, delay: i < 6 ? 0 : Math.min((i - 6) * 0.025, 0.18) }}
                    onClick={() => openParticipantInstitution(p)}
                    disabled={resolvingParticipant === p.name}
                    aria-label={`${isEnglish ? 'Open institution profile for' : 'Abrir perfil institucional de'} ${p.name}`}
                  >
                    <span className="project-participant-info">
                      <span className="project-participant-name">{p.name}</span>
                      {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
                    </span>
                    {resolvingParticipant === p.name
                      ? <Loader2 size={15} className="ehc-spinner" aria-hidden="true" />
                      : <ChevronRight size={15} className="project-participant-arrow" aria-hidden="true" />}
                  </motion.button>
                ))}
                </AnimatePresence>
              </motion.div>
              {participantNavigationError && (
                <p className="project-participant-error" role="alert">{participantNavigationError}</p>
              )}
              {entity.participants.length > 6 && (
                <button
                  className="project-show-more"
                  onClick={() => setParticipantsExpanded(value => !value)}
                  aria-expanded={participantsExpanded}
                  aria-controls="project-participants-list"
                >
                  {participantsExpanded
                    ? (isEnglish ? 'Show fewer organizations' : 'Mostrar menos organizaciones')
                    : `+${entity.participants.length - 6} ${isEnglish ? 'more organizations' : 'organizaciones más'}`}
                </button>
              )}
            </div>
          )}
          
          {/* Wikipedia or external info, and it ARRIVES rather than appears.
              Between 2026-09-06 and 2026-09-08 this block was held open with
              grey rows for the whole lookup so the paragraph could replace them
              in place; that kept the list still, and it also meant the block
              never had an entrance — it was simply already there.

              It mounts when its lookup has SETTLED, with everything it is ever
              going to have, and the hero's settle grows the box around it.
              Gated on settled rather than on content: mounting early on
              `homepage_url` alone — which the entity carries and the lookup does
              not — would put the block on screen before the prose and settle it
              a second time when the paragraph came. One mount, one settle.

              The page skeleton no longer reserves this block either
              (explorerSkeletonShape.js). Reserved space and an entrance
              animation are two answers to the same question: with both, the
              hero shrinks by the reservation when the live hero lands without
              the block, then grows again when it unfolds — down, then up. */}
          <AnimatePresence initial={false} onExitComplete={() => setWikiFoldExits((n) => n + 1)}>
            {showWikiBlock && (
              <motion.div
                className="ehc-wiki-fold"
                // Opacity only. The hero body's settle carries this block's
                // SPACE (it is in the settle's deps), so the box grows under
                // its clip and reveals the block from the top while everything
                // below rides the same 360ms — the arrival the ORCID card and
                // the experience panel already make. A second animator of the
                // height here was measured, twice, as the defect: a `layout`
                // projection scaled the paragraph while the body settled
                // (scaleY 1.21 for 380ms), and a `height: 'auto'` fold with the
                // settle latched behind it snapped the handover on every
                // navigation (2026-09-09). The words fade in over 240ms so they
                // are readable while the box is still opening; leaving is
                // quick, and the settle closes the space after the fade
                // (`onExitComplete` gives the settle the commit that
                // `AnimatePresence`'s own removal does not).
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={prefersReducedMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.15 } }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.24 }}
              >
                <div
                  className={`ehc-wiki ${isWikiDescriptionExpanded ? 'is-expanded' : ''} ${isWikiRequestPending ? 'is-loading' : ''}`}
                  aria-busy={isWikiRequestPending}
                >
                {/* The shapes hand over to the prose in ONE React commit, and
                    the fade is the paragraph's own CSS (`wikiProseIn`), not a
                    presence wrapper.

                    Measured with an `AnimatePresence mode="wait"` here, which
                    is what this replaces: splitting the swap across two commits
                    defeated the `layout` projection on the fold above. The
                    block stopped animating its height at all — 168.4px to
                    128.4px in a single frame, against a smooth 168.4 → 157.8
                    before — and the list below flashed 40px up and back down on
                    consecutive frames, four times the 10.5px it moved without
                    it. A cross-fade is not worth a commit boundary here: the
                    height animation IS the handover, and the words only need to
                    arrive rather than appear. */}
                {isWikiRequestPending ? (
                  <div className="ehc-wiki-skeleton" role="status" aria-label={isEnglish ? 'Loading topic details' : 'Cargando información del tema'}>
                    {/* A re-lookup, not the first one: the block is already
                        open and holds its rows until the new paragraph
                        replaces them in the same commit. Three lines because
                        the collapsed paragraph is clamped to exactly three,
                        then the show-more toggle, then the source links —
                        146px where 155px arrives, and the settle carries
                        those 9px. */}
                    <span />
                    <span />
                    <span />
                    <span className="ehc-wiki-skeleton-toggle" />
                    <span className="ehc-wiki-skeleton-links" />
                  </div>
                ) : wikiDescription ? (
                  <p
                    key={visibleWikiInfo?.extract ? 'wiki' : 'fallback'}
                    ref={wikiDescriptionTextRef}
                    className={isWikiDescriptionExpanded ? 'expanded' : 'collapsed'}
                    style={wikiDescriptionExpandedHeight ? { '--wiki-description-expanded-height': `${wikiDescriptionExpandedHeight}px` } : undefined}
                  >
                    {wikiDescription}
                  </p>
                ) : null}
                {isWikiDescriptionExpandable && (
                  <button
                    type="button"
                    className="ehc-wiki-toggle"
                    onClick={() => setIsWikiDescriptionExpanded(!isWikiDescriptionExpanded)}
                    aria-expanded={isWikiDescriptionExpanded}
                  >
                    <span>{isWikiDescriptionExpanded
                      ? (isEnglish ? 'Show less' : 'Mostrar menos')
                      : (isEnglish ? 'Read more' : 'Leer más')}</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                )}
                <div className="ehc-links">
                  {safeWikiUrl && (
                    <a href={safeWikiUrl} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      Wikipedia <ExternalLink size={14} />
                    </a>
                  )}
                  {safeHomepageUrl && (
                    <a href={safeHomepageUrl} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      {isEnglish ? 'Official website' : 'Web oficial'} <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ORCID Career Section */}
          {isLoadingOrcid && <OrcidCardSkeleton />}
          {orcidInfo && !isLoadingOrcid && (
            <div className="orcid-career-section orcid-career-section--animate">

              {/* Header: Badge + link */}
              <div className="orcid-career-header">
                <div className="orcid-badge">
                  <div className="orcid-badge-icon">
                    <img src="https://info.orcid.org/wp-content/uploads/2019/11/orcid_16x16.png" alt="ORCID" />
                  </div>
                  <div className="orcid-badge-text">
                    <span className="orcid-badge-label">{isEnglish ? 'Verified ORCID profile' : 'Perfil verificado ORCID'}</span>
                    <span className="orcid-badge-id">{orcidInfo.orcid}</span>
                  </div>
                </div>
                <a href={`https://orcid.org/${orcidInfo.orcid}`} target="_blank" rel="noopener noreferrer" className="orcid-profile-link">
                  {isEnglish ? 'View profile' : 'Ver perfil'} <ExternalLink size={12} />
                </a>
              </div>

              {/* Biography */}
              {orcidInfo.biography && (
                <div className="orcid-biography">
                  {orcidInfo.biography}
                </div>
              )}

              {/* External links */}
              {orcidInfo.researcherUrls?.length > 0 && (
                <div className="orcid-links-row">
                  {orcidInfo.researcherUrls.map((u, i) => {
                    const safeUrl = safeExternalUrl(u.url);
                    return safeUrl ? (
                      <a key={i} href={safeUrl} target="_blank" rel="noopener noreferrer" className="orcid-ext-link">
                        <Globe size={12} />
                        {u.name || (isEnglish ? 'External link' : 'Enlace externo')}
                      </a>
                    ) : null;
                  })}
                </div>
              )}

              {/* Education timeline */}
              {orcidInfo.educations?.length > 0 && (
                <div className="orcid-timeline-block">
                  <div className="orcid-timeline-title">
                    <span className="orcid-tl-icon orcid-tl-icon--edu"><BookOpen size={12} /></span>
                    {isEnglish ? 'Education' : 'Formación académica'}
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo.educations.map((edu, i) => (
                      <div key={i} className="orcid-timeline-item orcid-timeline-item--edu">
                        <div
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: edu.ror, name: edu.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          }}
                          onKeyDown={(event) => handleActivationKey(event, async () => {
                            const inst = await findInstitution({ rorUrl: edu.ror, name: edu.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          })}
                          role="link"
                          tabIndex={0}
                          title={`${isEnglish ? 'Find and view profile for' : 'Buscar y ver perfil de'} ${edu.organization}`}
                        >
                          {edu.organization}
                        </div>
                        {edu.role && <div className="orcid-item-role">{edu.role}</div>}
                        {edu.startDate && (
                          <div className="orcid-item-dates">
                            {edu.startDate}
                            {edu.endDate && <><span className="dot-separator">→</span>{edu.endDate}</>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
        
        <div className="ee-tabs" ref={setTabsRow}>
          {/* One rule that TRAVELS, rather than a border handed from one tab
              to the next. Measured 2026-09-10 on an institution: the yellow
              mark jumped 40 → 110.7px in a single frame, the only unanimated
              thing left in the tab switch. Same mechanism, curve and duration
              as the navbar's (`utils/navRule.js`, shared): a transform a CSS
              transition animates on the compositor, so it keeps sliding while
              the main thread mounts the other tab's list. */}
          <span
            className={`ee-tab-rule${tabRule.measured ? ' is-measured' : ''}`}
            aria-hidden="true"
            style={{ transform: tabRule.transform || undefined, opacity: tabRule.transform ? 1 : 0 }}
          />
          <button className={`ee-tab ${activeTab === 'papers' ? 'active' : ''}`} onClick={() => openTab('papers')}>
             {isEnglish ? 'Papers' : 'Artículos'}
          </button>
          {hasAuthorsTab(type, entity) && (
             <button className={`ee-tab ${activeTab === 'authors' ? 'active' : ''}`} onClick={() => openTab('authors')}>
               {isEnglish ? 'Authors' : 'Autores'}
             </button>
          )}
        </div>
      </div>

      {/* Sticky Toolbar Wrapper */}
      <div className="explorer-toolbar-wrapper">
        <div className="explorer-toolbar">
          <div className="explorer-search-box">
            <Search size={16} className="es-icon" />
            <Input
              type="text"
              className="explorer-search-input"
              placeholder={isEnglish
                ? `Search ${activeTab === 'papers' ? 'papers' : 'authors'} from ${type === 'institution' ? 'this institution' : type === 'concept' || type === 'topic' ? 'this topic' : type === 'project' ? 'this project' : 'this person'}...`
                : `Buscar ${activeTab === 'papers' ? 'publicaciones' : 'autores'} de ${type === 'institution' ? 'esta universidad' : type === 'concept' || type === 'topic' ? 'este tema' : type === 'project' ? 'este proyecto' : 'esta persona'}...`}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              aria-label={isEnglish
                ? `Search ${activeTab === 'papers' ? 'publications' : 'authors'} in this entity`
                : `Buscar ${activeTab === 'papers' ? 'publicaciones' : 'autores'} en esta entidad`}
            />
            {searchQuery && (
              <Button variant="ghost" size="icon-sm" className="es-clear" onClick={() => setSearchQuery('')} aria-label={isEnglish ? 'Clear search' : 'Limpiar búsqueda'} title={isEnglish ? 'Clear search' : 'Limpiar búsqueda'}>
                <X size={14} />
              </Button>
            )}
          </div>
          {activeTab === 'papers' && (
             <Button
                variant={filters?.category || filters?.peerReviewed || filters?.dateRange ? 'default' : 'outline'}
                size="icon"
                onClick={() => setShowFilters(true)}
                aria-label={isEnglish ? 'Open filters' : 'Abrir filtros'}
                title={isEnglish ? 'Filters' : 'Filtros'}
              >
                <Filter size={16} />
              </Button>
            )}
          </div>
        </div>

      <div className="explorer-content">
        {activeTab === 'papers' ? (
          <>

            
            {/* One tooltip provider over the list, so moving between verified
                badges does not re-wait the delay on each. */}
            <TooltipProvider>
            <div className="explorer-grid">
              {(!isLoadingPapers || isFetchingMore) && mountedPapers.map((paper, idx) => (
                <div 
                  key={`${paper.id}-${idx}`} 
                  className="explorer-list-item"
                  onClick={() => setSelectedPaper(paper)}
                  onKeyDown={(event) => handleActivationKey(event, () => setSelectedPaper(paper))}
                  role="button"
                  tabIndex={0}
                  aria-label={`${isEnglish ? 'Open publication' : 'Abrir publicación'}: ${normalizeScientificMarkup(paper.title) || (isEnglish ? 'Untitled' : 'Sin título')}`}
                  style={{ '--i': Math.min(idx, 8), '--area-accent': rowAreas[idx].accent }}
                >
                  <div className="eli-header">
                    <span className="eli-cat">{rowAreas[idx].label}</span>
                    <div className="eli-metrics">
                      {hasKnownPaperCitationCount(paper) && (
                        paper.sources?.primary === 'scopus' && paper.scopusCitedByUrl ? (
                          <a
                            className="eli-citations eli-citations--link"
                            href={safeExternalUrl(paper.scopusCitedByUrl) || undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`${getPaperCitationCount(paper).toLocaleString(locale)} ${isEnglish ? 'citations on Scopus' : 'citas en Scopus'}`}
                          >
                            <Award size={13} />
                            {getPaperCitationCount(paper).toLocaleString(locale)} {isEnglish ? 'citations on Scopus' : 'citas en Scopus'}
                          </a>
                        ) : (
                          <span className="eli-citations">
                            <Award size={13} />
                            {getPaperCitationCount(paper).toLocaleString(locale)} {isEnglish ? 'citations' : 'citas'}
                          </span>
                        )
                      )}
                      <span className="eli-date">{paper.year}</span>
                    </div>
                  </div>
                  <h3 className="eli-title">
                    <ScientificText>{paper.title}</ScientificText>
                    {paper.peerReviewed && (
                      // The name is on the badge itself (the row is the focus
                      // stop, so the badge is not made focusable); the tooltip
                      // spells it out for a pointer.
                      <Tooltip>
                        <TooltipTrigger
                          render={<span className="eli-verified" role="img" />}
                          aria-label={isEnglish ? 'Published in a peer-reviewed journal' : 'Publicado en revista (revisado por pares)'}
                        >
                          <BadgeCheck size={16} aria-hidden="true" />
                        </TooltipTrigger>
                        <TooltipContent>
                          {isEnglish ? 'Published in a peer-reviewed journal' : 'Publicado en revista (revisado por pares)'}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </h3>
                  <p className="eli-authors">{(paper.authors || []).map(a => a.name || a).join(', ')}</p>
                  <p className="eli-summary">
                    {hasUsableAIAbstract(paper.abstract)
                      ? <ScientificText>{paper.abstract}</ScientificText>
                      : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
                  </p>
                </div>
              ))}
              
              {isLoadingPapers && !isFetchingMore && [1, 2, 3, 4, 5].map((n) => (
                  <div
                    key={`skeleton-${n}`}
                    className="explorer-list-item ex-skel-row"
                    aria-hidden="true"
                  >
                    <div className="ex-skel-row-head">
                      <div className="ex-skel ex-skel-kicker"></div>
                      <div className="ex-skel ex-skel-metrics"></div>
                    </div>
                    <div className="ex-skel ex-skel-title"></div>
                    <div className="ex-skel ex-skel-title"></div>
                    <div className="ex-skel ex-skel-authors"></div>
                    <div className="ex-skel ex-skel-summary"></div>
                    <div className="ex-skel ex-skel-summary ex-skel-summary--short"></div>
                  </div>
                ))}

              {isLoadingPapers && !isFetchingMore && isPapersLoadSlow && (
                <p className="explorer-loading-note" role="status">
                  {type === 'project'
                    ? (isEnglish ? 'Asking OpenAIRE for this project’s publications. It can take a few seconds.' : 'Consultando a OpenAIRE las publicaciones del proyecto. Puede tardar unos segundos.')
                    : (isEnglish ? 'Still loading publications…' : 'Todavía cargando publicaciones…')}
                </p>
              )}

              {/* Infinite Scroll Sentinel — once every row of this page is in.
                  The box always mounts, because it IS the observer's target and
                  gating it on the fetch would leave nothing to observe. What is
                  gated is the spinner and the claim: `hasMore` only says there
                  is a next page, so an ungated `spin 1s infinite` sat at the
                  foot of every list announcing a request that had not started.
                  A spinner that spins when nothing is loading is the one kind
                  of motion with no state to indicate. */}
              {hasMore && rowsSettled && (
                <div ref={observerRef} className="ehc-sentinel">
                  {isFetchingMore && <Loader2 className="ehc-spinner" size={24} />}
                  <span>{isFetchingMore
                    ? (isEnglish ? 'Loading more articles...' : 'Cargando más artículos...')
                    : (isEnglish ? 'Scroll for more' : 'Sigue bajando para ver más')}</span>
                </div>
              )}
            </div>
            </TooltipProvider>

            {!isLoadingPapers && filteredPapers.length === 0 && (
              <ExplorerEmptyState
                variant={pickEmptyVariant({
                  papersError,
                  hasActiveFilters: Boolean(debouncedSearch) || Boolean(filters.category) || filters.peerReviewed || Boolean(filters.dateRange),
                  type,
                })}
                isEnglish={isEnglish}
                errorMessage={papersError ? getUiErrorMessage(papersError, language, 'PUBLICATIONS_LOAD_FAILED') : ''}
                onRetry={retryPapers}
                onClearFilters={() => { setSearchQuery(''); setFilters({ category: '', peerReviewed: false, dateRange: '' }); }}
                openAireUrl={entity?.openaireId ? `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}` : null}
              />
            )}
            {!isLoadingPapers && papersError && filteredPapers.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{getUiErrorMessage('PARTIAL_PUBLICATIONS_LOAD_FAILED', language)}</span>
                <Button variant="ghost" size="sm" onClick={retryPapers}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
              </div>
            )}
          </>
        ) : (
          <div className="ee-authors-grid">
            {(!isLoadingAuthors || isFetchingMoreAuthors) && entityAuthors.map((author, idx) => (
              <div 
                key={author.id} 
                className="ee-author-card staggerFadeUp" 
                style={{ '--i': idx }}
                onClick={() => navigateToEntity('author', author.id)}
                onKeyDown={(event) => handleActivationKey(event, () => navigateToEntity('author', author.id))}
                role="link"
                tabIndex={0}
                aria-label={`${isEnglish ? 'Open profile for' : 'Abrir perfil de'} ${author.display_name}`}
              >
                <div className="ee-author-icon"><Users size={24} /></div>
                <div className="ee-author-info">
                  <h4>{author.display_name}</h4>
                  <p className="ee-author-metrics">
                    {author.source === 'crossref'
                      ? `${author.works_count.toLocaleString(locale)} ${isEnglish ? 'matching publications' : 'publicaciones coincidentes'}`
                      : `H-Index: ${author.h_index} • ${author.cited_by_count.toLocaleString(locale)} ${isEnglish ? 'citations' : 'citas'}`}
                  </p>
                </div>
                <ChevronRight size={18} className="ee-author-arrow" />
              </div>
            ))}
            
            {isLoadingAuthors && !isFetchingMoreAuthors && [1, 2, 3, 4, 5, 6].map(n => (
                <div
                  key={`skel-author-${n}`}
                  className="ee-author-card ex-skel-row"
                  aria-hidden="true"
                >
                  <div className="ee-author-icon ex-skel ex-skel-avatar"></div>
                  <div className="ee-author-info">
                    <div className="ex-skel ex-skel-name-line"></div>
                    <div className="ex-skel ex-skel-sub ex-skel-sub--short"></div>
                  </div>
                </div>
              ))}
            
            {hasMoreAuthors && (
              <div ref={observerAuthorsRef} className="ehc-sentinel">
                {isFetchingMoreAuthors && <Loader2 className="ehc-spinner" size={24} />}
                <span>{isFetchingMoreAuthors
                  ? (isEnglish ? 'Loading more authors...' : 'Cargando más autores...')
                  : (isEnglish ? 'Scroll for more' : 'Sigue bajando para ver más')}</span>
              </div>
            )}
            {!isLoadingAuthors && entityAuthors.length === 0 && (
              authorsError ? (
                <div className="explorer-empty">
                  <p role="alert">{getUiErrorMessage(authorsError, language, 'AUTHORS_LOAD_FAILED')}</p>
                  <Button variant="outline" size="sm" onClick={retryAuthors}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
                </div>
              ) : (
                <ExplorerEmptyState variant={debouncedSearch ? 'authors' : 'authors-none'} isEnglish={isEnglish} />
              )
            )}
            {!isLoadingAuthors && authorsError && entityAuthors.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{getUiErrorMessage('PARTIAL_AUTHORS_LOAD_FAILED', language)}</span>
                <Button variant="ghost" size="sm" onClick={retryAuthors}>{isEnglish ? 'Try again' : 'Reintentar'}</Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filter drawer — a Sheet: a positioned modal Dialog (focus trap,
          Escape, restore, `aria-modal`) that slides in from the right and
          waits for its own exit before unmounting. The title names it. */}
      <Sheet open={showFilters} onOpenChange={setShowFilters}>
        <SheetContent
          side="right"
          className="ee-filter-drawer"
          overlayClassName="ee-filter-backdrop"
          showClose={false}
        >
              <div className="ee-filter-header">
                <SheetTitle render={<h3 />}><SlidersHorizontal size={18}/> {isEnglish ? 'Advanced filters' : 'Filtros avanzados'}</SheetTitle>
                <SheetClose
                  render={<Button variant="ghost" size="icon" />}
                  aria-label={isEnglish ? 'Close filters' : 'Cerrar filtros'}
                  title={isEnglish ? 'Close' : 'Cerrar'}
                >
                  <X size={20}/>
                </SheetClose>
              </div>
              <div className="ee-filter-body">
                {/* Each row of chips is one choice, so each is a single-select
                    ui ToggleGroup: Base UI writes `aria-pressed` on the chip
                    that is on (the old `active` class said nothing to a screen
                    reader) and moves between chips on the arrow keys. The
                    group reports `[]` when the pressed chip is pressed again;
                    "no choice" is not a state these have, so that is ignored.
                    The open choices ("All", "Any date") are stored as '' and
                    carried under a sentinel value here. */}
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Sort by' : 'Ordenar por'}</h4>
                  <ToggleGroup
                    variant="outline"
                    className="ee-filter-chips"
                    aria-label={isEnglish ? 'Sort by' : 'Ordenar por'}
                    value={[sortBy]}
                    onValueChange={([next]) => { if (next !== undefined) setSortBy(next); }}
                  >
                    <ToggleGroupItem value="cited_by_count:desc" className="ee-filter-chip">
                      {isEnglish ? 'Most cited' : 'Más citados'}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="publication_date:desc" className="ee-filter-chip">
                      {isEnglish ? 'Most recent' : 'Más recientes'}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Category (Area)' : 'Categoría (Área)'}</h4>
                  <ToggleGroup
                    variant="outline"
                    className="ee-filter-chips"
                    aria-label={isEnglish ? 'Category (Area)' : 'Categoría (Área)'}
                    value={[filters.category || 'all']}
                    onValueChange={([next]) => {
                      if (next !== undefined) setFilters({ ...filters, category: next === 'all' ? '' : next });
                    }}
                  >
                    <ToggleGroupItem value="all" className="ee-filter-chip">
                      {isEnglish ? 'All' : 'Todas'}
                    </ToggleGroupItem>
                    {Object.entries(CATEGORIES).map(([key, cat]) => (
                      <ToggleGroupItem key={key} value={key} className="ee-filter-chip">
                        {isEnglish ? cat.labelEn : cat.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Publication date' : 'Fecha de publicación'}</h4>
                  <ToggleGroup
                    variant="outline"
                    className="ee-filter-chips"
                    aria-label={isEnglish ? 'Publication date' : 'Fecha de publicación'}
                    value={[filters.dateRange || 'any']}
                    onValueChange={([next]) => {
                      if (next !== undefined) setFilters({ ...filters, dateRange: next === 'any' ? '' : next });
                    }}
                  >
                    {['any', 'last_year', 'last_5_years'].map(val => (
                      <ToggleGroupItem key={val} value={val} className="ee-filter-chip">
                        {val === 'any'
                          ? (isEnglish ? 'Any date' : 'Cualquier fecha')
                          : val === 'last_year'
                            ? (isEnglish ? 'Last year' : 'Último año')
                            : (isEnglish ? 'Last 5 years' : 'Últimos 5 años')}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <div className="ee-filter-section">
                  {/* An enclosing label: the Switch renders a span (`role="switch"`)
                      with a hidden input, which is the pattern Base UI names for
                      a wrapping label. */}
                  <Label className="ee-toggle-label">
                    <Switch
                      checked={filters.peerReviewed}
                      onCheckedChange={(checked) => setFilters({ ...filters, peerReviewed: checked })}
                    />
                    {isEnglish ? 'Peer-reviewed only' : 'Solo revisados por pares'}
                  </Label>
                </div>
              </div>
              <div className="ee-filter-footer">
                <Button variant="outline" className="ee-filter-reset" onClick={() => { setFilters({category:'', peerReviewed:false, dateRange:''}); setShowFilters(false); }}>
                  {isEnglish ? 'Reset' : 'Restablecer'}
                </Button>
                <Button className="ee-filter-apply" onClick={() => setShowFilters(false)}>
                  {isEnglish ? 'Apply filters' : 'Aplicar filtros'}
                </Button>
              </div>
        </SheetContent>
      </Sheet>

      {/* Paper Card Overlay — the shared takeover, so the explorer, search and
          Research all open a paper the same way. */}
      <PaperOverlay
        open={Boolean(selectedPaper && !pdfPaperToView)}
        onClose={closeSelectedPaper}
        onExitComplete={() => setShownPaper(null)}
        isEnglish={isEnglish}
        label={isEnglish ? 'Publication details' : 'Detalles de la publicación'}
      >
        {shownPaper && (
          <PaperCard
            paper={shownPaper}
            isActive
            isLiked={likedPaperIds.has(interactionIdFor(shownPaper))}
            isSaved={savedPaperIds.has(interactionIdFor(shownPaper))}
            isRead={readPaperIds.has(interactionIdFor(shownPaper))}
            onLike={toggleLike}
            onNotInterested={(paper) => { markNotInterested(paper); setSelectedPaper(null); }}
            onMarkAsRead={markAsRead}
            onUnmarkAsRead={unmarkAsRead}
            onOpenPdf={(paper) => setPdfPaperToView(paper)}
            onSaveToList={onSaveToList}
            getInteractionState={getInteractionState}
            trackViewTime={trackViewTime}
            trackSkip={trackSkip}
            publicMode={publicMode}
            onAuthRequired={onAuthRequired}
            analyticsSurface="explorer"
          />
        )}
      </PaperOverlay>

      {pdfPaperToView && (
        <PDFViewer paper={pdfPaperToView} closeRef={pdfCloseRef} onClose={() => setPdfPaperToView(null)} />
      )}
    </div>
  );
}
