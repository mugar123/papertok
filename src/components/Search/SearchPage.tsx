import type { MouseEvent, PropsWithChildren, ReactElement } from 'react';
import type { Paper } from '../../models/Paper.ts';
import type { FollowInput } from '../../utils/following.ts';
import type { EntitySearch, SearchProviders, SearchResults, SearchScope as SearchScopeId, SearchSnapshot } from '../../services/entitySearchService.ts';
import { Children, useState, useEffect, useEffectEvent, useMemo, useRef, useCallback } from 'react';
import {
  ArrowClockwise,
  ArrowLeft,
  CaretDown,
  Funnel,
  Briefcase,
  Buildings,
  Check,
  FileText,
  Lightbulb,
  MagnifyingGlass,
  Plus,
  Sparkle,
  TrendUp,
  Users,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  searchAuthors,
  searchInstitutions,
  searchConcepts,
  enrichAuthorInstitutionLocalization,
} from '../../services/openAlexService.ts';
import { searchProjects } from '../../services/openAireService.ts';
import { searchPapersAcrossSources } from '../../services/paperSearchService.ts';
import { searchEntities } from '../../services/entitySearchService.ts';
import { useFollowing } from '../../context/FollowingContext.tsx';
import { useFeed } from '../../context/FeedContext.tsx';
import useQuickSave from '../../hooks/useQuickSave.ts';
import { useLanguage } from '../../context/LanguageContext.tsx';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { useOverlayHistory } from '../../hooks/useOverlayHistory.ts';
import { getOpenAlexHealth, isOpenAlexRateLimitError } from '../../services/openAlexClient.ts';
import {
  SECTION_SOURCES,
  SOURCE_LABELS,
  describeSearchOutage,
  formatRetryDelay,
  joinNames,
  outageAffectsFilter,
} from '../../utils/searchOutage.ts';
import PaperCard from '../Feed/PaperCard.tsx';
import Petri from '../Onboarding/Petri.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { Button } from '../ui/button.tsx';
import { ListRow, ListRowAuthors, PaperListRow } from '../Lists/ListRow.tsx';
import PaperOverlay from '../Feed/PaperOverlay.tsx';
import PDFViewer from '../PDF/PDFViewer.tsx';
import { Input } from '../ui/input.tsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx';
import { Drawer, DrawerClose, DrawerContent, DrawerHandle, DrawerTitle, DrawerTrigger } from '../ui/drawer.tsx';
import useIsPhone from '../../hooks/useIsPhone.ts';
import '../Feed/SharePanel.css';
import { Toggle } from '../ui/toggle.tsx';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization.ts';
import { getProjectDisplayName } from '../../utils/entityMetadata.ts';
import {
  authorProminenceWeight,
  buildSearchSectionValues,
  filterRelevantSearchResults,
  getSearchSectionOrder,
  isOrganisationAuthorRecord,
  resolvePreferredSearchSection,
} from '../../utils/searchRelevance.ts';

import './SearchPage.css';

const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_MIN_LOADING_MS = 180;
// The page's deadlines, the services' own and the author enrichment included.
// The page waits for the slowest section it shows, so the sections a reader
// looks at less often get less.
const PAGE_SECTION_TIMEOUTS = { papers: 6000, authors: 5000, institutions: 4500, topics: 4500, projects: 6000 };

type SearchRun = { controller: AbortController; search: EntitySearch };

// What this page asks each source, where it differs from the palette's
// (entitySearchService.ts): its author rows carry the ORCID and prominence
// that OpenAlex's author entities have and work bylines do not, and its
// topics fall back to the local taxonomy rather than fail.
function pageSearchSources(language: string): SearchProviders {
  return {
    // OpenAlex and arXiv, merged and ranked by title match
    // (paperSearchService.ts): OpenAlex alone could not answer "llama 2".
    papers: (query, signal) => searchPapersAcrossSources(query, { signal }),
    authors: (query, signal) => searchAuthors(query, { signal, throwOnError: true })
      .then(results => filterRelevantSearchResults(
        query,
        // OpenAlex answers an organisation name with institution-as-author
        // records: four of them are called "University of Salamanca". They
        // score 100 and took the top of this section from the people who
        // actually wrote something.
        results.filter(author => !isOrganisationAuthorRecord(author)),
        author => [author.display_name],
        // Several exact matches all score 100; prominence decides which of
        // them a reader was looking for.
        { getWeight: authorProminenceWeight },
      ))
      .then(results => Promise.all(
        results.map(author => enrichAuthorInstitutionLocalization(author, { timeoutMs: 1500 })),
      )),
    institutions: (query, signal) => searchInstitutions(query, { signal, throwOnError: true }),
    topics: (query, signal) => searchConcepts(query, { language, limit: 8, signal }),
    projects: (query, signal) => searchProjects(query, 1, { signal, throwOnError: true })
      .then(result => filterRelevantSearchResults(
        query,
        result.projects || [],
        project => [project.acronym, project.title, project.funder],
      )),
  };
}

const SEARCH_FILTER_OPTIONS: ReadonlyArray<{ id: SearchScopeId; label: string; Icon: typeof MagnifyingGlass }> = [
  { id: 'all', label: 'All', Icon: MagnifyingGlass },
  { id: 'papers', label: 'Papers', Icon: FileText },
  { id: 'institutions', label: 'Institutions', Icon: Buildings },
  { id: 'authors', label: 'Authors', Icon: Users },
  { id: 'projects', label: 'Projects', Icon: Briefcase },
  { id: 'topics', label: 'Topics', Icon: Lightbulb },
];

// The field already opens on a magnifier, so "everything" takes a funnel
// rather than looking like a second search button.
const SCOPE_OPTIONS = SEARCH_FILTER_OPTIONS.map(option => (
  option.id === 'all' ? { ...option, label: 'Everything', Icon: Funnel } : option
));

/**
 * What the query searches: a select at the end of the field on desktop. On a
 * phone the field keeps its width for the query, so the scope collapses to its
 * icon and opens a bottom drawer of thumb-sized rows.
 */
function SearchScope({ value, onChange }: { value: SearchScopeId; onChange: (id: SearchScopeId) => void }) {
  const isPhone = useIsPhone();
  const current = SCOPE_OPTIONS.find(option => option.id === value) ?? SCOPE_OPTIONS[0];
  if (isPhone) {
    return (
      <Drawer>
        <DrawerTrigger className="search-scope-icon-trigger" aria-label={`Search in: ${current.label}`}>
          <current.Icon size={18} aria-hidden="true" />
          <CaretDown size={12} aria-hidden="true" />
        </DrawerTrigger>
        <DrawerContent className="pc-share-sheet">
          <DrawerHandle />
          <DrawerTitle render={<h2 />} className="pc-share-sheet-title">{'Search in'}</DrawerTitle>
          <ul className="pc-share-list">
            {SCOPE_OPTIONS.map(({ id, label, Icon }) => (
              <li key={id}>
                <DrawerClose
                  className="pc-share-row search-scope-row"
                  aria-current={id === value ? 'true' : undefined}
                  onClick={() => onChange(id)}
                >
                  <Icon size={20} aria-hidden="true" />
                  {label}
                  {id === value && <Check size={18} aria-hidden="true" className="search-scope-row-check" />}
                </DrawerClose>
              </li>
            ))}
          </ul>
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Select
      items={SCOPE_OPTIONS.map(({ id, label }) => ({ value: id, label }))}
      value={value}
      onValueChange={(next) => onChange(String(next) as SearchScopeId)}
    >
      <SelectTrigger size="sm" className="search-scope-trigger" aria-label={'Search in'}>
        <current.Icon size={15} aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        {SCOPE_OPTIONS.map(({ id, label, Icon }) => (
          <SelectItem key={id} value={id}>
            <Icon size={15} aria-hidden="true" />
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

/**
 * Ranks the sections by moving them in the DOM, so what a screen reader hears
 * and what a keyboard walks match what everyone else sees.
 * Flexbox `order` would rank them too, but with a reading order that no
 * longer matches the visual one.
 */
function OrderedSearchSections({ children, preferredSection }: PropsWithChildren<{ preferredSection: string | null }>) {
  return (Children.toArray(children) as ReactElement<{ 'data-section': string }>[]).sort((left, right) => (
    getSearchSectionOrder(left.props['data-section'], preferredSection)
    - getSearchSectionOrder(right.props['data-section'], preferredSection)
  ));
}

function FollowButton({ entity, isFollowing, isPending, onToggle }: { entity: FollowInput; isFollowing: (entity: FollowInput) => boolean; isPending: (entity: FollowInput) => boolean; onToggle: (event: MouseEvent, entity: FollowInput) => void }) {
  const following = isFollowing(entity);
  const pending = isPending(entity);
  const label = following
    ? ('Following')
    : ('Follow');

  // A ui Toggle: Base UI writes `aria-pressed` (and `data-pressed`) from
  // `pressed`. The click still goes through `onToggle`, which stops it from
  // reaching the row link underneath and asks the following context.
  return (
    <Toggle
      variant="outline"
      className={`search-follow-btn ${following ? 'following' : ''} ${pending ? 'is-pending' : ''}`}
      pressed={following}
      onClick={(event) => onToggle(event, entity)}
      disabled={pending}
      aria-label={label}
      title={label}
    >
      {following ? (
        <>
          <Check size={14} aria-hidden="true" className="search-follow-rest" />
          <span className="search-follow-rest">{label}</span>
          {/* Shown on pointer hover: what pressing it now does. Keyboard focus
              keeps "Following", the button's accessible name. */}
          <X size={14} aria-hidden="true" className="search-follow-undo" />
          <span className="search-follow-undo" aria-hidden="true">{'Unfollow'}</span>
        </>
      ) : (
        <>
          <Plus size={14} aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </Toggle>
  );
}

export default function SearchPage({ onSaveToList = () => {} }: { onSaveToList?: (paper: Paper) => void }) {
  const navigate = useNavigate();
  const { language, locale } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    interactionIdFor, toggleLike, markNotInterested, markAsRead, unmarkAsRead, trackViewTime, trackSkip,
  } = useFeed();
  const handleSaveToList = useQuickSave(onSaveToList);
  
  // Seeded from the URL, so a search is a place you can be sent to. The
  // palette needs this for the one paper in fifty that carries neither a DOI
  // nor an arXiv id: it has no public paper URL of its own, so the row hands
  // the reader to this page with the query intact rather than to a dead link.
  // The search effect below already keys on `query`, so seeding it is the
  // whole of the wiring.
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get('q')?.trim() || '');
  const [isSearching, setIsSearching] = useState(() => Boolean(searchParams.get('q')?.trim()));
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIntent, setSearchIntent] = useState<string | null>(null);
  const [activeSearchFilter, setActiveSearchFilter] = useState<SearchScopeId>('all');
  const [searchIssue, setSearchIssue] = useState<ReturnType<typeof describeSearchOutage>>(null);

  const [paperResults, setPaperResults] = useState<SearchResults['papers']>([]);
  const [authorResults, setAuthorResults] = useState<SearchResults['authors']>([]);
  const [institutionResults, setInstitutionResults] = useState<SearchResults['institutions']>([]);
  const [conceptResults, setConceptResults] = useState<SearchResults['topics']>([]);
  const [projectResults, setProjectResults] = useState<SearchResults['projects']>([]);

  const [selectedPaper, setSelectedPaper] = useState<Paper | null>(null);
  const [pdfPaper, setPdfPaper] = useState<Paper | null>(null);
  // Back closes this PDF viewer instead of leaving PaperTok: see useOverlayHistory.js.
  // Through the viewer's own close, the one the X uses — it owns `open` and
  // reports back only when its leave has played; `setPdfPaper(null)` is just
  // the fallback for the sub-frame gap before PDFViewer's own
  // `useImperativeHandle` has populated the ref — this import (above) is
  // plain, not lazy, so there is no chunk boundary to blame it on here.
  const pdfCloseRef = useRef<(() => void) | null>(null);
  const requestPdfClose = useCallback(() => {
    if (pdfCloseRef.current) pdfCloseRef.current();
    else setPdfPaper(null);
  }, []);
  useOverlayHistory(Boolean(pdfPaper), requestPdfClose, 'pdf');
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

  
  const timeoutRef = useRef<number | null>(null);
  // The search of the current query. Aborting its controller is what ends it:
  // every path that starts another one, or clears the query, aborts it first.
  const requestRef = useRef<SearchRun | null>(null);
  const getInteractionState = useCallback((paper: Paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);
  const clearResults = useCallback(() => {
    setPaperResults([]);
    setAuthorResults([]);
    setInstitutionResults([]);
    setConceptResults([]);
    setProjectResults([]);
  }, []);

  const pageSources = useMemo(() => pageSearchSources(language), [language]);

  // Paints an answer: every section in one commit. Painting used to happen one
  // straggler at a time, which is what assembled the page on screen over
  // several seconds. A section the search was not asked for is empty, and the
  // notice names only sections that were asked and failed.
  const commit = useCallback((snapshot: SearchSnapshot) => {
    const failedSections = snapshot.issues.map(issue => issue.section);
    // Only OpenAlex's own sections can testify about OpenAlex: a 429 from
    // OpenAIRE also satisfies `isOpenAlexRateLimitError`, which walks the cause
    // chain looking for that status.
    const openAlexIssues = snapshot.issues.filter(issue => SECTION_SOURCES[issue.section] === 'openalex');
    const health = getOpenAlexHealth();
    const rateLimited = health.rateLimited
      || openAlexIssues.some(issue => isOpenAlexRateLimitError(issue.error));
    // Both sources of the figure, largest wins: the client zeroes
    // `rateLimitedUntil` as soon as any request succeeds, so health can read 0
    // while the error that just failed still carries what OpenAlex said.
    const retryAfterMs = Math.max(
      health.retryAfterMs || 0,
      ...openAlexIssues.map(issue => (
        isOpenAlexRateLimitError(issue.error) ? (issue.error as { retryAfterMs?: number } | null)?.retryAfterMs || 0 : 0
      )),
    );
    setPaperResults(snapshot.results.papers);
    setAuthorResults(snapshot.results.authors);
    setInstitutionResults(snapshot.results.institutions);
    setConceptResults(snapshot.results.topics);
    setProjectResults(snapshot.results.projects);
    setSearchIssue(describeSearchOutage({ sections: failedSections, rateLimited, retryAfterMs }));
    setIsSearching(false);
    return Object.values(snapshot.results).reduce((total, list) => total + list.length, 0);
  }, []);

  const performSearch = useCallback(async (searchTerm: string, scope: SearchScopeId) => {
    const searchStartedAt = Date.now();
    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const run: SearchRun = {
      controller,
      // The page paints once, below, so the running snapshot goes unread.
      search: searchEntities(searchTerm, {
        signal: controller.signal, sources: pageSources, timeouts: PAGE_SECTION_TIMEOUTS, onUpdate: () => {},
      }),
    };
    requestRef.current = run;

    setIsSearching(true);
    setHasSearched(true);
    setSearchIssue(null);

    // One settle, for what the scope shows. Every source is bounded by its own
    // deadline, so this waits at most as long as the slowest and then commits
    // the whole page at once. The floor keeps an instant answer from flashing
    // a skeleton.
    const snapshot = await run.search.ask(scope);
    const remainingMinimumDelay = Math.max(
      0,
      SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt),
    );
    if (remainingMinimumDelay > 0) await wait(remainingMinimumDelay);
    if (run.controller.signal.aborted) return;
    const resultCount = commit(snapshot);

    // After the commit, never before: with the whole page behind the pending
    // gate, anything that throws on the way to `setIsSearching(false)` no
    // longer leaves a stale spinner — it leaves a blank page.
    trackEvent('search_performed', {
      search_type: scope,
      result_count: resultCount,
      has_results: resultCount > 0,
      query: searchTerm,
    });
  }, [commit, pageSources, trackEvent]);

  // The scope as it stands when the debounce fires, not when the query changed.
  const startSearch = useEffectEvent((term: string) => performSearch(term, activeSearchFilter));

  useEffect(() => {
    if (!query.trim()) {
      requestRef.current?.controller.abort();
      const resetStateTimeout = setTimeout(() => {
        clearResults();
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetStateTimeout);
    }

    requestRef.current?.controller.abort();
    if (timeoutRef.current) clearTimeout(timeoutRef.current!);

    timeoutRef.current = setTimeout(() => {
      void startSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeoutRef.current!);
      requestRef.current?.controller.abort();
    };
  }, [clearResults, query]);

  const handleToggleFollow = async (e: MouseEvent, entity: FollowInput) => {
    e.stopPropagation();
    try {
      await toggleFollow(entity);
    } catch (err) {
      console.error(err);
    }
  };

  const orcidMatch = query.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i);
  const cleanOrcid = orcidMatch ? orcidMatch[1].toUpperCase() : null;

  const hasSearchSectionResults = paperResults.length > 0
    || authorResults.length > 0
    || institutionResults.length > 0
    || conceptResults.length > 0
    || projectResults.length > 0;
  const hasResults = hasSearchSectionResults || !!cleanOrcid;
  const hasVisibleResults = activeSearchFilter === 'all'
    ? hasResults
    : activeSearchFilter === 'papers'
      ? paperResults.length > 0
      : activeSearchFilter === 'institutions'
        ? institutionResults.length > 0
        : activeSearchFilter === 'authors'
          ? authorResults.length > 0 || !!cleanOrcid
          : activeSearchFilter === 'projects'
            ? projectResults.length > 0
            : conceptResults.length > 0;
  const activeFilterOption = SEARCH_FILTER_OPTIONS.find(option => option.id === activeSearchFilter)
    || SEARCH_FILTER_OPTIONS[0];

  // The count this filter is actually showing, mirroring `hasVisibleResults`
  // above but as a number: the live region below reads exactly what is on
  // screen, so it can never disagree with a filtered "No X found".
  const visibleResultCount = activeSearchFilter === 'all'
    ? paperResults.length + authorResults.length + institutionResults.length
      + conceptResults.length + projectResults.length
      + (cleanOrcid ? 1 : 0)
    : activeSearchFilter === 'papers'
      ? paperResults.length
      : activeSearchFilter === 'institutions'
        ? institutionResults.length
        : activeSearchFilter === 'authors'
          ? authorResults.length + (cleanOrcid ? 1 : 0)
          : activeSearchFilter === 'projects'
            ? projectResults.length
            : conceptResults.length;

  const searchPending = Boolean(query.trim()) && isSearching;

  // The exact copy the visible empty state renders below, shared with the
  // hidden live region so the two can never say different things.
  const emptyResultsMessage = hasResults && activeSearchFilter !== 'all'
    ? (`No ${activeFilterOption.label.toLowerCase()} found for "${query}"`)
    : (`No results found for "${query}"`);

  /**
   * The settled outcome of a search: how many results this filter is
   * showing, or that it found none. Derived fresh on every render — not
   * stored in state — so it reads '' for the entire time a search is
   * pending (`searchPending`) and only becomes real text once one lands.
   *
   * That '' in between is what lets two searches that land on the exact same
   * count still both be heard. It only works because `searchPending` flips
   * true and back to false around real network I/O (`performSearch`'s
   * `await run.search.ask(scope)`): that is a genuine elapsed period, so React
   * commits (and paints) the '' on its own before the eventual count ever
   * gets computed, rather than the two collapsing into one batched update.
   * Clearing and setting in the very same tick would not be enough on its
   * own — confirmed the hard way elsewhere in this delivery, in
   * EditInterestsModal.jsx.
   *
   * Switching filter tabs never forces a re-announcement (that would be the
   * chattiness this whole region exists to avoid), but the count alone can
   * coincidentally repeat across tabs -- 12 papers, then 12 institutions --
   * which would otherwise read as the tab switch having done nothing. The
   * active filter's own name is folded into the non-empty text for exactly
   * that reason: the string itself changes on every tab switch, with no
   * extra firing and no special-casing of "did the count change".
   */
  const resultAnnouncement = (!query.trim() || !hasSearched || searchPending)
    ? ''
    : outageAffectsFilter(searchIssue, activeSearchFilter)
      ? ''
      : visibleResultCount > 0
        ? (`${visibleResultCount} ${visibleResultCount === 1 ? 'result' : 'results'} found${activeSearchFilter !== 'all' ? ` in ${activeFilterOption.label}` : ''} for "${query}"`)
        : emptyResultsMessage;

  // Memoised so the order is recomputed only when the results themselves
  // change, not on every render. With the whole page landing in one commit,
  // that means once per search — the ordering churn that used to run 6-10 times
  // while stragglers trickled in is gone with the staggered reveal.
  // The values each section votes with come from `buildSearchSectionValues`,
  // which the palette calls too. They had drifted apart — the palette left out
  // aliases and acronyms, so it alone could not answer "USAL" or "MIT".
  const preferredSection = useMemo(() => resolvePreferredSearchSection({
    query,
    hint: searchIntent,
    sectionValues: buildSearchSectionValues({
      papers: paperResults,
      topics: conceptResults,
      authors: authorResults,
      institutions: institutionResults,
      projects: projectResults,
    }),
  }), [
    query, searchIntent, paperResults,
    conceptResults, authorResults, institutionResults, projectResults,
  ]);

  // The notice outlives the search that raised it, so the countdown has to keep
  // running: `retryAtMs` is an instant, and this ticks it. Coarsely while the
  // wait is long — one repaint a second for eight hours would be 28 800 renders
  // that change nothing — and once a second in the last stretch.
  const [outageNow, setOutageNow] = useState(() => Date.now());
  const outageRetryAt = searchIssue?.retryAtMs || null;
  // `outageNow` used to sit in this effect's own dependency array, so every
  // tick's `setOutageNow` tore the interval down and rebuilt it — a fresh
  // `setInterval` every second, and one that kept firing in a background tab.
  // A self-rescheduling `setTimeout` reads the current time itself on every
  // tick instead of closing over a value that only changes when this effect
  // re-runs, so the cadence can still adapt (30s while far out, 1s in the
  // final stretch) without `outageNow` needing to be a dependency at all.
  // Hidden tabs pause it entirely — `visibilitychange` clears the pending
  // timer — and `resume()` recomputes from `Date.now()` on return, so the
  // countdown catches up instead of resuming from a stale value.
  useEffect(() => {
    if (!outageRetryAt) return undefined;
    let timer: number | null = null;

    const clearPending = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const tick = () => {
      const now = Date.now();
      setOutageNow(now);
      const remaining = outageRetryAt - now;
      if (remaining <= 0) return;
      timer = setTimeout(tick, remaining > 90_000 ? 30_000 : 1_000);
    };

    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      clearPending();
      tick();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clearPending();
      else resume();
    };

    resume();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearPending();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [outageRetryAt]);
  const openAlexRetryLabel = outageRetryAt
    ? formatRetryDelay(outageRetryAt - outageNow)
    : null;

  // The notice names whoever went down.
  const outageSourceNames = joinNames(
    (searchIssue?.sources || []).map(source => SOURCE_LABELS[source]),
  );
  const outageShown = Boolean(searchIssue) && !searchPending && outageAffectsFilter(searchIssue, activeSearchFilter);
  // With nothing to show, the outage is the whole page: Petri says it in the
  // panel. With some results, it is a strip over them.
  const outageEmptied = outageShown && !hasVisibleResults;
  // No retry while OpenAlex is throttling us with a known wait: the client
  // short-circuits without touching the network, so it could only fail again.
  const canRetryOutage = !(searchIssue?.rateLimited && openAlexRetryLabel);
  // One notice, always naming the provider that actually went down. The page
  // never claims "the search is unavailable": it knows it is running.
  // Which scopes the strip's results are missing, in the words the scope
  // picker uses, so a partial page says what it lacks.
  const outageSections = joinNames(
    (searchIssue?.sections || []).map(section => SEARCH_FILTER_OPTIONS.find(option => option.id === section)?.label.toLowerCase() ?? null),
  );
  const outageDetail = [
    outageSections && `${outageSections.charAt(0).toUpperCase()}${outageSections.slice(1)} may be incomplete.`,
    searchIssue?.rateLimited && openAlexRetryLabel && `Back in about ${openAlexRetryLabel}.`,
  ].filter(Boolean).join(' ');
  const outageTitle = searchIssue?.rateLimited
    ? 'OpenAlex is temporarily unavailable'
    : `${outageSourceNames} did not respond`;
  const suggestedQueries: { label: string; icon: ReactElement; query: string; section: SearchScopeId }[] = [
    {
      label: 'Cosmology',
      icon: <Lightbulb size={14} />,
      query: 'Cosmology',
      section: 'topics',
    },
    {
      label: 'MIT',
      icon: <Buildings size={14} />,
      query: 'Massachusetts Institute of Technology',
      section: 'institutions',
    },
    {
      label: 'CRISPR Cas9',
      icon: <FileText size={14} />,
      query: 'CRISPR Cas9',
      section: 'papers',
    },
    {
      label: 'Horizon projects',
      icon: <Briefcase size={14} />,
      query: 'Horizon',
      section: 'projects',
    },
    {
      label: 'Geoffrey Hinton',
      icon: <Users size={14} />,
      query: 'Geoffrey Hinton',
      section: 'authors',
    },
    {
      label: 'Quantum computing',
      icon: <TrendUp size={14} />,
      query: 'Quantum computing',
      section: 'topics',
    },
  ];

  const updateQuery = (nextQuery: string, intent: string | null = null, filter: SearchScopeId = activeSearchFilter) => {
    requestRef.current?.controller.abort();
    clearResults();
    setQuery(nextQuery);
    setSearchIntent(intent);
    setActiveSearchFilter(filter);
    setSearchIssue(null);
    setHasSearched(false);
    setIsSearching(Boolean(nextQuery.trim()));
  };

  const handleSuggestedSearch = (suggestion: { query: string; section: SearchScopeId }) => {
    updateQuery(suggestion.query, suggestion.section, suggestion.section);
  };

  const handleSearchFilterChange = (filterId: SearchScopeId) => {
    setActiveSearchFilter(filterId);
    setSearchIntent(filterId === 'all' ? null : filterId);
    // The notice belongs to the sections the previous view was showing. Kept
    // across a filter change it would reappear, unretried, over a view it never
    // described.
    setSearchIssue(null);
    // A scope the search was not asked for is asked for now, so a reader who
    // stays on Papers never pays for the author search. The skeleton covers the
    // wait; a scope already answered paints from what it has.
    const run = requestRef.current;
    if (!run || run.controller.signal.aborted || run.search.settled(filterId)) return;
    setIsSearching(true);
    void run.search.ask(filterId).then(snapshot => {
      if (!run.controller.signal.aborted) commit(snapshot);
    });
  };

  const clearSearch = () => {
    updateQuery('', null, 'all');
  };
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Focus goes back to the field: the control that was pressed unmounts while
  // the search runs.
  const retrySearch = () => {
    void performSearch(query.trim(), activeSearchFilter);
    searchInputRef.current?.focus();
  };

  return (
    <main className="search-page-container">
      <h1 className="visually-hidden">{'Search PaperTok'}</h1>
      <div className="search-header">
        <div className="search-header-main">
          <button
            type="button"
            className="search-back-btn"
            onClick={() => navigate('/feed')}
            aria-label={'Back'}
          >
            <ArrowLeft size={22} />
          </button>
          <div className={`search-input-wrapper ${searchPending ? 'is-searching' : ''}`}>
            <MagnifyingGlass className="search-icon" size={18} />
            <Input
              type="search"
              className="search-input"
              placeholder={'Search PaperTok...'}
              aria-label={'Search PaperTok'}
              ref={searchInputRef}
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) clearSearch();
              }}
              autoComplete="off"
              autoFocus
            />
            {/* Mounted with the field, so the wait is spoken; the results
                region shows it, so the field draws nothing for it. */}
            <span className="visually-hidden" role="status">{searchPending ? 'Searching' : ''}</span>
            {query && (
              <button
                type="button"
                className="search-clear-btn"
                onClick={() => { clearSearch(); searchInputRef.current?.focus(); }}
                aria-label={'Clear search'}
                title={'Clear search'}
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
            {/* The scope is part of the query, so it is chosen inside the field. */}
            <span className="search-scope-rule" aria-hidden="true" />
            <SearchScope value={activeSearchFilter} onChange={handleSearchFilterChange} />
          </div>
        </div>
      </div>

      {/* Shown on the scopes the outage is actually true for. Switching to
          Papers during an OpenAlex outage keeps it — that IS the scope it
          describes. Clearing the notice on every filter change traded one
          lie for another. */}
      {outageShown && !outageEmptied && (
        <div className="search-service-state" role="status">
          <WarningCircle size={20} aria-hidden="true" />
          <p className="search-service-copy">
            <strong>{outageTitle}</strong>
            {outageDetail && <span>{outageDetail}</span>}
          </p>
          {canRetryOutage && (
            <button
              type="button"
              className="search-retry-btn"
              onClick={retrySearch}
              aria-label={'Retry search'}
              title={'Retry search'}
            >
              <ArrowClockwise size={17} />
            </button>
          )}
        </div>
      )}

      <div className="search-results custom-scrollbar">
        <div
          className="search-results-list"
          aria-busy={searchPending}
        >
            {/* Persistent: mounted before any search ever runs, so only its
                text changes and a screen reader actually hears the outcome. */}
            <p className="visually-hidden" role="status" aria-live="polite">{resultAnnouncement}</p>
            {!query.trim() && !isSearching && (
              <div className="search-initial-state">
                <div className="search-initial-hero">
                  <Petri pose="compass" className="search-initial-petri" />
                  <h2>{'Explore knowledge'}</h2>
                  <p>{'Search papers, researchers, topics, institutions, and funded projects.'}</p>
                </div>
                
                <div className="search-suggestions">
                  <h3 className="search-suggestions-title"><Sparkle size={16} /> {'Suggested searches'}</h3>
                  <div className="search-suggestions-grid">
                    {suggestedQueries.map(item => (
                      <button
                        type="button"
                        key={item.label}
                        onClick={() => handleSuggestedSearch(item)}
                        className="search-suggestion-chip"
                      >
                        {item.icon}
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {outageEmptied && (
              <EmptyState
                role="status"
                className="search-outage-state"
                art={<Petri pose="upset" className="search-outage-petri" />}
                title={outageTitle}
                actions={canRetryOutage && (
                  <Button variant="outline" onClick={retrySearch}>
                    <ArrowClockwise size={16} aria-hidden="true" />
                    {'Try again'}
                  </Button>
                )}
              >
                {[
                  activeSearchFilter === 'all'
                    ? 'No other source found anything for this search.'
                    : `${activeFilterOption.label} come from ${outageSourceNames}, so none can be shown until it answers.`,
                  searchIssue?.rateLimited && openAlexRetryLabel
                    ? `It should be back in about ${openAlexRetryLabel}.`
                    : 'It usually comes back in a moment.',
                ].join(' ')}
              </EmptyState>
            )}

            {searchPending && (
              // Decorative: the input's own status region above already
              // announces "Searching" for assistive technology, so this
              // skeleton does not need to repeat it as a second live region.
              <div className="search-loading-state" aria-hidden="true">
                {/* The finished row's silhouette (ListRow): meta, title, byline. */}
                {[0, 1, 2, 3].map(index => (
                  <div className="list-row search-loading-row" key={index}>
                    <span className="list-row-content search-loading-copy">
                      <span className="search-loading-line search-loading-line--meta" />
                      <span className="search-loading-line search-loading-line--title" />
                      <span className="search-loading-line search-loading-line--detail" />
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* "Nothing was found" is only sayable when the sources this view
                depends on actually answered. Under an outage that covers them,
                the page cannot know, and the notice above says so instead —
                but an outage elsewhere no longer blanks the panel, which is
                what the old blanket `!searchIssue` guard did. */}
            {!hasVisibleResults && query && hasSearched && !searchPending
              && !outageAffectsFilter(searchIssue, activeSearchFilter) && (
              <div className="search-empty">
                <MagnifyingGlass size={40} className="search-empty-icon" />
                <p>{emptyResultsMessage}</p>
                <span>{hasResults && activeSearchFilter !== 'all'
                  ? ('Try another filter or search term')
                  : ('Try a different search term')}</span>
              </div>
            )}

            {hasVisibleResults && !searchPending && (
              <div key={activeSearchFilter} className="search-filtered-results">
                {/* Direct ORCID */}
                {cleanOrcid && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
                  <div className="search-section" style={{ order: 0 }}>
                    <h3 className="search-section-title">{'Direct ORCID search'}</h3>
                    <ListRow
                      meta={['ORCID', cleanOrcid]}
                      title={'View ORCID profile'}
                      onOpen={() => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`)}
                    >
                      <p className="list-row-byline">{'Explore the author and their work through a verified unique identifier'}</p>
                    </ListRow>
                  </div>
                )}

                <OrderedSearchSections preferredSection={preferredSection}>
            {institutionResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'institutions') && (
              <div className="search-section" data-section="institutions">
                <h3 className="search-section-title">{'Universities and institutions'}</h3>
                {institutionResults.map((inst) => (
                  <ListRow
                    key={inst.id}
                    meta={['Institution', inst.country_code || ('Unknown country')]}
                    title={getLocalizedInstitutionName(inst)}
                    onOpen={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)}
                    actions={(
                      <FollowButton
                        entity={{
                          type: 'institution',
                          id: inst.id,
                          displayName: inst.display_name,
                          source: inst._metadataSource || 'ror',
                          externalIds: { ror: inst.ror || inst.id },
                          metadata: { localizedNames: inst.localized_names },
                        }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    )}
                  />
                ))}
              </div>
            )}

            {projectResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'projects') && (
              <div className="search-section" data-section="projects">
                <h3 className="search-section-title">{'Research projects'}</h3>
                {projectResults.map((project) => (
                  <ListRow
                    key={project.id}
                    meta={['Project', project.funder]}
                    title={getProjectDisplayName(project)}
                    onOpen={() => navigate(`/explorer/project/${encodeURIComponent(project.id!)}?name=${encodeURIComponent(getProjectDisplayName(project))}&funder=${encodeURIComponent(project.funder!)}`)}
                    actions={(
                      <FollowButton
                        entity={{ type: 'project', id: project.id, displayName: getProjectDisplayName(project), source: 'openaire', metadata: { funder: project.funder } }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    )}
                  >
                    {project.budget! > 0 && (
                      <p className="list-row-byline">{(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: project.currency, maximumFractionDigits: 0 }).format(project.budget!); } catch { return `${project.budget!.toLocaleString(locale)} €`; } })()}</p>
                    )}
                  </ListRow>
                ))}
              </div>
            )}

            {conceptResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'topics') && (
              <div className="search-section" data-section="topics">
                <h3 className="search-section-title">{'Topics and areas'}</h3>
                {conceptResults.map((concept) => (
                  <ListRow
                    key={concept.id}
                    meta={['Topic', concept._localTopic ? concept.parent_display_name : concept.field_display_name]}
                    title={concept.display_name}
                    onOpen={() => navigate(`/explorer/topic/${encodeURIComponent(String(concept.id).split('/').pop()!)}`)}
                    actions={(
                      <FollowButton
                        entity={{
                          type: 'topic',
                          id: concept.id,
                          displayName: concept.display_name,
                          source: concept._localTopic ? 'papertok' : 'openalex',
                          metadata: {
                            categoryIds: concept.categoryIds,
                            // Persisted on the follow; the key predates the
                            // English-only interface and stays for the readers.
                            labelEn: concept.label,
                          },
                        }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    )}
                  />
                ))}
              </div>
            )}

            {authorResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
              <div className="search-section" data-section="authors">
                <h3 className="search-section-title">{'Authors'}</h3>
                {authorResults.map((author) => (
                  <ListRow
                    key={author.id}
                    meta={['Author']}
                    title={author.display_name}
                    onOpen={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}
                    actions={(
                      <FollowButton
                        entity={{ type: 'author', id: author.id, displayName: author.display_name, source: 'openalex', externalIds: { orcid: author.orcid } }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    )}
                  >
                    <p className="list-row-byline">
                      {getLocalizedInstitutionName(author.institutionData || { display_name: author.institution }) || ('Unknown institution')}
                    </p>
                  </ListRow>
                ))}
              </div>
            )}

            {paperResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'papers') && (
              <div className="search-section" data-section="papers">
                <h3 className="search-section-title">{'Publications'}</h3>
                {paperResults.map((paper) => {
                  return (
                    <PaperListRow key={paper.id} paper={paper} onOpen={() => setSelectedPaper(paper)}>
                      {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                    </PaperListRow>
                  );
                })}
              </div>
            )}
                </OrderedSearchSections>
              </div>
            )}
        </div>
      </div>

      {/* Paper Card Overlay */}
      <PaperOverlay
        open={Boolean(selectedPaper && !pdfPaper)}
        onClose={closeSelectedPaper}
        onExitComplete={() => setShownPaper(null)}
       
        label={'Paper details'}
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
            onOpenPdf={(paper) => setPdfPaper(paper)}
            onSaveToList={handleSaveToList}
            onPickList={onSaveToList}
            getInteractionState={getInteractionState}
            trackViewTime={trackViewTime}
            trackSkip={trackSkip}
          />
        )}
      </PaperOverlay>

      {/* PDF Viewer */}
      {pdfPaper && (
        <PDFViewer paper={pdfPaper} closeRef={pdfCloseRef} onClose={() => setPdfPaper(null)} />
      )}
    </main>
  );
}
