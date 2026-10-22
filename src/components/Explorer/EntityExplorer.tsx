import type { KeyboardEvent, MouseEvent } from 'react';
import type { Transition } from 'framer-motion';
import type { Paper } from '../../models/Paper.ts';
import type { OpenAlexAuthor, OpenAlexInstitution, OpenAlexTopic } from '../../services/adapters/openAlexTypes.ts';
import type { Project } from '../../services/openAireService.ts';
import type { RecentImpact } from '../../services/openAlexService.ts';
import type { WikiInfo } from '../../services/wikiService.ts';
import type { HandoverEntity } from '../../utils/explorerHandover.ts';
import type { ProjectParticipant } from '../../utils/entityMetadata.ts';
import type { FollowInput } from '../../utils/following.ts';

type ExplorerEntity = Partial<OpenAlexAuthor & OpenAlexInstitution & OpenAlexTopic & Project> & {
  _queryTopic?: boolean; _detailsPending?: boolean; query?: string;
  metadata?: { localizedNames?: Record<string, string>; query?: string; source?: string; categoryIds?: string[] };
  ids?: { wikidata?: string; wikipedia?: string };
  categories?: string[]; primaryCategory?: string;
};
interface VisitRecord {
  activeTab: string; authorsOpened: boolean; authorsSearch: string; entityAuthors: OpenAlexAuthor[];
  authorsPage: number; hasMoreAuthors: boolean;
  wikiInfo: (WikiInfo & { _requestKey: string }) | null;
  settledWikiRequestKey: string; loadedWikiImageUrl: string;
  recentImpact: RecentImpact | null;
}
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowsClockwise,
  ArrowSquareOut,
  BookOpen,
  Briefcase,
  Buildings,
  CaretDown,
  CaretRight,
  CircleNotch,
  FileText,
  Funnel,
  Globe,
  Lightbulb,
  MagnifyingGlass,
  MapPin,
  SealCheck,
  ShareNetwork,
  SlidersHorizontal,
  Users,
  X,
} from '@phosphor-icons/react';
import { getEntityById, peekEntity, getWorksByEntity, getAuthorsByEntity, enrichPapersBatch, fetchPapersByDois, getAuthorProfileExact, getAuthorProfileByOrcid, findInstitution, getEntityRecentImpact, getLocalTopicEntity, enrichAuthorInstitutionLocalization } from '../../services/openAlexService.ts';
import { isOpenAlexBudgetRefusal, isOpenAlexRateLimitError } from '../../services/openAlexClient.ts';
import { fetchPapersByIds, getAuthorPapers } from '../../services/arxivService.ts';
import { isScopusEnabled, PubmedAdapter, ScopusAdapter, SemanticScholarAdapter } from '../../services/adapters/index.ts';
import { getPapersByProject, getProjectDetails } from '../../services/openAireService.ts';
import { PaperBuilder } from '../../services/PaperBuilder.ts';
import { extractOrcid, getOrcidRecord } from '../../services/orcidService.ts';
import {
  EXPLORER_AUTO_PAGES,
  EXPLORER_ROW_CHUNK,
  authorIdentityVerified,
  explorerListState,
  explorerPageAllowance,
  entityPapersRequestKey,
  filterAndSortEntityPapers,
  getPaperCitationCount,
  guestGateTotal,
  countPapersByArea,
  guestPreviewRows,
  hasKnownPaperCitationCount,
  nextExplorerRowBudget,
  pinSourcePaper,
  shouldShowGuestGate,
  sourceArxivIdFrom,
} from '../../utils/entityExplorer.ts';
import { toast } from 'sonner';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useHeightSettle } from '../../hooks/useHeightSettle.ts';
import { useIsPageArriving, useAfterPageArrival } from '../../hooks/usePageArrival.ts';
import { useOverlayHistory } from '../../hooks/useOverlayHistory.ts';
import { CATEGORIES } from '../../data/categories.ts';
import { areaAccentForCategory as getAreaGradient } from '../../utils/areaAccent.ts';
import { explorerSkeletonShape, hasAuthorsTab } from '../../utils/explorerSkeletonShape.ts';
import { handedEntityFor, handoverFromSearchRow } from '../../utils/explorerHandover.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.tsx';
import OrcidStamp from './OrcidStamp.tsx';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Label } from '../ui/label.tsx';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '../ui/sheet.tsx';
import { Drawer, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import useQuickSave from '../../hooks/useQuickSave.ts';
import useClipTooltip from '../../hooks/useClipTooltip.ts';
import { Switch } from '../ui/switch.tsx';
import { FollowToggle } from '../ui/follow-toggle.tsx';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.tsx';
import { useFollowing } from '../../context/FollowingContext.tsx';
import { useFeed } from '../../context/FeedContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import PaperCard from '../Feed/PaperCard.tsx';
import PaperOverlay from '../Feed/PaperOverlay.tsx';
import PDFViewer from '../PDF/PDFViewer.tsx';
import RecentImpactStat from './RecentImpactStat.tsx';
import { ListRowAuthors, PaperListRow } from '../Lists/ListRow.tsx';
import SharePanel from '../Feed/SharePanel.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../Onboarding/Petri.tsx';
import { ExplorerEmptyState } from './ExplorerEmptyState.tsx';
import ExplorerGuestGate from './ExplorerGuestGate.tsx';
import { pickEmptyVariant } from './explorerEmptyVariant.ts';
import { isOpaqueQueryTopicText, resolveQueryTopicRoute } from '../../utils/topicNavigation.ts';
import { scoreQueryTopicPaper } from '../../utils/queryTopicSearch.ts';
import { settleWithin } from '../../utils/asyncTiming.ts';
import { fetchTopicPapers } from '../../services/topicRetrievalService.ts';
import { loadEntityWikiInfo } from '../../services/wikiService.ts';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization.ts';
import { getProjectDisplayName } from '../../utils/entityMetadata.ts';
import { getUiErrorMessage } from '../../utils/errorMessages.ts';
import { safeExternalUrl } from '../../utils/externalUrl.ts';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.ts';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { getPublicEntityPath, getPublicEntityUrl } from '../../utils/publicNavigation.ts';
import 'katex/dist/katex.min.css';
import './EntityExplorer.css';
import { EASE_OUT_EXPO } from '../../utils/motionCurves.ts';

const ENTITY_PRIMARY_RENDER_BUDGET_MS = 7000;
const ENTITY_SUPPLEMENT_RENDER_BUDGET_MS = 3500;

// The experience panel arrives open by default (2026-09-04) — up to this many
// rows. Measured on an author with a long history opened from the feed: 590px
// of panel, the tab strip pushed 1108px in 710ms. Past this the panel arrives
// folded and the chevron by the name opens it on the reader's own press.
const EXPERIENCE_OPEN_BY_DEFAULT_MAX_ROWS = 4;

// The ORCID experience panel's collapse. What travels is the page under
// the panel, and it has to land, so the space rides a gentle ease-in-out
// while the contents fade evenly. 300ms because this
// is a click's answer — the reader is waiting on it.
//
// The curve itself was chosen by measurement on the Wikipedia fold, back when
// that one still closed its own height (four probe runs with
// `scripts/diagnostics/explorer-loading-probe.mjs`): what a collapse costs the reader is its worst single
// frame — travel × steepness ÷ frames — not its duration, and a steep
// ease-in-out given too few frames measured WORSE than the front-loaded curve
// it replaced. Shortening this is no free way to make it feel quicker.
const EXPERIENCE_FOLD_OUT: Transition = {
  opacity: { duration: 0.16, ease: 'linear' },
  height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
};


// One line in the side sheet; resting on a cut name shows it whole.
function ParticipantName({ name }: { name: string }) {
  const { ref, ...tooltip } = useClipTooltip();
  return (
    <Tooltip {...tooltip}>
      <TooltipTrigger render={<span ref={ref} className="project-participant-name" />}>{name}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}

// Up to the last ten years of an author's output, from OpenAlex's per-year
// counts, ending this year. Inside the span OpenAlex reports, a missing year
// is a year with none; before its earliest year nothing is known, so the
// chart starts there instead of drawing zeros. This year is still running:
// its bar is lighter.
const ACTIVITY_YEARS = 10;
function AuthorActivity({ counts }: { counts: Array<{ year: number; works_count: number }> }) {
  const [currentYear] = useState(() => new Date().getFullYear());
  const byYear = new Map(counts.map(count => [count.year, count.works_count]));
  const lastYear = currentYear;
  const firstYear = Math.max(lastYear - ACTIVITY_YEARS + 1, Math.min(...counts.map(count => count.year)));
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i);
  const values = years.map(year => byYear.get(year) ?? 0);
  const max = Math.max(...values, 1);
  const summary = years.map((year, i) => `${year}: ${values[i]}`).join(', ');
  return (
    <figure className="ehc-activity" style={{ '--years': years.length }} aria-label={`Papers per year, ${years[0]} to ${lastYear}. ${summary}`}>
      <div className="ehc-activity-head" aria-hidden="true">
        <span>{'Papers per year'}</span>
        <span>{`${years[0]}–${lastYear}`}</span>
      </div>
      <div className="ehc-activity-bars" aria-hidden="true">
        {values.map((value, i) => (
          <span
            key={years[i]}
            className={years[i] === currentYear ? 'is-running' : undefined}
            style={{ '--v': value / max, '--i': i }}
            title={`${years[i]}: ${value} ${value === 1 ? 'paper' : 'papers'}`}
          />
        ))}
      </div>
      <div className="ehc-activity-years" aria-hidden="true">
        {years.map(year => <span key={year}>{String(year).slice(2)}</span>)}
      </div>
    </figure>
  );
}

// The side sheet stays near the height of the reading column beside it.
const PARTICIPANTS_SHOWN = 3;

// Where a project stands between its dates. With no published end there is
// nothing to measure today against, so the line runs dashed from the start
// and no point is placed for today.
function ProjectTimeline({ startDate, endDate }: { startDate: string; endDate?: string }) {
  const [now] = useState(Date.now);
  const start = Date.parse(startDate);
  const end = endDate ? Date.parse(endDate) : NaN;
  if (!Number.isFinite(start)) return null;
  const startYear = startDate.split('-')[0];
  const endYear = endDate?.split('-')[0];
  const hasEnd = Number.isFinite(end) && end > start;
  const ended = hasEnd && now >= end;
  const progress = hasEnd ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 0;
  return (
    <div
      className="ehc-timeline"
      style={{ '--timeline-progress': progress }}
      role="img"
      aria-label={`Started ${startYear}; ${ended ? `ended ${endYear}` : hasEnd ? `ends ${endYear}` : 'no end date published'}`}
    >
      <span className="ehc-timeline-title" aria-hidden="true">{'Duration'}</span>
      <div className="ehc-timeline-track" aria-hidden="true">
        <span className="ehc-timeline-done" />
        {!ended && <span className={`ehc-timeline-rest${hasEnd ? '' : ' is-open'}`} />}
        <span className="ehc-timeline-dot" />
        {hasEnd && !ended && <span className="ehc-timeline-dot ehc-timeline-dot--now" />}
        {hasEnd && <span className={`ehc-timeline-dot ehc-timeline-dot--end${ended ? ' is-reached' : ''}`} />}
      </div>
      <div className="ehc-timeline-labels" aria-hidden="true">
        <span>{`Start ${startYear}`}</span>
        {hasEnd && !ended && progress > 0.2 && progress < 0.8 && <span className="ehc-timeline-now">{'Today'}</span>}
        <span>{ended ? `Ended ${endYear}` : hasEnd ? `Ends ${endYear}` : 'No end date'}</span>
      </div>
    </div>
  );
}

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

const handleActivationKey = (event: KeyboardEvent, action: () => void) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
};

const ROR_RELATION_LABELS = {
  en: {
    parent: 'Part of',
    child: 'Includes',
    related: 'Related',
    predecessor: 'Predecessor',
    successor: 'Successor',
  },
};

/**
 * What a visit leaves behind for the next mount of the same entity, by
 * `type:id`: the tab, the authors list it had opened, the Wikipedia block
 * and the recent-impact figure. The route is keyed by pathname, so stepping
 * back to an institution mounts it afresh — and, measured 2026-09-18
 * (production build, signed in, author -> back): it came back on Papers
 * when it had been left on Authors, with its hero at 148.8px because the
 * Wikipedia block was being asked for again, and grew to 320.2 in a settle
 * that started only once the reveal had finished — everything under the
 * hero dropping 171px on a page the reader had just watched arrive. Seeded
 * from here, the page paints as it was left in its first frame and nothing
 * moves afterwards; the fetches still run and only upgrade. Bounded, so a
 * long session does not keep every page it ever opened.
 */
const VISIT_MEMORY_MAX = 24;
const visitMemory = new Map<string, VisitRecord>();
function rememberVisit(key: string, record: VisitRecord) {
  visitMemory.delete(key);
  visitMemory.set(key, record);
  if (visitMemory.size > VISIT_MEMORY_MAX) visitMemory.delete(visitMemory.keys().next().value!);
}

export default function EntityExplorer({
  onSaveToList = () => {},
  publicMode = false,
  onAuthRequired = () => {},
  // Under the app's own bar — App.jsx decides, the same way it decides to
  // render the bar — the page starts below it instead of at the top edge.
  appChrome = false,
}: { onSaveToList?: (paper: Paper) => void; publicMode?: boolean; onAuthRequired?: (reason?: string) => void; appChrome?: boolean }) {
  const { type, id } = useParams() as { type: string; id: string };
  // The visit this page resumes, if it was here before (`visitMemory`).
  // Read once per mount: the seeds below take it into state, and the two
  // refs let the effects that would otherwise clear or refetch that state
  // stand down exactly once.
  const visitKey = `${type}:${id}`;
  const resumed = useMemo(() => visitMemory.get(visitKey) || null, [visitKey]);
  const resumedEntityRef = useRef(Boolean(resumed));
  const resumedAuthorsRef = useRef(Boolean(resumed?.authorsOpened && !resumed?.authorsSearch));
  const appChromeClass = appChrome ? ' explorer--app' : '';
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const isPhone = useIsPhone();
  // While the route transition is still moving this page, the settle stands
  // down: see the measurement in usePageArrival.js.
  const isPageArriving = useIsPageArriving();
  const afterPageArrival = useAfterPageArrival();
  const { language, locale } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const [searchParams] = useSearchParams();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const handleSaveToList = useQuickSave(onSaveToList);
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
  const [entity, setEntity] = useState<ExplorerEntity | null>(() => (bornResolved ? (handedEntity || localTopic || cachedEntity || resolveQueryTopicRoute(id, searchParams)) : null));
  const [entityError, setEntityError] = useState<string | null>(null);
  const [entityReloadKey, setEntityReloadKey] = useState(0);
  const [papers, setPapers] = useState<Paper[]>([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(() => !bornResolved);
  // True from the start, and re-armed by every entity load: the live page's
  // first frame comes before the effect that requests the papers, and with
  // this false that frame showed the empty-state copy — "no results matched"
  // — between the hero landing and the rows' shapes taking over.
  const [isLoadingPapers, setIsLoadingPapers] = useState(true);
  const [papersError, setPapersError] = useState<string | null>(null);
  const [papersReloadKey, setPapersReloadKey] = useState(0);
  const [sortBy, setSortBy] = useState('cited_by_count:desc');
  
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [pdfPaperToView, setPdfPaperToView] = useState<Paper | null>(null);
  // Back closes this PDF viewer instead of leaving PaperTok: see useOverlayHistory.js.
  // Through the viewer's own close, the one the X uses — it owns `open` and
  // reports back only when its leave has played; `setPdfPaperToView(null)` is
  // just the fallback for the sub-frame gap before PDFViewer's own
  // `useImperativeHandle` has populated the ref — this import (above) is
  // plain, not lazy, so there is no chunk boundary to blame it on here.
  const pdfCloseRef = useRef<(() => void) | null>(null);
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
  const [shownPaper, setShownPaper] = useState<Paper | null>(null);
  if (selectedPaper && selectedPaper !== shownPaper) {
    setShownPaper(selectedPaper);
  }

  const [wikiInfo, setWikiInfo] = useState(() => resumed?.wikiInfo ?? null);
  const [settledWikiRequestKey, setSettledWikiRequestKey] = useState(() => resumed?.settledWikiRequestKey ?? '');
  const [loadedWikiImageUrl, setLoadedWikiImageUrl] = useState(() => resumed?.loadedWikiImageUrl ?? '');
  const [orcidInfo, setOrcidInfo] = useState<Awaited<ReturnType<typeof getOrcidRecord>>>(null);
  // A known ORCID reserves its slot on the very first live frame. Waiting for
  // the entity refresh to raise this flag would remove and reinsert the slot.
  const [isLoadingOrcid, setIsLoadingOrcid] = useState(() => type === 'author' && Boolean(entity?.orcid || extractOrcid(id)));

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  // True once a fresh-page load has run past 4s with nothing on screen but
  // the skeleton rows — a project's first page can take close to 17s
  // (OpenAIRE's own budget, then arXiv enrichment and DOI lookups) — so the
  // reader gets a word for what is being waited on instead of a silent wait.
  // How many rows of the list are mounted (utils/entityExplorer.js says why
  // it is not all of them at once).
  const [rowBudget, setRowBudget] = useState(EXPLORER_ROW_CHUNK);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const observerRef = useRef<HTMLDivElement | null>(null);
  const papersRequestRef = useRef<{ key: string; cancelled: boolean } | null>(null);
  // The pages the list may still ask for on its own (`explorerPageAllowance`),
  // and whether the foot of the list has been off screen since the last page
  // landed: if it has, the next time it shows the reader scrolled to it.
  const papersAutoPagesRef = useRef(EXPLORER_AUTO_PAGES);
  const papersFootHiddenRef = useRef(false);
  // Once the allowance runs out the foot is a "Keep looking" button, until the
  // list starts over.
  const [papersAwaitReader, setPapersAwaitReader] = useState(false);
  const requestNextPapersPage = useCallback((byReader: boolean) => {
    const left = explorerPageAllowance(papersAutoPagesRef.current, { byReader });
    if (left === null) {
      setPapersAwaitReader(true);
      return false;
    }
    papersAutoPagesRef.current = left;
    papersFootHiddenRef.current = false;
    setIsFetchingMore(true);
    setPage(p => p + 1);
    return true;
  }, []);

  const [activeTab, setActiveTab] = useState(() => resumed?.activeTab ?? 'papers');
  // Whether the Authors tab has been opened on this entity. The list is
  // requested then and kept from then on; `activeTab` no longer drives the
  // fetch, so leaving the tab does not cancel it and coming back does not
  // repeat it.
  const [authorsOpened, setAuthorsOpened] = useState(() => Boolean(resumed?.authorsOpened));
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
  const [projectSummaryExpandedHeight, setProjectSummaryExpandedHeight] = useState(0);
  const [isProjectSummaryExpandable, setIsProjectSummaryExpandable] = useState(false);
  const [resolvingParticipant, setResolvingParticipant] = useState<string | undefined | null>(null);
  const [isResolvingAuthorInstitution, setIsResolvingAuthorInstitution] = useState(false);
  const [authorInstitutionNavigationError, setAuthorInstitutionNavigationError] = useState('');
  const [recentImpact, setRecentImpact] = useState(() => resumed?.recentImpact ?? null);
  const [isLoadingRecentImpact, setIsLoadingRecentImpact] = useState(false);
  const [recentImpactError, setRecentImpactError] = useState<string | null>(null);
  
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    category: '',
    peerReviewed: false,
    dateRange: ''
  });

  const [entityAuthors, setEntityAuthors] = useState(() => (resumed && !resumed.authorsSearch ? resumed.entityAuthors : []));
  const [isLoadingAuthors, setIsLoadingAuthors] = useState(false);
  const [authorsError, setAuthorsError] = useState<string | null>(null);
  const [authorsReloadKey, setAuthorsReloadKey] = useState(0);
  const [isFetchingMoreAuthors, setIsFetchingMoreAuthors] = useState(false);
  const [authorsPage, setAuthorsPage] = useState(() => (resumed && !resumed.authorsSearch ? resumed.authorsPage : 1));
  const [hasMoreAuthors, setHasMoreAuthors] = useState(() => Boolean(resumed && !resumed.authorsSearch && resumed.hasMoreAuthors));
  const observerAuthorsRef = useRef<HTMLDivElement | null>(null);
  const viewedEntityRef = useRef('');
  const projectSummaryTextRef = useRef<HTMLParagraphElement | null>(null);
  const localizedTopicEntity = useMemo(
    () => entity?._localTopic ? getLocalTopicEntity(entity.id || id) : null,
    [entity, id],
  );
  const entityOfficialName = localizedTopicEntity?.display_name || entity?.display_name || '';
  const entityDisplayName = type === 'institution'
    ? getLocalizedInstitutionName(entity)
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
      author: { en: 'Author' },
      institution: { en: 'Institution' },
      project: { en: 'Research project' },
      source: { en: 'Scientific journal' },
      concept: { en: 'Research topic' },
      topic: { en: 'Research topic' },
    }[type as 'author' | 'institution' | 'project' | 'source' | 'concept' | 'topic'] || { en: 'Scientific entity' };

    return {
      title: {
        en: `${entityDisplayName} - ${typeLabel.en} | PaperTok`,
      },
      description: {
        en: `Explore scientific papers, citations, and research connected to ${entityDisplayName} on PaperTok.`,
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
  // `handover` is the record this page already holds for the entity it
  // links to — an author card's row — handed over in router state the way a
  // palette row is (`handoverFromSearchRow`), so the next page is born with
  // its name and counts instead of as a skeleton. Measured 2026-09-18,
  // institution -> author from the Authors tab, production build: the
  // author page slid in as grey rows, its name landed at 600ms, and its hero
  // settled twice, 131 -> 238 and then 238 -> 393.
  const navigateToEntity = useCallback((nextType: string, nextId: string, handover: HandoverEntity | null = null) => {
    if (publicMode) {
      const publicPath = getPublicEntityPath(nextType, nextId);
      if (publicPath) navigate(publicPath);
      return;
    }
    const entityForNext = handover ? handoverFromSearchRow(nextType, handover) : null;
    navigate(
      `/explorer/${nextType}/${encodeURIComponent(nextId)}`,
      entityForNext ? { state: { entity: entityForNext, entityType: nextType } } : undefined,
    );
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
    else navigate('/feed');
  }, [navigate]);
  // The first visit to Authors requests the list and keeps it from then on, so
  // a return to the tab finds the rows rather than a second skeleton. The
  // loading flag goes up here, with the tab, rather than in the effect that
  // fetches: the frame the tab opens on then already shows the rows' shapes
  // and never the empty-state copy.
  const openTab = useCallback((tab: string) => {
    setActiveTab(tab);
    if (tab === 'authors' && !authorsOpened) {
      setAuthorsOpened(true);
      setIsLoadingAuthors(true);
    }
  }, [authorsOpened]);
  const authorInstitution = type === 'author'
    ? entity?.institutionData || entity?.last_known_institutions?.[0] || (entity?.institution ? { display_name: entity.institution } : null)
    : null;
  const authorInstitutionDisplayName = getLocalizedInstitutionName(authorInstitution);
  const wikiRequestKey = `${entityReloadKey}:${language}:${type}:${entityDisplayName}`;
  const visibleWikiInfo = wikiInfo?._requestKey === wikiRequestKey ? wikiInfo : null;
  const safeRorUrl = safeExternalUrl(entity?.ror);
  const safeProjectWebsiteUrl = safeExternalUrl(entity?.websiteUrl);
  const safeHomepageUrl = safeExternalUrl(entity?.homepage_url);
  // Projects and institutions split their hero: a reading column, and a sheet
  // of actions, facts, relations and links beside it.
  const isOpenAlexTopic = type === 'topic' && Boolean(entity) && !entity?._localTopic && !entity?._queryTopic;
  const usesSheet = type === 'project' || type === 'institution' || isOpenAlexTopic;
  const heroLinks = [
    ...(safeHomepageUrl ? [{ label: 'Official website', href: safeHomepageUrl }] : []),
  ];
  const canLoadWikiInfo = Boolean(
    entityDisplayName && ['institution', 'concept', 'topic', 'source'].includes(type),
  );
  // Only what the Wikipedia block is looked up by. The entity object is
  // replaced whenever a later answer is folded into it, and the lookup must
  // not start again (and settle the hero twice) for those.
  const entityIsQueryTopic = Boolean(entity?._queryTopic);
  const entityIsLocalTopic = Boolean(entity?._localTopic);
  const entityWikidataId = entity?.ids?.wikidata || '';
  const entityWikipediaUrl = entity?.ids?.wikipedia || '';
  const wikiEntity = useMemo(() => ({
    _queryTopic: entityIsQueryTopic,
    _localTopic: entityIsLocalTopic,
    ids: { wikidata: entityWikidataId, wikipedia: entityWikipediaUrl },
  }), [entityIsLocalTopic, entityIsQueryTopic, entityWikidataId, entityWikipediaUrl]);
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

  const heroBodyRef = useRef<HTMLDivElement | null>(null);
  useHeightSettle(
    heroBodyRef,
    // Everything that changes this box's height and is worth a movement.
    [isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage],
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

  // What the next mount of this entity resumes with (`visitMemory`).
  useEffect(() => {
    rememberVisit(visitKey, {
      activeTab,
      authorsOpened,
      authorsSearch: debouncedSearch,
      entityAuthors,
      authorsPage,
      hasMoreAuthors,
      wikiInfo,
      settledWikiRequestKey,
      loadedWikiImageUrl,
      recentImpact,
    });
  }, [activeTab, authorsOpened, authorsPage, debouncedSearch, entityAuthors, hasMoreAuthors, loadedWikiImageUrl, recentImpact, settledWikiRequestKey, visitKey, wikiInfo]);

  const getInteractionState = useCallback((paper: Paper) => ({
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

  // Every control a visitor can push that needs an account goes through here:
  // the follow button, the search box, the filters, and the wall at the foot of
  // each list. One event, then the in-context prompt — the page stays where it
  // is, so signing up returns to this entity rather than to a login screen.
  // `reason` tells the sign-in dialog why it opened (authPromptCopy.js); the
  // wall at the foot of the list passes none and gets the general door.
  const requestAccount = useCallback((reason?: string) => {
    trackEvent('select_content', { content_type: analyticsEntityType, surface: 'explorer' });
    onAuthRequired(reason);
  }, [analyticsEntityType, onAuthRequired, trackEvent]);
  // What a guest's search button covers, in the placeholder's own words.
  const guestSearchScope = type === 'institution'
    ? { en: 'this institution' }
    : type === 'concept' || type === 'topic'
      ? { en: 'this topic' }
      : type === 'project'
        ? { en: 'this project' }
        : { en: 'this person' };
  const activeFilterCount = [filters?.category, filters?.peerReviewed, filters?.dateRange].filter(Boolean).length;
  const activeFilterChips = [
    filters.category && { key: 'category', label: CATEGORIES[filters.category as keyof typeof CATEGORIES]?.label || filters.category, clear: () => setFilters({ ...filters, category: '' }) },
    filters.dateRange && { key: 'date', label: filters.dateRange === 'last_year' ? 'Last year' : 'Last 5 years', clear: () => setFilters({ ...filters, dateRange: '' }) },
    filters.peerReviewed && { key: 'peer', label: 'Peer-reviewed', clear: () => setFilters({ ...filters, peerReviewed: false }) },
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => Boolean(chip));
  const guestSearchLabel = `Search ${guestSearchScope.en} · needs an account`;

  const measureExpandableDescriptions = useCallback(() => {
    const measure = (element: HTMLElement | null, setHeight: (height: number) => void, setExpandable: (expandable: boolean) => void) => {
      if (!element) return;
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      const collapsedHeight = Number.isFinite(lineHeight) ? lineHeight * 3 : element.clientHeight;
      setHeight(element.scrollHeight);
      setExpandable(element.scrollHeight > collapsedHeight + 1);
    };

    measure(projectSummaryTextRef.current, setProjectSummaryExpandedHeight, setIsProjectSummaryExpandable);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(measureExpandableDescriptions);
    return () => window.cancelAnimationFrame(frame);
  }, [entity?.summary, measureExpandableDescriptions]);

  // `resize` fires repeatedly on mobile — as the URL bar collapses while
  // scrolling, and again when the soft keyboard opens — and the unthrottled
  // handler forced a synchronous layout (getComputedStyle + scrollHeight) on
  // every single event. Debounced to the trailing edge: each event just
  // reschedules the timer, so only the resize that actually settles pays for
  // a measurement, and the read still lands inside a rAF. `measureExpandableDescriptions`
  // is a stable callback ([] deps), so this effect subscribes once for the
  // component's life rather than resubscribing on every render.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      clearTimeout(timer!);
      timer = setTimeout(() => requestAnimationFrame(measureExpandableDescriptions), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer!);
      window.removeEventListener('resize', onResize);
    };
  }, [measureExpandableDescriptions]);

  // An author page reached by a name that neither an id nor the paper could
  // confirm (utils/entityExplorer.js): its results may be several people's.
  const authorIdentityUnverified = Boolean(entity) && !authorIdentityVerified({ type, routeId: id, entity });
  const followEntity = useMemo<FollowInput | null>(() => {
    // A name-only author may be several people; following "them" would follow
    // whichever one the search returned.
    if (!entity || authorIdentityUnverified || !['author', 'institution', 'project', 'concept', 'topic'].includes(type)) return null;
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
      type: followType as FollowInput['type'],
      id: entity.id || entity.code || id,
      displayName,
      source: type === 'project' ? 'openaire' : type === 'concept' || type === 'topic' ? 'papertok' : 'openalex',
      externalIds: {
        orcid: entity.orcid,
        ror: entity.ror,
      },
      metadata,
    };
  }, [authorIdentityUnverified, entity, entityDisplayName, entityOfficialName, id, type]);
  const entityIsFollowing = Boolean(!publicMode && followEntity && isFollowing(followEntity));
  const entityFollowPending = Boolean(!publicMode && followEntity && isFollowPending(followEntity));

  // Only overlay state belongs to this deferred reset. The load below owns
  // ORCID and the experience disclosure; clearing them here could overwrite
  // a fast response after it has already committed.
  // Not on mount: the tab a resumed visit was left on is state already, and
  // this reset is for an entity change under a page that stays mounted.
  const resetForEntityRef = useRef(visitKey);
  useEffect(() => {
    if (resetForEntityRef.current === visitKey) return undefined;
    resetForEntityRef.current = visitKey;
    const timer = setTimeout(() => {
      setSelectedPaper(null);
      setPdfPaperToView(null);
      setActiveTab('papers');
      setAuthorsOpened(false);
      setExpandedSummary(false);
      setParticipantsExpanded(false);
    }, 0);
    return () => clearTimeout(timer!);
  }, [type, id, visitKey]);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
      setAuthorsPage(1);
    }, 600);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setAuthorsPage(1);
    }, 0);
    return () => clearTimeout(timer);
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
      setSearchQuery('');
      // A resumed visit keeps its authors, its Wikipedia lookup and its
      // impact figure: they are what the reader left, and the fetches
      // below only upgrade them. Once, for the mount that resumed.
      const resuming = resumedEntityRef.current;
      resumedEntityRef.current = false;
      if (!resuming) {
        setEntityAuthors([]);
        setWikiInfo(null);
      }
      setOrcidInfo(null);
      setIsLoadingOrcid(type === 'author' && Boolean((bornWith as ExplorerEntity | null)?.orcid || extractOrcid(id)));
      setIsExperienceOpen(true);
      setExperienceToggled(false);
      setExpandedSummary(false);
      setIsProjectSummaryExpandable(false);
      setResolvingParticipant(null);
      if (!resuming) setRecentImpact(null);
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
      
      let data: ExplorerEntity | null;
      let prefetchedOrcid = null;
      const orcidId = type === 'author' ? extractOrcid(id) : null;
      const isOpenAlexId = /^A\d+$/.test(id) || /openalex\.org\/A\d+/.test(id);
      
      if (orcidId) {
        data = await getAuthorProfileByOrcid(orcidId);
        if (!data) {
          prefetchedOrcid = await getOrcidRecord(orcidId);
          // OpenAlex has not linked this ORCID to any author yet. The paper
          // the link came from can still say which author entity wrote it;
          // only when it cannot does the page fall back to a stub, whose list
          // is a search by the name (review of 2026-09-25).
          const sourceReference = searchParams.get('paper') || searchParams.get('arxivId');
          if (prefetchedOrcid?.displayName && sourceReference) {
            const fromPaper = await getAuthorProfileExact(prefetchedOrcid.displayName, sourceReference);
            if (fromPaper?.verified) data = fromPaper;
          }
          if (!data && prefetchedOrcid?.displayName) {
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
        // The paper the link came from says which of the people with this
        // name is meant: `?paper=doi:…|pmid:…`, or the `?arxivId=` of arXiv
        // papers and older links.
        data = await getAuthorProfileExact(id, searchParams.get('paper') || searchParams.get('arxivId'));
      } else {
        data = await getEntityById(type, id);
      }

      if (isCancelled) return;

      if (type === 'author' && data) {
        data = await enrichAuthorInstitutionLocalization(data as OpenAlexAuthor);
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
      const wantsOrcid = Boolean(data?.display_name) && type === 'author' && Boolean(data!.orcid);
      if (wantsRecentImpact) {
        setIsLoadingRecentImpact(true);
        setRecentImpactError(null);
      }
      setIsLoadingOrcid(wantsOrcid);

      const loadRecentImpact = async () => {
        try {
          const impact = await getEntityRecentImpact(type, data!);
          if (!isCancelled) setRecentImpact(impact);
        } catch (error) {
          if (!isCancelled) {
            setRecentImpactError(
              isOpenAlexBudgetRefusal(error)
                ? 'budget_paused'
                : isOpenAlexRateLimitError(error)
                  ? 'rate_limited'
                  : (error as { code?: string } | null)?.code === 'timeout'
                    ? 'timeout'
                    : (error as { code?: string } | null)?.code === 'network_error'
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
          const record = prefetchedOrcid || await getOrcidRecord(data!.orcid!);
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
      setIsLoadingOrcid(false);
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

    loadEntityWikiInfo({
      entity: wikiEntity,
      title: entityDisplayName,
      signal: controller.signal,
    }).then(async info => {
      /* Wikipedia answers on its own clock, and when it answers fast — a warm
         HTTP cache, a short article — it lands inside the frames the page is
         still travelling on. The hero's settle stands down while the page is
         arriving (it must not be a second owner of the same displacement), so
         a block that arrives in that window gets no animation at all: it just
         appears. Measured 2026-09-12 over eight topics, `econ.EM` and
         `math.PR` jumped 230 -> 374px in a single frame at 256ms and 275ms,
         with the route transition still running; the other six changed height
         over twenty-odd frames. That is the "sometimes it loads with no
         animation". So the answer waits out the arrival, and only when there
         is one to wait out — then the settle owns the movement, every time. */
      const arriving = afterPageArrival();
      if (arriving) await arriving;
      if (isActive && !controller.signal.aborted) {
        setWikiInfo(info ? { ...info, _requestKey: wikiRequestKey } : null);
      }
    }).catch(error => {
      if ((error as Error | null)?.name !== 'AbortError') console.error('Failed to fetch Wikipedia info', error);
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
    afterPageArrival,
    canLoadWikiInfo,
    entityDisplayName,
    language,
    localizedTopicEntity?.label,
    type,
    wikiEntity,
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
        // A new list is the reader's request.
        papersAutoPagesRef.current = EXPLORER_AUTO_PAGES;
        papersFootHiddenRef.current = false;
        setPapersAwaitReader(false);
      }
      else setIsFetchingMore(true);
      let continuing = false;

      try {
        let arxivIds: string[] = [];
        let dois: string[] = [];
        let total = 0;
        let fetchedPapers: Paper[] = [];
        let topicProviderFailure = false;
        // A project's two counts, kept apart because they answer different
        // questions. `projectUsableIds` is how many identifiers OpenAIRE
        // returned for this page; `projectResolvedRows` is how many of them
        // came back as papers. They agree only when every lookup answered,
        // and their zeroes mean opposite things — see the cut further down.
        let projectUsableIds = 0;
        let projectResolvedRows = 0;

        const resolvedId = entity!.id || id;

        if (type === 'project') {
           const res = await getPapersByProject(resolvedId, page, { funder: searchParams.get('funder') || entity!.funder || '' });
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
            let papersFromOA: Paper[] = [];
            let arxPapersFromNative: Paper[] = [];
            let primaryError: unknown = null;
            // Semantic Scholar, PubMed and Scopus are searched by the NAME,
            // so what they return is anyone who shares it. A person the id or
            // the paper confirmed gets their own works only; the name
            // searches stay for a name that could not be resolved, under the
            // notice that says so (audit 2026-09-23, issue 4).
            const nameOnly = !authorIdentityVerified({ type, routeId: id, entity });
            const supplementalPromises = nameOnly
              ? [
                new SemanticScholarAdapter().search(`"${entity!.display_name}"`, page, { type: 'author' }),
                new PubmedAdapter().search(`"${entity!.display_name}"`, page, { type: 'author' }),
                isScopusEnabled()
                  ? new ScopusAdapter().search(entity!.display_name!, page, { type: 'author', limit: 8 })
                  : Promise.resolve({ papers: [] }),
              ]
              : [Promise.resolve({ papers: [] }), Promise.resolve({ papers: [] }), Promise.resolve({ papers: [] })];
            const primaryPromise = !resolvedId.startsWith('stub-')
              ? getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity!.display_name)
              : getAuthorPapers(entity!.display_name!, 30);
            const [primaryResult, supplementalResults] = await Promise.all([
              settleWithin<Awaited<typeof primaryPromise>>(primaryPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
              Promise.all(supplementalPromises.map(sourcePromise => (
                settleWithin<Awaited<typeof sourcePromise>>(sourcePromise, ENTITY_SUPPLEMENT_RENDER_BUDGET_MS)
              ))),
            ]);

            if (primaryResult.status === 'fulfilled') {
              if (!resolvedId.startsWith('stub-')) {
                papersFromOA = (primaryResult.value as Awaited<ReturnType<typeof getWorksByEntity>>)?.papers || [];
                total = (primaryResult.value as Awaited<ReturnType<typeof getWorksByEntity>>)?.total || 0;
              } else {
                arxPapersFromNative = primaryResult.value as Paper[] || [];
              }
            } else {
              primaryError = primaryResult.reason || new Error('The main source took too long to respond.');
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
         } else if ((type === 'concept' || type === 'topic') && (entity!._localTopic || entity!._queryTopic)) {
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
              getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity!.display_name),
              ENTITY_PRIMARY_RENDER_BUDGET_MS,
            );
            if (primaryResult.status !== 'fulfilled') {
              throw primaryResult.reason || new Error('The main source took too long to respond.');
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
        // The filters and the sort apply to every row the page draws on, not
        // only to what OpenAlex already filtered: an author's name-searched
        // rows (Semantic Scholar, PubMed, Scopus), a topic's arXiv and
        // relevance rows and an institution's Crossref rows arrive
        // unfiltered, so the sheet seemed to do nothing. A project's rows are
        // filtered, and searched, further down.
        if (type !== 'project') {
          fetchedPapers = filterAndSortEntityPapers(fetchedPapers, { filters, sortBy });
        }
        // 3. Guarantee source paper is ALWAYS first in the list
        if (page === 1) {
           const sourceArxivId = sourceArxivIdFrom(searchParams.get('arxivId'));
           if (sourceArxivId) {
             const cleanSourceId = sourceArxivId;
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
                 // Not past the reader's filters, though: a source paper
                 // they exclude stays out.
                 if (sourcePaperReq?.length > 0
                   && filterAndSortEntityPapers(sourcePaperReq.slice(0, 1), { filters }).length > 0) {
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
          // A warm cache answers inside the frames the page is still
          // travelling on, and thirty rows mounting there is the freeze the
          // reader sees as the entrance sticking: measured 2026-09-18 on an
          // author already in cache, no frame from 147 to 325ms while the
          // list went up in five chunks. The rows wait out the arrival, the
          // way the Wikipedia block already does; the skeleton rows are on
          // screen meanwhile.
          const arriving = afterPageArrival();
          if (arriving) await arriving;
          if (request.cancelled) return;
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
        // `rows` counts what this page added, not the list: a page that adds
        // none under earlier rows leaves the list's foot on screen, which
        // would ask for the next page on the same allowance.
        if (explorerListState({ rows: fetchedPapers.length, hasMore: page * 30 < total, publicMode }) === 'looking') {
          continuing = requestNextPapersPage(false);
        }
      } catch (err) {
        console.error("Failed to load papers for entity", err);
        if (request.cancelled) return;
        if (page === 1) setPapers([]);
        setPapersError('PUBLICATIONS_LOAD_FAILED');
        setHasMore(false); // Stop infinite looping on errors
      }
      if (request.cancelled) return;
      setIsLoadingPapers(false);
      setIsFetchingMore(continuing);
    }
    loadPapers();
    // No cleanup: a request is superseded by key, above, and cancelled on
    // unmount, below — not by the next render of the same request.
  }, [afterPageArrival, type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, searchParams, papersReloadKey, entityReloadKey, publicMode, requestNextPapersPage]);

  useEffect(() => () => {
    if (papersRequestRef.current) papersRequestRef.current.cancelled = true;
  }, []);

  useEffect(() => {
    let isCancelled = false;
    async function loadAuthors() {
      if (!entity || type === 'author' || entity._localTopic || entity._queryTopic || !authorsOpened) return;
      // The list a resumed visit came back with is the list: fetching it
      // again would put the skeleton rows over it for the frames the cache
      // takes to answer. Once, for the mount that resumed.
      if (resumedAuthorsRef.current) {
        resumedAuthorsRef.current = false;
        return;
      }
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
  // Per-area counts for the filter panel, over the papers loaded with no area
  // chosen. Once an area is chosen the source returns that area alone, so the
  // last whole-list counts stand until the area is cleared again.
  const [areaCounts, setAreaCounts] = useState<Record<string, number> | null>(null);
  const [countedPapers, setCountedPapers] = useState<typeof papers | null>(null);
  if (!filters.category && !isLoadingPapers && countedPapers !== papers) {
    setCountedPapers(papers);
    setAreaCounts(countPapersByArea(papers, Object.keys(CATEGORIES)));
  }
  const facetAreas = Object.entries(CATEGORIES)
    .map(([key, cat]) => ({ key, label: cat.label, accent: cat.gradient, count: areaCounts?.[key] ?? 0 }))
    .filter(area => area.count > 0 || area.key === filters.category)
    .sort((a, b) => b.count - a.count);

  // The entity's own total while the list is unfiltered; once a search or a
  // filter narrows it, what is loaded and matches, with a "+" while more pages
  // remain. Nothing while the first page is still on its way.
  const papersCountLabel = !searchQuery && activeFilterCount === 0 && typeof entity?.works_count === 'number'
    ? entity.works_count.toLocaleString(locale)
    : isLoadingPapers ? '' : `${filteredPapers.length.toLocaleString(locale)}${hasMore ? '+' : ''}`;

  // A reload keeps the count it replaces until the new one lands, so the tab
  // does not shrink to its bare label and grow back. Another entity starts clean.
  const [heldCount, setHeldCount] = useState({ key: visitKey, label: papersCountLabel });
  if (heldCount.key !== visitKey || (papersCountLabel && papersCountLabel !== heldCount.label)) {
    setHeldCount({ key: visitKey, label: papersCountLabel });
  }
  const shownCountLabel = heldCount.key === visitKey ? heldCount.label : papersCountLabel;

  // The selected tab's pill slides to the tab picked. It takes its first
  // place without moving: the slide is switched on after that first paint.
  const segRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const seg = segRef.current;
    const pill = seg?.querySelector<HTMLElement>('.ee-seg-pill');
    const active = seg?.querySelector<HTMLElement>('[data-pressed]');
    if (!seg || !pill || !active) return;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translateX(${active.offsetLeft}px)`;
    if (!seg.hasAttribute('data-ready')) requestAnimationFrame(() => seg.setAttribute('data-ready', ''));
  }, [activeTab, shownCountLabel, entity]);

  // The rows on screen now, and the ones still to come in idle chunks. The
  // "load more" sentinel waits for the whole page to be in, or it would sit
  // right under the first chunk and ask for the next page at once.
  const mountedPapers = useMemo(() => filteredPapers.slice(0, rowBudget), [filteredPapers, rowBudget]);
  // What a visitor without an account is shown of it: the first two rows, and
  // the wall below. The cut is here rather than in the fetch because page 1
  // arrives whole and is what the entity's own numbers are drawn from; what
  // the cut does prevent is page 2, by taking the sentinel off the page.
  const visiblePapers = useMemo(() => guestPreviewRows(mountedPapers, { publicMode }), [mountedPapers, publicMode]);
  const visibleAuthors = useMemo(() => guestPreviewRows(entityAuthors, { publicMode }), [entityAuthors, publicMode]);
  const papersGateOpen = shouldShowGuestGate({
    publicMode,
    loaded: filteredPapers.length,
    hasMore,
    isLoading: isLoadingPapers,
  });
  const authorsGateOpen = shouldShowGuestGate({
    publicMode,
    loaded: entityAuthors.length,
    hasMore: hasMoreAuthors,
    isLoading: isLoadingAuthors,
  });
  const rowsSettled = rowBudget >= filteredPapers.length;
  // What the foot of the list says once it waits for "Keep looking", and what
  // each press found. Nothing before that: the pages the list asks for on its
  // own have the sentinel's spinner. A failed page under rows is said here
  // too, because the error strip is inserted with its text already in it and
  // a screen reader may not announce it. With no rows the error state is an
  // alert and says it.
  let papersMoreStatus: string | null = null;
  if (papersAwaitReader) {
    if (isFetchingMore) papersMoreStatus = 'Checking more publications…';
    else if (hasMore && filteredPapers.length === 0) papersMoreStatus = 'No matches yet. More publications remain to check.';
    else if (hasMore) papersMoreStatus = `${filteredPapers.length.toLocaleString(locale)} listed so far. More publications remain to check.`;
    else if (!papersError) papersMoreStatus = 'No more publications to check.';
    else if (filteredPapers.length > 0) papersMoreStatus = 'More publications could not be checked.';
  }
  useEffect(() => {
    if (rowsSettled) return undefined;
    const schedule = typeof window.requestIdleCallback === 'function'
      ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 400 })
      : (fn: () => void) => setTimeout(fn, 32);
    const cancel = typeof window.cancelIdleCallback === 'function'
      ? (id: number) => window.cancelIdleCallback(id)
      : (id: number) => clearTimeout(id);
    const handle = schedule(() => setRowBudget((budget) => nextExplorerRowBudget(budget, filteredPapers.length)));
    return () => cancel(handle);
  }, [rowsSettled, rowBudget, filteredPapers.length]);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (activeTab === 'papers') {
          // A new observer reports the foot where it already is, so a page
          // that left it on screen asks again at once: that request is the
          // list's own, and the reader's only once the foot had gone. Only
          // while no page loads: the skeleton of a new list pushes the old
          // foot off screen without the reader moving.
          if (!entries[0].isIntersecting) {
            if (!isLoadingPapers && !isFetchingMore) papersFootHiddenRef.current = true;
          } else if (hasMore && !isLoadingPapers && !isFetchingMore) {
            requestNextPapersPage(papersFootHiddenRef.current);
          }
        } else if (entries[0].isIntersecting && activeTab === 'authors' && hasMoreAuthors && !isLoadingAuthors && !isFetchingMoreAuthors) {
          setAuthorsPage(p => p + 1);
        }
      },
      { threshold: 0.1 }
    );
    if (activeTab === 'papers' && observerRef.current) observer.observe(observerRef.current);
    if (activeTab === 'authors' && observerAuthorsRef.current) observer.observe(observerAuthorsRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingPapers, isFetchingMore, hasMoreAuthors, isLoadingAuthors, isFetchingMoreAuthors, activeTab, rowsSettled, papersAwaitReader, requestNextPapersPage]);

  const handleFollow = (event: MouseEvent) => {
    event.stopPropagation();
    if (!followEntity) return;

    if (publicMode) {
      requestAccount();
      return;
    }
    toggleFollow(followEntity).catch(console.error);
  };

  const heroActions = (followEntity || publicEntityUrl || heroLinks.length > 0) && (
    <div className="ehc-actions">
      {followEntity && (
        <FollowToggle
          pressed={entityIsFollowing}
          onClick={handleFollow}
          disabled={entityFollowPending}
          followLabel={'Follow'}
          followingLabel={'Following'}
          compact={isPhone}
        />
      )}
      {publicEntityUrl && (
        <SharePanel
          title={entityDisplayName || 'PaperTok'}
          url={publicEntityUrl}
              side="bottom"
          align="start"
          links={usesSheet ? [] : heroLinks}
          onShared={(method) => trackEvent('share', { method, content_type: analyticsEntityType, surface: 'explorer' })}
          trigger={isPhone ? (
            <Button variant="outline" size="icon-sm" className="ehc-share" aria-label="Share">
              <ShareNetwork size={16} aria-hidden="true" />
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="ehc-share">
              <ShareNetwork size={16} aria-hidden="true" />
              {'Share'}
            </Button>
          )}
        />
      )}
      {heroLinks.length > 0 && !usesSheet && !(isPhone && publicEntityUrl) && (
        <div className="ehc-links">
          {heroLinks.map(({ label, href }) => (
            <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="ehc-link">
              {label} <ArrowSquareOut size={14} aria-hidden="true" />
            </a>
          ))}
        </div>
      )}
    </div>
  );

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

  const openParticipantInstitution = async (participant: ProjectParticipant) => {
    setResolvingParticipant(participant.name);
    try {
      const institution = await findInstitution({
        name: participant.searchName || participant.name,
        aliases: [participant.name!],
      });
      if (institution) {
        navigateToEntity('institution', institution.id);
      } else {
        toast.error(`We could not find an institution profile for ${participant.name}.`);
      }
    } catch (error) {
      console.error('Failed to resolve project participant', error);
      toast.error(`We could not open ${participant.name}. Try again.`);
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
        navigateToEntity('institution', (institutionId || rorId)!);
        return;
      }

      const institution = await findInstitution({
        name: institutionName,
        aliases: [knownInstitution?.display_name, entity?.institution].filter(Boolean) as string[],
      });

      if (institution?.id) {
        navigateToEntity('institution', institution.id.split('/').pop()!);
      } else {
        setAuthorInstitutionNavigationError('We could not find this institution profile.');
      }
    } catch (error) {
      console.error('Failed to resolve author institution', error);
      setAuthorInstitutionNavigationError('We could not open this institution. Try again.');
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
    const shape = explorerSkeletonShape(type);
    return (
      <div
        className={`explorer-container explorer-skeleton explorer-skeleton--${type || 'entity'}${appChromeClass}`}
        role="status"
        aria-busy="true"
        aria-label={'Loading'}
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
              <Button variant="ghost" size="icon" onClick={handleBack} aria-label={'Back'} title={'Back'}>
                <ArrowLeft size={20} />
              </Button>
            </div>
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
                  <div className="ex-skel ex-skel-type"></div>
                  {/* The metadata line every type puts under the name: an
                      author's institution, an institution's city, a project's
                      funder. It lives inside `.ehc-info` on the live page, and
                      the standalone `.ehc-meta` block that used to stand in for
                      it down here was counting the same line twice. */}
                  <div className="ex-skel ex-skel-sub ex-skel-sub--medium"></div>

                  {/* The strip under the name: an institution's credentials. */}
                  {shape.identity === 'credentials' && (
                    <div className="ehc-tag-row ex-skel-strip">
                      <span className="ex-skel ex-skel-chip" style={{ width: 104 }} />
                      <span className="ex-skel ex-skel-chip" style={{ width: 72 }} />
                    </div>
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
            {shape.aside === 'summary' && <ProjectSummarySkeleton />}
          </div>

        </div>

        {/* The search toolbar is not part of the hero, and was missing too. */}
        <div className="explorer-toolbar-wrapper">
          <div className="explorer-toolbar">
            <div className={`ex-skel ex-skel-seg${shape.tabs > 1 ? '' : ' ex-skel-seg--one'}`}></div>
            <div className="ex-skel ex-skel-search"></div>
          </div>
        </div>

        {/* The real container, not a stand-in for it: the rows that replace
            these land in the same grid with the same rules, so nothing moves
            when the words arrive. */}
        <div className="explorer-content" aria-hidden="true">
          <div className="explorer-grid">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="list-row ex-skel-row">
                <div className="ex-skel ex-skel-kicker"></div>
                <div className="ex-skel ex-skel-title"></div>
                <div className="ex-skel ex-skel-title"></div>
                <div className="ex-skel ex-skel-dots"></div>
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
        <div className="empty-state-art" aria-hidden="true">
          <Petri pose={entityError ? 'upset' : 'lost'} />
        </div>
        <h1>{entityError
          ? ('The entity could not be loaded')
          : ('Entity not found')}</h1>
        {entityError ? (
          <p role="alert">{getUiErrorMessage(entityError, 'ENTITY_LOAD_FAILED')}</p>
        ) : (
          <p>
            {'The source has no record for this page. It may have been merged with another one or removed.'}
          </p>
        )}
        <div className="explorer-error-actions">
          {entityError && (
            <Button onClick={retryEntity}>
              <ArrowsClockwise size={16} aria-hidden="true" />
              {'Try again'}
            </Button>
          )}
          <Button variant="outline" onClick={handleBack}>
            <ArrowLeft size={16} aria-hidden="true" />
            {'Back'}
          </Button>
        </div>
      </div>
    );
  }

  const authorNameWords = (entityDisplayName || '').split(/\s+/).filter(word => /^\p{L}/u.test(word));
  const authorInitials = authorNameWords.length > 0
    ? `${authorNameWords[0][0]}${authorNameWords.length > 1 ? authorNameWords[authorNameWords.length - 1][0] : ''}`.toUpperCase()
    : '';

  const renderIcon = () => {
    if (type === 'institution') return <Buildings size={36} />;
    if (type === 'concept' || type === 'topic') return <Lightbulb size={36} />;
    if (type === 'source') return <FileText size={36} />;
    if (type === 'project') return <Briefcase size={36} />;
    if (type === 'author' && authorInitials) return <span className="ehc-initials">{authorInitials}</span>;
    return <Users size={36} />;
  };

  const entityTypeLabel = type === 'author'
    ? ('Author')
    : type === 'institution'
      ? ('University / Institution')
      : type === 'source'
        ? ('Journal')
        : type === 'project'
          ? ('Research project')
          : ('Topic');
  const topConcepts = entity.x_concepts ? entity.x_concepts.slice(0, 4) : [];

  const projectTimeline = type === 'project' && entity.startDate && (
    <ProjectTimeline startDate={entity.startDate} endDate={entity.endDate} />
  );

  const sheetLinks = type === 'project' ? [
    ...(entity.openaireId ? [{
      href: `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}`,
      rel: 'noreferrer',
      Icon: Buildings,
      title: 'OpenAIRE record',
      note: 'Data, publications, and participants',
    }] : []),
    ...(safeProjectWebsiteUrl ? [{
      href: safeProjectWebsiteUrl,
      rel: 'noopener noreferrer',
      Icon: Globe,
      title: 'Official website',
      note: 'The project’s own website',
    }] : []),
  ] : type === 'institution' ? [
    ...(safeHomepageUrl ? [{
      href: safeHomepageUrl,
      rel: 'noopener noreferrer',
      Icon: Globe,
      title: 'Official website',
      note: 'The institution’s own website',
    }] : []),
    ...(safeRorUrl ? [{
      href: safeRorUrl,
      rel: 'noopener noreferrer',
      Icon: SealCheck,
      title: 'ROR record',
      note: 'Its entry in the Research Organization Registry',
    }] : []),
  ] : isOpenAlexTopic ? [
    ...(safeExternalUrl(entity.ids?.wikipedia) ? [{
      href: safeExternalUrl(entity.ids?.wikipedia)!,
      rel: 'noopener noreferrer',
      Icon: Globe,
      title: 'Wikipedia',
      note: 'The article OpenAlex links to this topic',
    }] : []),
    {
      href: `https://openalex.org/${String(entity.id || id).split('/').pop()}`,
      rel: 'noopener noreferrer',
      Icon: Lightbulb,
      title: 'OpenAlex record',
      note: 'Works, keywords and related topics',
    },
  ] : [];
  const sheetLinksSection = sheetLinks.length > 0 && (
    <div className="project-links-menu">
      <h4 className="project-section-title"><Globe size={14} /> {'Links'}</h4>
      <ul className="project-links-list">
        {sheetLinks.map(({ href, rel, Icon, title, note }) => (
          <li key={title}>
            <a className="project-links-option" href={href} target="_blank" rel={rel}>
              <span className="project-links-option-icon"><Icon size={16} /></span>
              <span>
                <strong>{title}</strong>
                <small>{note}</small>
              </span>
              <ArrowSquareOut size={14} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );

  const statsGrid = (
    <div className="ehc-stats-grid">
      {entity?.works_count != null && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">{entity.works_count.toLocaleString(locale)}</span>
          <span className="ehc-stat-label">{'Publications'}</span>
        </div>
      )}
      {entity?.cited_by_count != null && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">{entity.cited_by_count.toLocaleString(locale)}</span>
          <span className="ehc-stat-label">{'Total citations'}</span>
        </div>
      )}
      {(entity?.summary_stats?.h_index != null || entity?.h_index != null) && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">{entity?.summary_stats?.h_index ?? entity?.h_index}</span>
          <span className="ehc-stat-label">{type === 'source' ? ('Type') : 'H-Index'}</span>
        </div>
      )}
      {['institution', 'author'].includes(type) && (
        <RecentImpactStat
          impact={recentImpact}
          isLoading={isLoadingRecentImpact}
          error={recentImpactError}
         
        />
      )}
      {type === 'project' && entity._detailsPending && [1, 2].map((n) => (
        <div key={`stat-reserved-${n}`} className="ehc-stat-box" aria-hidden="true">
          <span className="ex-skel ex-skel-stat-value"></span>
          <span className="ex-skel ex-skel-stat-label"></span>
        </div>
      ))}
      {type === 'project' && (entity.budget as number) > 0 && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">
            {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.budget!); } catch { return entity.budget!.toLocaleString(locale); } })()}
          </span>
          <span className="ehc-stat-label">{'Total budget'}</span>
        </div>
      )}
      {type === 'project' && (entity.fundedAmount as number) > 0 && entity.fundedAmount! !== entity.budget! && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">
            {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.fundedAmount!); } catch { return entity.fundedAmount!.toLocaleString(locale); } })()}
          </span>
          <span className="ehc-stat-label">{'Funding'}</span>
        </div>
      )}
      {type === 'project' && (entity.participants?.length as number) > 0 && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">{entity.participants!.length}</span>
          <span className="ehc-stat-label">{'Participants'}</span>
        </div>
      )}
      {type === 'project' && (entity.measures?.citations as number) > 0 && (
        <div className="ehc-stat-box">
          <span className="ehc-stat-value">{entity.measures!.citations!.toLocaleString(locale)}</span>
          <span className="ehc-stat-label">{'Citations'}</span>
        </div>
      )}
    </div>
  );

  const renderParticipant = (p: ProjectParticipant, i: number) => (
    <button
      key={`${p.name}-${p.country || i}`}
      type="button"
      className="project-participant-card"
      onClick={() => openParticipantInstitution(p)}
      disabled={resolvingParticipant === p.name}
      aria-label={`${'Open institution profile for'} ${p.name}`}
    >
      <span className="project-participant-info">
        <ParticipantName name={p.name || ''} />
        {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
      </span>
      {resolvingParticipant === p.name
        ? <CircleNotch size={15} className="ehc-spinner" aria-hidden="true" />
        : <CaretRight size={15} className="project-participant-arrow" aria-hidden="true" />}
    </button>
  );
  const projectParticipants = type === 'project' && (entity.participants?.length as number) > 0 && (isPhone ? (
    <Drawer>
      <DrawerTrigger render={<Button variant="ghost" className="project-participants-trigger" />}>
        <Buildings size={16} aria-hidden="true" />
        <span>{'Participating organizations'}</span>
        <span className="project-participants-count">{entity.participants!.length}</span>
        <CaretRight size={15} aria-hidden="true" />
      </DrawerTrigger>
      <DrawerContent className="pc-share-sheet">
        <DrawerHandle />
        <DrawerTitle render={<h3 />} className="pc-share-sheet-title">{'Participating organizations'}</DrawerTitle>
        <ul className="pc-share-list project-participants-sheet">
          {entity.participants!.map((p, i) => (
            <li key={`${p.name}-${p.country || i}`}>
              <button
                type="button"
                className="pc-share-row"
                onClick={() => openParticipantInstitution(p)}
                disabled={resolvingParticipant === p.name}
                aria-label={`${'Open institution profile for'} ${p.name}`}
              >
                <span className="project-participant-info">
                  <span className="project-participant-name">{p.name}</span>
                  {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
                </span>
                {resolvingParticipant === p.name
                  ? <CircleNotch size={15} className="ehc-spinner" aria-hidden="true" />
                  : <CaretRight size={15} className="project-participant-arrow" aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      </DrawerContent>
    </Drawer>
  ) : (
      <div className="project-participants">
        <h4 className="project-section-title"><Buildings size={14} /> {'Participating organizations'}</h4>
        <div id="project-participants-list" className="project-participants-grid">
          {entity.participants!.slice(0, PARTICIPANTS_SHOWN).map(renderParticipant)}
          <AnimatePresence initial={false}>
            {participantsExpanded && (
              <motion.div
                key="more"
                className="project-participants-more"
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, transition: EXPERIENCE_FOLD_OUT }}
                transition={prefersReducedMotion
                  ? { duration: 0 }
                  : { opacity: { duration: 0.24, ease: 'linear' }, height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] } }}
              >
                {entity.participants!.slice(PARTICIPANTS_SHOWN).map((p, i) => renderParticipant(p, PARTICIPANTS_SHOWN + i))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {entity.participants!.length > PARTICIPANTS_SHOWN && (
          <button
            className="project-show-more"
            onClick={() => setParticipantsExpanded(value => !value)}
            aria-expanded={participantsExpanded}
            aria-controls="project-participants-list"
          >
            {participantsExpanded
              ? ('Show fewer organizations')
              : `+${entity.participants!.length - PARTICIPANTS_SHOWN} ${'more organizations'}`}
          </button>
        )}
      </div>
  ));

  const institutionRelations = type === 'institution' && (entity.relationships?.length as number) > 0 && (
    <div className="project-participants">
      <h4 className="project-section-title"><Buildings size={14} /> {'Related institutions'}</h4>
      <div className="project-participants-grid">
        {entity.relationships!.slice(0, 4).map((relationship) => {
          const label = ROR_RELATION_LABELS[language][relationship.type as keyof typeof ROR_RELATION_LABELS.en] || ROR_RELATION_LABELS[language].related;
          return (
            <button
              key={`${relationship.type}-${relationship.rorId}`}
              type="button"
              className="project-participant-card"
              onClick={() => navigateToEntity('institution', relationship.rorId)}
              aria-label={`${label}: ${relationship.label}`}
            >
              <span className="project-participant-info">
                <ParticipantName name={relationship.label || ''} />
                <span className="project-participant-country">{label}</span>
              </span>
              <CaretRight size={15} className="project-participant-arrow" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </div>
  );

  const topicRelations = isOpenAlexTopic && (entity.siblings?.length as number) > 0 && (
    <div className="project-participants">
      <h4 className="project-section-title"><Lightbulb size={14} /> {'Related topics'}</h4>
      <div className="project-participants-grid">
        {entity.siblings!.slice(0, 3).map(sibling => (
          <button
            key={sibling.id}
            type="button"
            className="project-participant-card"
            onClick={() => navigateToEntity('topic', String(sibling.id).split('/').pop()!)}
            aria-label={`Open topic ${sibling.display_name}`}
          >
            <span className="project-participant-info">
              <ParticipantName name={sibling.display_name} />
            </span>
            <CaretRight size={15} className="project-participant-arrow" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );

  const entitySheet = usesSheet && (
    <aside className="ehc-project-aside" aria-label={type === 'project' ? 'Project facts' : type === 'institution' ? 'Institution facts' : 'Topic facts'}>
      <div className="ehc-project-sheet">
        {statsGrid}
        {projectParticipants}
        {topicRelations}
        {sheetLinksSection}
      </div>
    </aside>
  );

  // The type rides on the live container, the way the skeleton already carries
  // it (`explorer-skeleton--${type}`). What a project fills in late — its stat
  // cells, its link menu — needs an entrance the other entity types must not
  // inherit, and there was no hook for that here.
  const filterControls = (
    <>
    <div className="ee-filter-body">
      <div className="ee-filter-section">
        <h4>{'Area'}</h4>
        <ToggleGroup
          className="ee-facets"
          aria-label={'Area'}
          value={[filters.category || 'all']}
          onValueChange={([next]) => {
            if (next !== undefined) setFilters({ ...filters, category: next === 'all' ? '' : next });
          }}
        >
          <ToggleGroupItem value="all" className="ee-facet">
            <span className="ee-facet-dot" aria-hidden="true" />
            {'All areas'}
          </ToggleGroupItem>
          {facetAreas.map(area => (
            <ToggleGroupItem
              key={area.key}
              value={area.key}
              className="ee-facet"
              style={{ '--area-accent': area.accent }}
            >
              <span className="ee-facet-dot" aria-hidden="true" />
              {area.label}
              {areaCounts && <span className="ee-facet-count">{`${area.count.toLocaleString(locale)}${hasMore ? '+' : ''}`}</span>}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="ee-filter-section">
        <h4>{'Sort by'}</h4>
        <ToggleGroup
          variant="outline"
          className="ee-filter-chips"
          aria-label={'Sort by'}
          value={[sortBy]}
          onValueChange={([next]) => { if (next !== undefined) setSortBy(next); }}
        >
          <ToggleGroupItem value="cited_by_count:desc" className="ee-filter-chip">
            {'Most cited'}
          </ToggleGroupItem>
          <ToggleGroupItem value="publication_date:desc" className="ee-filter-chip">
            {'Most recent'}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="ee-filter-section">
        <h4>{'Published'}</h4>
        <ToggleGroup
          variant="outline"
          className="ee-filter-chips"
          aria-label={'Published'}
          value={[filters.dateRange || 'any']}
          onValueChange={([next]) => {
            if (next !== undefined) setFilters({ ...filters, dateRange: next === 'any' ? '' : next });
          }}
        >
          {['any', 'last_year', 'last_5_years'].map(val => (
            <ToggleGroupItem key={val} value={val} className="ee-filter-chip">
              {val === 'any'
                ? ('Any time')
                : val === 'last_year'
                  ? ('Last year')
                  : ('Last 5 years')}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="ee-filter-section">
        <Label className="ee-toggle-label">
          <Switch
            checked={filters.peerReviewed}
            onCheckedChange={(checked) => setFilters({ ...filters, peerReviewed: checked })}
          />
          {'Peer-reviewed only'}
        </Label>
      </div>
    </div>
    <div className="ee-filter-footer">
      <Button variant="outline" className="ee-filter-reset" onClick={() => { setFilters({category:'', peerReviewed:false, dateRange:''}); setShowFilters(false); }}>
        {'Reset'}
      </Button>
      <Button className="ee-filter-apply" onClick={() => setShowFilters(false)}>
        {isLoadingPapers ? 'Show papers' : `Show ${filteredPapers.length.toLocaleString(locale)}${hasMore ? '+' : ''} papers`}
      </Button>
    </div>
    </>
  );

  return (
    <div className={`explorer-container explorer-container--${type || 'entity'}${appChromeClass}`} style={{ '--area-accent': entityAccent }}>
      {/* Immersive Hero */}
      <div className="explorer-hero">
        
        <div className="explorer-hero-top">
          <div className="eht-left">
            <Button variant="ghost" size="icon" onClick={handleBack} aria-label={'Back'} title={'Back'}>
              <ArrowLeft size={20} />
            </Button>
          </div>
          {/* Every page keeps its actions in the bar, across from the way
              back, and leaves the header below to the entity itself. */}
          {heroActions}
        </div>
        
        <div className="explorer-hero-content" ref={heroBodyRef}>
          <div className={`ehc-layout${usesSheet ? ' ehc-layout--sheet' : ''}`}>
          <div className="ehc-layout-main">
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
            {type !== 'project' && (
            <div className="ehc-visual-slot">
              <motion.div
                className="ehc-icon"
                initial={false}
                animate={{ opacity: hasLoadedWikiImage ? 0 : 1, scale: hasLoadedWikiImage ? 0.96 : 1 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT_EXPO }}
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
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: EASE_OUT_EXPO }}
                    className="ehc-wiki-image"
                  >
                    <img
                      src={visibleWikiInfo.thumbnail}
                      alt={entityDisplayName}
                      onLoad={() => setLoadedWikiImageUrl(visibleWikiInfo.thumbnail!)}
                      onError={() => setLoadedWikiImageUrl('')}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            )}
            <div className="ehc-info">
              <div className="ehc-title-row">
                {/* The type label stands in for a name the entity does not
                    have — a project whose lookup failed on a route with no
                    `?name=`. It stands in HERE, not in `entity.display_name`,
                    which is the follow identity; and being read on every
                    render it follows a language toggle without a remount. */}
                <div className="ehc-name-line">
                  <h1 className="ehc-name" style={{ margin: 0 }}>{entityDisplayName || entityTypeLabel}</h1>
                  {type === 'author' && orcidInfo && !isLoadingOrcid && <OrcidStamp orcid={orcidInfo.orcid} />}
                </div>
                {type === 'author' && (orcidInfo?.employments?.length as number) > 0 && (
                  <button
                    type="button"
                    className={`ehc-name-toggle ${isExperienceOpen ? 'is-open' : ''}`}
                    onClick={() => { setExperienceToggled(true); setIsExperienceOpen(open => !open); }}
                    aria-expanded={isExperienceOpen}
                    aria-controls="ehc-experience-panel"
                    aria-label={'Professional experience'}
                    title={'Professional experience'}
                  >
                    <Briefcase size={15} aria-hidden="true" />
                    <CaretDown size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              {type === 'institution' && (
                <p className="ehc-meta">
                  {[entity.geo?.city, entity.geo?.country].filter(Boolean).join(', ')}
                </p>
              )}
              {type === 'project' && (entity.subjects?.length as number) > 0 ? (
                <div className="ehc-tag-row">
                  <span className="ehc-type">{entityTypeLabel}</span>
                  {entity.subjects!.map((subject, i) => (
                    <span key={i} className="ehc-type ehc-type--subject">{subject}</span>
                  ))}
                </div>
              ) : type === 'institution' && ((entity.rorVerified && safeRorUrl) || entity.established) ? (
                <div className="ehc-tag-row">
                  <span className="ehc-type">{entityTypeLabel}</span>
                  {entity.rorVerified && safeRorUrl && (
                    <span className="ehc-type ehc-type--verified"><SealCheck size={13} aria-hidden="true" /> {'ROR verified'}</span>
                  )}
                  {entity.established && <span className="ehc-type ehc-type--subject">{`Since ${entity.established}`}</span>}
                </div>
              ) : type !== 'author' && (
                <span className="ehc-type">{entityTypeLabel}</span>
              )}
              {type === 'author' && authorInstitutionDisplayName && (
                <div className="ehc-author-institution-wrap">
                  <button
                    type="button"
                    className="ehc-author-institution"
                    onClick={openAuthorInstitution}
                    disabled={isResolvingAuthorInstitution}
                    title={'View institution'}
                  >
                    {isResolvingAuthorInstitution ? <CircleNotch className="spinning" size={15} /> : <Buildings size={15} />}
                    <span>{authorInstitutionDisplayName}</span>
                  </button>
                  {authorInstitutionNavigationError && (
                    <p className="ehc-author-institution-error" role="alert">{authorInstitutionNavigationError}</p>
                  )}
                </div>
              )}
              {topConcepts.length > 0 && type !== 'author' && (
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

          {!usesSheet && (
            <div className="ehc-hero-aside">
            {statsGrid}
            {authorIdentityUnverified && (
              <p className="ehc-identity-note">
                {'Found by name: these results may mix people who share it.'}
              </p>
            )}
            {type === 'author' && (entity.counts_by_year?.length as number) > 0 && (
              <AuthorActivity counts={entity.counts_by_year!} />
            )}
            </div>
          )}
          </div>

          {projectTimeline}
          {institutionRelations}
          {isOpenAlexTopic && entity.description && (
            <div className="ehc-topic-about">
              <p className="ehc-topic-description">{entity.description}</p>
              <span className="ehc-topic-source">{'Description from OpenAlex'}</span>
            </div>
          )}

          {/* Professional experience — a disclosure opened from the chevron by the name */}
          {type === 'author' && (orcidInfo?.employments?.length as number) > 0 && (
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
                  // Clear the text before the fold finishes closing. The
                  // height has the same gentle curve in both directions;
                  // only the opacity gets a shorter clock on the way out.
                  exit={prefersReducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, height: 0, transition: EXPERIENCE_FOLD_OUT }}
                  transition={prefersReducedMotion
                    ? { duration: 0 }
                    : {
                      // The contents clear a little before the box finishes
                      // closing, so the last thing seen is an empty fold
                      // rather than text being guillotined by the clip.
                      opacity: { duration: experienceToggled ? 0.24 : 0.36, ease: 'linear' },
                      height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                    }}
                >
                  <div className="ehc-experience-inner">
                  <div className="ehc-experience-title">
                    <Briefcase size={13} aria-hidden="true" />
                    {'Professional experience'}
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo!.employments.map((emp, i) => (
                      <div key={i} className="orcid-timeline-item" style={{ '--author-row-delay': `${Math.min(i, 4) * 40}ms` }}>
                        <button
                          type="button"
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: emp.ror, name: emp.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          }}
                          title={`${'Find and view profile for'} ${emp.organization}`}
                        >
                          {emp.organization}
                        </button>
                        {emp.role && <div className="orcid-item-role">{emp.role}</div>}
                        {emp.startDate && (
                          <div className="orcid-item-dates">
                            {emp.startDate}
                            <span className="dot-separator">→</span>
                            {emp.endDate || ('Present')}
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
                  ? ('Collapse project summary')
                  : ('Expand project summary')
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
                  <CaretDown size={14} /> {expandedSummary
                    ? ('Show less')
                    : ('Read more')}
                </span>
              )}
            </div>
          )}
          </div>
          {entitySheet}
          </div>

          

          {/* ORCID Career Section */}
          {orcidInfo && !isLoadingOrcid && (orcidInfo.biography || orcidInfo.researcherUrls?.length > 0 || orcidInfo.educations?.length > 0) && (
            <div className="orcid-career-section orcid-career-section--animate">
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
                        {u.name || ('External link')}
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
                    {'Education'}
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo.educations.map((edu, i) => (
                      <div key={i} className="orcid-timeline-item orcid-timeline-item--edu">
                        <button
                          type="button"
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: edu.ror, name: edu.organization });
                            if (inst) navigateToEntity('institution', inst.id);
                          }}
                          title={`${'Find and view profile for'} ${edu.organization}`}
                        >
                          {edu.organization}
                        </button>
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
        
      </div>

      {/* Sticky Toolbar Wrapper */}
      <div className="explorer-toolbar-wrapper">
        <div className="explorer-toolbar">
          {/* One choice of two, so a single-select ToggleGroup: Base UI marks
              the pressed one and moves between them on the arrow keys. The
              open list cannot be un-chosen, so an empty value is ignored. */}
          <ToggleGroup
            ref={segRef}
            className="ee-seg"
            aria-label={'List'}
            value={[activeTab]}
            onValueChange={([next]) => { if (next) openTab(next); }}
          >
            <span className="ee-seg-pill" aria-hidden="true" />
            <ToggleGroupItem value="papers">
              {'Papers'}
              <span className="ee-list-count" aria-hidden={shownCountLabel ? undefined : true}>{shownCountLabel || '–'}</span>
            </ToggleGroupItem>
            {hasAuthorsTab(type, entity) && (
              <ToggleGroupItem value="authors">{'Authors'}</ToggleGroupItem>
            )}
          </ToggleGroup>
          {/* A visitor sees the search — it is part of what an account opens —
              but searching two preview rows would answer "nothing matches" to
              almost everything. It used to be a read-only text field that
              swallowed typing in silence (audit 2026-09-23, issue 10): now it
              is what it does, a button shaped like the field that says it
              needs an account and opens the door with that reason. */}
          <div className="explorer-search-box">
            {publicMode ? (
              <button
                type="button"
                className="explorer-search-gate"
                onClick={() => requestAccount('explorer_search')}
              >
                <MagnifyingGlass size={16} className="es-icon" aria-hidden="true" />
                <span className="explorer-search-gate-label">{guestSearchLabel}</span>
              </button>
            ) : (
              <>
                <MagnifyingGlass size={16} className="es-icon" />
                <Input
                  type="text"
                  className="explorer-search-input"
                  placeholder={`Search ${activeTab === 'papers' ? 'papers' : 'authors'} from ${type === 'institution' ? 'this institution' : type === 'concept' || type === 'topic' ? 'this topic' : type === 'project' ? 'this project' : 'this person'}...`}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  aria-label={`Search ${activeTab === 'papers' ? 'publications' : 'authors'} in this entity`}
                />
                {searchQuery && (
                  <Button variant="ghost" size="icon-sm" className="es-clear" onClick={() => setSearchQuery('')} aria-label={'Clear search'} title={'Clear search'}>
                    <X size={14} />
                  </Button>
                )}
              </>
            )}
            {activeTab === 'papers' && (
              <>
                <span className="explorer-search-rule" aria-hidden="true" />
                <Button
                  variant="ghost"
                  className={`explorer-filter-trigger${activeFilterCount > 0 ? ' is-active' : ''}`}
                  onClick={publicMode ? () => requestAccount('explorer_search') : () => setShowFilters(true)}
                  title={'Open filters'}
                >
                  <Funnel size={16} aria-hidden="true" />
                  <span className="explorer-filter-label">{activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : 'Filters'}</span>
                </Button>
              </>
            )}
          </div>
          </div>
          {activeTab === 'papers' && activeFilterChips.length > 0 && (
            <div className="ee-chips">
              {activeFilterChips.map(chip => (
                <Button key={chip.key} variant="outline" size="sm" className="ee-chip" onClick={chip.clear} aria-label={`Remove filter: ${chip.label}`}>
                  {chip.label}
                  <X size={12} aria-hidden="true" />
                </Button>
              ))}
            </div>
          )}
        </div>

      <div className="explorer-content">
        {activeTab === 'papers' ? (
          <>

            
            <div className="explorer-grid">
              {(!isLoadingPapers || isFetchingMore) && visiblePapers.map((paper, idx) => (
                <PaperListRow
                  key={`${paper.id}-${idx}`}
                  paper={paper}
                  onOpen={() => setSelectedPaper(paper)}
                  aside={hasKnownPaperCitationCount(paper) && (
                    `${getPaperCitationCount(paper).toLocaleString(locale)} ${getPaperCitationCount(paper) === 1 ? 'citation' : 'citations'}`
                  )}
                >
                  {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                </PaperListRow>
              ))}

              {isLoadingPapers && !isFetchingMore && [1, 2, 3, 4, 5].map((n) => (
                  <div
                    key={`skeleton-${n}`}
                    className="list-row ex-skel-row"
                    aria-hidden="true"
                  >
                    <div className="ex-skel ex-skel-kicker"></div>
                    <div className="ex-skel ex-skel-title"></div>
                    <div className="ex-skel ex-skel-title"></div>
                    <div className="ex-skel ex-skel-dots"></div>
                  </div>
                ))}


              {/* Infinite Scroll Sentinel — once every row of this page is in.
                  The box always mounts, because it IS the observer's target and
                  gating it on the fetch would leave nothing to observe. What is
                  gated is the spinner and the claim: `hasMore` only says there
                  is a next page, so an ungated `spin 1s infinite` sat at the
                  foot of every list announcing a request that had not started.
                  A spinner that spins when nothing is loading is the one kind
                  of motion with no state to indicate. */}
              {/* Before the sentinel, not after it. Measured 2026-09-12 on
                  papertok.app: the strip rendered below the sentinel, so a
                  reader at the foot of the list read "Loading more articles…"
                  and, right under it, "Some publications could not be loaded" —
                  two opposite claims stacked. In this order the page says what
                  is missing from the list so far, and only then that more are
                  on the way. Inside the grid as well, so it spans the rows
                  rather than stopping 420px short of them. */}
              {!isLoadingPapers && papersError && filteredPapers.length > 0 && (
                <div className="explorer-inline-error" role="status">
                  <span>{getUiErrorMessage('PARTIAL_PUBLICATIONS_LOAD_FAILED')}</span>
                  <Button variant="ghost" size="sm" onClick={retryPapers}>{'Try again'}</Button>
                </div>
              )}

              {/* Not for a visitor: the sentinel IS the request for page 2, so
                  leaving it on the page would make the two-row preview a coat
                  of paint over a list that kept loading itself. The wall below
                  takes its place. */}
              {!publicMode && !papersAwaitReader && hasMore && rowsSettled && (filteredPapers.length > 0 || isFetchingMore) && (
                <div ref={observerRef} className="ehc-sentinel">
                  <Petri pose="flask" className={isFetchingMore ? 'petri-loader' : undefined} />
                  <span>{isFetchingMore
                    ? ('Loading more articles…')
                    : ('Scroll for more')}</span>
                </div>
              )}

              {/* The list stopped asking for pages on its own
                  (`explorerPageAllowance`). The status is mounted before it
                  has anything to say, so its first words are spoken. The
                  button stays mounted and focusable while a page loads, after
                  the last one and after a failed one, so a keyboard reader
                  keeps their place. A failure under rows is said by the
                  status, with no rows by the error state; the error strip or
                  the error state offers Try again. */}
              {!publicMode && (
                <p className="explorer-list-more-status" role="status">{papersMoreStatus}</p>
              )}
              {!publicMode && papersAwaitReader && (
                <div className="explorer-list-more">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isFetchingMore || !hasMore}
                    focusableWhenDisabled
                    onClick={() => requestNextPapersPage(true)}
                  >
                    {isFetchingMore && <CircleNotch className="ehc-spinner" size={16} aria-hidden="true" />}
                    Keep looking
                  </Button>
                </div>
              )}

              {papersGateOpen && (
                <ExplorerGuestGate
                  kind="papers"
                  total={guestGateTotal(entity)}
                  onSignUp={requestAccount}
                />
              )}
            </div>

            {/* `isFetchingMore` cuenta tanto como `isLoadingPapers`. El
                primero sólo cubre la página 1; el segundo, de la 2 en
                adelante. Con la lista vacía el centinela queda a la vista
                desde el primer fotograma, así que el observador dispara la
                página 2 en el acto — y entonces la página decía «Cargando
                más artículos…» y, debajo, «No hay publicaciones». Una
                promesa y su desmentido en la misma pantalla. Vacío es una
                afirmación sobre algo terminado: se espera a que lo esté. */}
            {/* And only once there is no next page this reader may load: a
                page the filters emptied is not an empty list. */}
            {!isLoadingPapers && !isFetchingMore && explorerListState({ rows: filteredPapers.length, hasMore, publicMode }) === 'empty' && (
              <ExplorerEmptyState
                variant={pickEmptyVariant({
                  papersError,
                  hasActiveFilters: Boolean(debouncedSearch) || Boolean(filters.category) || filters.peerReviewed || Boolean(filters.dateRange),
                  type,
                })}
               
                errorMessage={papersError ? getUiErrorMessage(papersError, 'PUBLICATIONS_LOAD_FAILED') : ''}
                onRetry={retryPapers}
                onClearFilters={() => { setSearchQuery(''); setFilters({ category: '', peerReviewed: false, dateRange: '' }); }}
                openAireUrl={entity?.openaireId ? `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}` : null}
              />
            )}
          </>
        ) : (
          <div className="ee-authors-grid">
            {(!isLoadingAuthors || isFetchingMoreAuthors) && visibleAuthors.map((author, idx) => (
              <div 
                key={author.id} 
                className="ee-author-card staggerFadeUp" 
                style={{ '--i': idx }}
                onClick={() => navigateToEntity('author', author.id, author)}
                onKeyDown={(event) => handleActivationKey(event, () => navigateToEntity('author', author.id, author))}
                role="link"
                tabIndex={0}
                aria-label={`${'Open profile for'} ${author.display_name}`}
              >
                <div className="ee-author-icon"><Users size={24} /></div>
                <div className="ee-author-info">
                  <h4>{author.display_name}</h4>
                  <p className="ee-author-metrics">
                    {author.source === 'crossref'
                      ? `${author.works_count!.toLocaleString(locale)} ${'matching publications'}`
                      : `H-Index: ${author.h_index} • ${author.cited_by_count!.toLocaleString(locale)} ${'citations'}`}
                  </p>
                </div>
                <CaretRight size={18} className="ee-author-arrow" />
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
            
            {/* Same order as the publications strip above, for the same reason. */}
            {!isLoadingAuthors && authorsError && entityAuthors.length > 0 && (
              <div className="explorer-inline-error" role="status">
                <span>{getUiErrorMessage('PARTIAL_AUTHORS_LOAD_FAILED')}</span>
                <Button variant="ghost" size="sm" onClick={retryAuthors}>{'Try again'}</Button>
              </div>
            )}

            {/* Same reason as the publications sentinel above. */}
            {!publicMode && hasMoreAuthors && (entityAuthors.length > 0 || isFetchingMoreAuthors) && (
              <div ref={observerAuthorsRef} className="ehc-sentinel">
                <Petri pose="flask" className={isFetchingMoreAuthors ? 'petri-loader' : undefined} />
                <span>{isFetchingMoreAuthors
                  ? ('Loading more authors…')
                  : ('Scroll for more')}</span>
              </div>
            )}

            {authorsGateOpen && (
              <ExplorerGuestGate kind="authors" onSignUp={requestAccount} />
            )}
            {!isLoadingAuthors && !isFetchingMoreAuthors && entityAuthors.length === 0 && (
              authorsError ? (
                <EmptyState
                  className="explorer-empty"
                  role="alert"
                  as="h3"
                  art={<Petri pose="upset" />}
                  title={'The authors could not be loaded'}
                  actions={<Button variant="outline" size="sm" onClick={retryAuthors}>{'Try again'}</Button>}
                >
                  {getUiErrorMessage(authorsError, 'AUTHORS_LOAD_FAILED')}
                </EmptyState>
              ) : (
                <ExplorerEmptyState variant={debouncedSearch ? 'authors' : 'authors-none'} />
              )
            )}
          </div>
        )}
      </div>

      {/* Filter drawer — a Sheet: a positioned modal Dialog (focus trap,
          Escape, restore, `aria-modal`) that slides in from the right and
          waits for its own exit before unmounting. The title names it. */}
      {isPhone ? (
        <Drawer open={showFilters} onOpenChange={setShowFilters}>
          <DrawerContent className="pc-share-sheet ee-filter-sheet">
            <DrawerHandle />
            <div className="ee-filter-header">
              <DrawerTitle render={<h3 />}><SlidersHorizontal size={18}/> {'Filters'}</DrawerTitle>
            </div>
            {filterControls}
          </DrawerContent>
        </Drawer>
      ) : (
        <Sheet open={showFilters} onOpenChange={setShowFilters}>
          <SheetContent
            side="right"
            className="ee-filter-drawer"
            overlayClassName="ee-filter-backdrop"
            showClose={false}
          >
                <div className="ee-filter-header">
                  <SheetTitle render={<h3 />}><SlidersHorizontal size={18}/> {'Filters'}</SheetTitle>
                  <SheetClose
                    render={<Button variant="ghost" size="icon" />}
                    aria-label={'Close filters'}
                    title={'Close'}
                  >
                    <X size={20}/>
                  </SheetClose>
                </div>
                {filterControls}
          </SheetContent>
        </Sheet>
      )}

      {/* Paper Card Overlay — the shared takeover, so the explorer and search
          open a paper the same way. */}
      <PaperOverlay
        open={Boolean(selectedPaper && !pdfPaperToView)}
        onClose={closeSelectedPaper}
        onExitComplete={() => setShownPaper(null)}
       
        label={'Publication details'}
      >
        {shownPaper && (
          <PaperCard
            paper={shownPaper}
            isLiked={likedPaperIds.has(interactionIdFor(shownPaper)!)}
            isSaved={savedPaperIds.has(interactionIdFor(shownPaper)!)}
            isRead={readPaperIds.has(interactionIdFor(shownPaper)!)}
            onLike={toggleLike}
            onNotInterested={(paper) => { markNotInterested(paper); setSelectedPaper(null); }}
            onMarkAsRead={markAsRead}
            onUnmarkAsRead={unmarkAsRead}
            onOpenPdf={(paper) => setPdfPaperToView(paper)}
            onSaveToList={handleSaveToList}
            onPickList={onSaveToList}
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
