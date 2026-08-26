import { Children, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Search,
  FileText,
  Users,
  ArrowLeft,
  Building2,
  Lightbulb,
  Briefcase,
  Sparkles,
  Compass,
  TrendingUp,
  Check,
  Plus,
  LoaderCircle,
  AlertCircle,
  RotateCw,
  UserRound,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  searchAuthors,
  searchInstitutions,
  searchConcepts,
  searchLocalTopics,
  enrichAuthorInstitutionLocalization,
} from '../../services/openAlexService';
import { searchProjects } from '../../services/openAireService';
import { OpenAlexAdapter } from '../../services/adapters/OpenAlexAdapter';
import { PaperBuilder } from '../../services/PaperBuilder';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import {
  USER_SEARCH_DEBOUNCE_MS,
  USER_SEARCH_MIN_LENGTH,
  UserSearchAuthRequiredError,
  isSearchableTerm,
  normalizeUserSearchTerm,
  searchUsers,
} from '../../services/userSearchService';
import { isTransientReadError, patientRead } from '../../utils/boundedRead.js';
import { getOpenAlexHealth, isOpenAlexRateLimitError } from '../../services/openAlexClient';
import {
  SECTION_SOURCES,
  SOURCE_LABELS,
  describeSearchOutage,
  formatRetryDelay,
  joinNames,
  outageAffectsFilter,
} from '../../utils/searchOutage.js';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import {
  authorProminenceWeight,
  buildSearchSectionValues,
  filterRelevantSearchResults,
  getSearchSectionOrder,
  isOrganisationAuthorRecord,
  resolvePreferredSearchSection,
} from '../../utils/searchRelevance';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';

import './SearchPage.css';

const paperSearchAdapter = new OpenAlexAdapter();
const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6000;
const SEARCH_MIN_LOADING_MS = 180;
const USER_SEARCH_TIMEOUT_MS = 6000;
/** How many people the combined view shows before the Users pill takes over. */
const USER_ROWS_IN_ALL = 5;

// `users` sits second: the pill has to be findable, and putting it next to
// `authors` is exactly where the two get confused. They are different things —
// `authors` is whoever wrote a paper, from OpenAlex; `users` is somebody with an
// account here — so they are kept apart in the bar and the section titles say
// which is which.
const SEARCH_FILTER_OPTIONS = [
  { id: 'all', labelEs: 'Todo', labelEn: 'All', Icon: Search },
  { id: 'users', labelEs: 'Usuarios', labelEn: 'Users', Icon: UserRound },
  { id: 'papers', labelEs: 'Papers', labelEn: 'Papers', Icon: FileText },
  { id: 'institutions', labelEs: 'Instituciones', labelEn: 'Institutions', Icon: Building2 },
  { id: 'authors', labelEs: 'Autores', labelEn: 'Authors', Icon: Users },
  { id: 'projects', labelEs: 'Proyectos', labelEn: 'Projects', Icon: Briefcase },
  { id: 'topics', labelEs: 'Temas', labelEn: 'Topics', Icon: Lightbulb },
];

/** The monogram a result row paints. The index holds no photo, by design. */
function initialOf(name, handle) {
  const source = (name || handle || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

const wait = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs));

/**
 * Never rejects: a failed source resolves with its fallback and a status.
 *
 * The error object rides along now. It used to be dropped here
 * (`.catch(() => ...)`), and with it went the one thing that could tell a rate
 * limit from a timeout — `retryAfterMs`, which the OpenAlex client had already
 * parsed out of `Retry-After`.
 */
function settleSearch(promise, fallback = [], timeoutMs = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ value, status, error });
    };
    const timeoutId = setTimeout(() => finish(fallback, 'timeout'), timeoutMs);
    Promise.resolve(promise)
      .then(value => finish(value, 'fulfilled'))
      .catch(error => finish(fallback, 'rejected', error));
  });
}

function handleSearchItemKeyDown(event, action) {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

/**
 * Ranks the sections by moving them in the DOM, so what a screen reader hears
 * and what a keyboard walks match what everyone else sees.
 *
 * Moving a node does cancel and restart its CSS animations — `insertBefore`
 * detaches the element first, and a subtree that leaves the document loses its
 * running animations. That used to blank a section that was already on screen
 * and re-enter it row by row, several times per search, because the ranking was
 * recomputed as each straggling source landed. The fix is upstream: the page
 * now settles once, so this comparator runs on a result set that no longer
 * changes underneath it. Expressing the rank with flexbox `order` instead would
 * also stop the restarts, but at the price of a reading order that no longer
 * matches the visual one.
 */
function OrderedSearchSections({ children, preferredSection }) {
  return Children.toArray(children).sort((left, right) => (
    getSearchSectionOrder(left.props['data-section'], preferredSection)
    - getSearchSectionOrder(right.props['data-section'], preferredSection)
  ));
}

function FollowButton({ entity, isFollowing, isPending, onToggle }) {
  const { isEnglish } = useLanguage();
  const following = isFollowing(entity);
  const pending = isPending(entity);
  const label = following
    ? (isEnglish ? 'Following' : 'Siguiendo')
    : (isEnglish ? 'Follow' : 'Seguir');

  return (
    <button
      className={`search-follow-btn ${following ? 'following' : ''} ${pending ? 'is-pending' : ''}`}
      onClick={(event) => onToggle(event, entity)}
      disabled={pending}
      aria-pressed={following}
      aria-label={label}
      title={label}
    >
      {following
        ? <Check size={14} aria-hidden="true" />
        : <Plus size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}

function formatPaperDate(paper, locale) {
  const dateValue = paper.published || paper.publishedDate;
  if (dateValue) {
    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString(locale);
  }
  return paper.year ? String(paper.year) : null;
}

export default function SearchPage({ onSaveToList = () => {}, onAuthRequired = () => {} }) {
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const { language, isEnglish, locale } = useLanguage();
  const { user } = useAuth();
  const { trackEvent } = useAnalyticsConsent();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();
  
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIntent, setSearchIntent] = useState(null);
  const [activeSearchFilter, setActiveSearchFilter] = useState('all');
  const [searchIssue, setSearchIssue] = useState(null);
  
  const [paperResults, setPaperResults] = useState([]);
  const [authorResults, setAuthorResults] = useState([]);
  const [institutionResults, setInstitutionResults] = useState([]);
  const [conceptResults, setConceptResults] = useState([]);
  const [projectResults, setProjectResults] = useState([]);
  // People are kept out of the five arrays above and out of `searchIssue` on
  // purpose. Those five are OpenAlex and OpenAIRE — somebody else's quota,
  // reached over HTTP, and the banner that reports them says "OpenAlex is
  // unavailable". This one is our own Firestore, on our own bill, and a
  // Firestore hiccup announced under a third party's name is the same class of
  // lie as telling a signed-out visitor the search is broken. It gets its own
  // state, reported inside its own section, with its own action.
  const [userResults, setUserResults] = useState([]);
  // idle | searching | slow | done | failed | needs-session
  const [userStatus, setUserStatus] = useState('idle');
  
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfPaper, setPdfPaper] = useState(null);
  const closeSelectedPaper = useCallback(() => setSelectedPaper(null), []);
  const selectedPaperDialogRef = useDialogFocus(Boolean(selectedPaper && !pdfPaper), closeSelectedPaper);
  
  const timeoutRef = useRef(null);
  const requestAbortRef = useRef(null);
  const searchIdRef = useRef(0);
  const userSearchIdRef = useRef(0);
  const getInteractionState = useCallback((paper) => ({
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
    // Invalidates whatever user search is in flight, so a late answer cannot
    // repopulate a list the typing has already moved past.
    userSearchIdRef.current += 1;
    setUserResults([]);
    setUserStatus('idle');
  }, []);

  const performSearch = useCallback(async (searchTerm) => {
    const searchStartedAt = Date.now();
    const searchId = ++searchIdRef.current;
    requestAbortRef.current?.abort();
    const requestController = new AbortController();
    requestAbortRef.current = requestController;
    const localTopics = searchLocalTopics(searchTerm, language, 8);

    setIsSearching(true);
    setHasSearched(true);
    setSearchIssue(null);

    const sectionSetters = {
      papers: setPaperResults,
      authors: setAuthorResults,
      institutions: setInstitutionResults,
      topics: setConceptResults,
      projects: setProjectResults,
    };
    const isCurrentSearch = () => (
      searchId === searchIdRef.current && !requestController.signal.aborted
    );
    // Only tags the outcome with its section. Painting used to happen here, one
    // straggler at a time, which is what assembled the page on screen over
    // several seconds; the whole search now lands in a single commit below.
    const track = (section, promise) => promise.then(outcome => ({ ...outcome, section }));

    const tasks = [
      track('papers', settleSearch(
        paperSearchAdapter.search(searchTerm, 1, { signal: requestController.signal })
          .then(result => PaperBuilder.deduplicate(result.papers || []).slice(0, 10)),
      )),
      track('authors', settleSearch(
        searchAuthors(searchTerm, {
          signal: requestController.signal,
          throwOnError: true,
        }).then(results => filterRelevantSearchResults(
          searchTerm,
          // OpenAlex answers an organisation name with institution-as-author
          // records: four of them are called "University of Salamanca". They
          // score 100 and took the top of this section from the people who
          // actually wrote something.
          results.filter(author => !isOrganisationAuthorRecord(author)),
          author => [author.display_name],
          // Several exact matches all score 100; prominence decides which of
          // them a reader was looking for.
          { getWeight: authorProminenceWeight },
        )).then(results => Promise.all(
          results.map(author => enrichAuthorInstitutionLocalization(author, { timeoutMs: 1500 })),
        )),
        [],
        5000,
      )),
      track('institutions', settleSearch(
        searchInstitutions(searchTerm, {
          signal: requestController.signal,
          throwOnError: true,
        }),
        [],
        4500,
      )),
      track('topics', settleSearch(
        searchConcepts(searchTerm, {
          language,
          limit: 8,
          signal: requestController.signal,
        }),
        localTopics,
        4500,
      )),
      track('projects', settleSearch(
        searchProjects(searchTerm, 1, {
          signal: requestController.signal,
          throwOnError: true,
        })
          .then(result => filterRelevantSearchResults(
            searchTerm,
            result.projects || [],
            project => [project.acronym, project.title, project.funder],
          )),
      )),
    ];

    // One settle. Every source is bounded by its own deadline above, so this
    // waits at most as long as the slowest deadline and then commits the whole
    // page at once. The floor keeps an instant answer from flashing a skeleton.
    const outcomes = await Promise.all(tasks);
    const remainingMinimumDelay = Math.max(
      0,
      SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt),
    );
    if (remainingMinimumDelay > 0) await wait(remainingMinimumDelay);
    if (!isCurrentSearch()) return;

    const resultCount = outcomes.reduce(
      (total, outcome) => total + (Array.isArray(outcome.value) ? outcome.value.length : 0),
      0,
    );

    const failedSections = outcomes
      .filter(outcome => outcome.status !== 'fulfilled')
      .map(outcome => outcome.section);

    // Only OpenAlex's own sections can testify about OpenAlex: a 429 from
    // OpenAIRE also satisfies `isOpenAlexRateLimitError`, which walks the cause
    // chain looking for that status.
    const openAlexOutcomes = outcomes
      .filter(outcome => SECTION_SOURCES[outcome.section] === 'openalex');
    const health = getOpenAlexHealth();
    const rateLimited = health.rateLimited
      || openAlexOutcomes.some(outcome => isOpenAlexRateLimitError(outcome.error));
    // Both sources of the figure, largest wins: the client zeroes
    // `rateLimitedUntil` as soon as any request succeeds, so health can read 0
    // while the error that just failed still carries what OpenAlex said.
    const retryAfterMs = Math.max(
      health.retryAfterMs || 0,
      ...openAlexOutcomes.map(outcome => (
        isOpenAlexRateLimitError(outcome.error) ? outcome.error?.retryAfterMs || 0 : 0
      )),
    );
    const issue = describeSearchOutage({ sections: failedSections, rateLimited, retryAfterMs });

    outcomes.forEach(outcome => sectionSetters[outcome.section](outcome.value));
    setSearchIssue(issue);
    setIsSearching(false);
    if (requestAbortRef.current === requestController) {
      requestAbortRef.current = null;
    }

    // After the commit, never before: with the whole page behind the pending
    // gate, anything that throws on the way to `setIsSearching(false)` no
    // longer leaves a stale spinner — it leaves a blank page.
    trackEvent('search_performed', {
      search_type: 'all',
      result_count: resultCount,
      has_results: resultCount > 0,
    });
  }, [language, trackEvent]);

  useEffect(() => {
    if (!query.trim()) {
      requestAbortRef.current?.abort();
      searchIdRef.current += 1;
      const resetStateTimeout = setTimeout(() => {
        clearResults();
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetStateTimeout);
    }

    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      performSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    
    return () => {
      clearTimeout(timeoutRef.current);
      requestAbortRef.current?.abort();
    };
  }, [clearResults, query, performSearch]);

  // People are only looked up when a section is going to show them. The other
  // five sources are somebody else's quota and cost nothing to over-ask; this
  // one is two Firestore reads on a free tier whose daily quota is the real
  // backstop, so the pill is a spend gate as much as a filter.
  const usersRequested = activeSearchFilter === 'all' || activeSearchFilter === 'users';

  const performUserSearch = useCallback(async (term) => {
    const searchId = ++userSearchIdRef.current;
    const isCurrent = () => searchId === userSearchIdRef.current;

    // Checked before the request, not after it fails: the service refuses a
    // signed-out search before the network, and a visitor being told the search
    // is broken when it is only closed to them is a lie the UI would be telling
    // on its own.
    if (!user) {
      setUserResults([]);
      setUserStatus('needs-session');
      return;
    }

    setUserStatus('searching');
    try {
      // Firestore has no client timeout: against a connection that is open but
      // silent the promise never settles. `patientRead` bounds the wait without
      // throwing the answer away — later attempts run alongside the first, the
      // quickest wins, and an answer that arrives after everything expired is
      // still delivered, so a stall that ends at nine seconds heals the section
      // at nine seconds with nobody touching anything.
      const found = await patientRead(() => searchUsers(term), {
        attempts: 2,
        ms: USER_SEARCH_TIMEOUT_MS,
        label: 'user search',
        // `isCurrent()` already ends the loop's effect on the screen when the
        // term changes; the loop itself stops with the next search's own read.
        onSlow: () => { if (isCurrent()) setUserStatus('slow'); },
        onLateResult: (rows) => {
          if (!isCurrent()) return;
          setUserResults(rows);
          setUserStatus('done');
        },
      });
      if (!isCurrent()) return;
      setUserResults(found);
      setUserStatus('done');
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof UserSearchAuthRequiredError) {
        setUserResults([]);
        setUserStatus('needs-session');
        return;
      }
      setUserResults([]);
      // A timeout is not a failure, it is a wait that is still running: the
      // late answer may still land through onLateResult.
      if (isTransientReadError(error)) {
        setUserStatus('slow');
        return;
      }
      console.error('User search failed:', error);
      setUserStatus('failed');
    }
  }, [user]);

  // The second clock. The fan-out above debounces at 320 ms against APIs that
  // do not bill us; this one waits the 400 ms the design fixed, and never fires
  // per keystroke, so one typed word costs one search and two reads.
  useEffect(() => {
    const term = normalizeUserSearchTerm(query);
    if (!usersRequested || !isSearchableTerm(term)) return undefined;
    const timer = setTimeout(() => performUserSearch(term), USER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, usersRequested, performUserSearch]);

  const handleToggleFollow = async (e, entity) => {
    e.stopPropagation();
    try {
      await toggleFollow(entity);
    } catch (err) {
      console.error(err);
    }
  };

  const orcidMatch = query.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i);
  const cleanOrcid = orcidMatch ? orcidMatch[1].toUpperCase() : null;

  // The users section speaks for itself even with nothing to list: it has to be
  // able to say "sign in", "that did not work", or "this searches from the
  // start of a name". An empty people section next to ten papers would
  // otherwise read as "this person is not on PaperTok", which is usually false.
  // Below the minimum no query is issued at all, so the section would stay
  // silent and the page would fall through to "No results found for n" — which
  // is not what happened. Only under the Users pill: in the combined view a
  // one-letter term is just a search still being typed.
  const typedUserTerm = normalizeUserSearchTerm(query);
  const userTermTooShort = activeSearchFilter === 'users'
    && typedUserTerm.length > 0
    && typedUserTerm.length < USER_SEARCH_MIN_LENGTH;
  const usersHaveSomethingToSay = usersRequested
    && (userStatus !== 'idle' || userTermTooShort);
  const visibleUserRows = activeSearchFilter === 'users'
    ? userResults
    : userResults.slice(0, USER_ROWS_IN_ALL);
  const userRowsTruncated = userResults.length > visibleUserRows.length;

  const hasSearchSectionResults = paperResults.length > 0
    || authorResults.length > 0
    || institutionResults.length > 0
    || conceptResults.length > 0
    || projectResults.length > 0;
  const hasResults = hasSearchSectionResults || !!cleanOrcid;
  // In the combined view the people section is one voice among six, so it is
  // its ROWS that count: with nothing found anywhere, the page owes the reader
  // one honest "no results", not a lone "nobody matches that" standing in for
  // the whole search. Under the Users pill that section IS the page, so there
  // it keeps speaking for itself.
  const hasVisibleResults = activeSearchFilter === 'all'
    ? hasResults || userResults.length > 0
    : activeSearchFilter === 'users'
      ? usersHaveSomethingToSay
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

  /**
   * Is the page still waiting for something it is going to show?
   *
   * The two channels run on their own clocks — 320 ms for the external fan-out,
   * 400 ms for people — and the skeleton used to disappear the moment EITHER of
   * them had anything to say. In practice that meant it died at 400 ms, when
   * the people query merely *started*, leaving Firestore's "nobody matches
   * that" alone on screen for a second before the five external sources landed.
   * The wait now covers every channel this filter actually paints.
   *
   * 'slow' and 'offline' deliberately do not count as pending: those are waits
   * that already announced themselves and still have a live read behind them,
   * so the people section explains itself in place rather than holding the
   * whole page hostage to one stalled connection.
   */
  // 'idle' counts as pending while a people query is still owed: the two
  // debounces are 80 ms apart and the external one fires first, so between the
  // keystroke and the people timer there is a window where nothing is running
  // yet. Without it a fast external answer settles the page, and then the
  // people search starts and pulls the skeleton back over it — measured as
  // skeleton → empty → skeleton → empty on one search.
  const peopleWillRun = usersRequested && isSearchableTerm(typedUserTerm);
  const peoplePending = peopleWillRun && (userStatus === 'idle' || userStatus === 'searching');
  const externalPending = activeSearchFilter !== 'users' && isSearching;
  const searchPending = Boolean(query.trim()) && (externalPending || peoplePending);

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
      users: userResults,
      papers: paperResults,
      topics: conceptResults,
      authors: authorResults,
      institutions: institutionResults,
      projects: projectResults,
    }),
  }), [
    query, searchIntent, userResults, paperResults,
    conceptResults, authorResults, institutionResults, projectResults,
  ]);

  // The notice outlives the search that raised it, so the countdown has to keep
  // running: `retryAtMs` is an instant, and this ticks it. Coarsely while the
  // wait is long — one repaint a second for eight hours would be 28 800 renders
  // that change nothing — and once a second in the last stretch.
  const [outageNow, setOutageNow] = useState(() => Date.now());
  const outageRetryAt = searchIssue?.retryAtMs || null;
  useEffect(() => {
    if (!outageRetryAt) return undefined;
    const remaining = outageRetryAt - Date.now();
    if (remaining <= 0) return undefined;
    const interval = setInterval(
      () => setOutageNow(Date.now()),
      remaining > 90_000 ? 30_000 : 1_000,
    );
    return () => clearInterval(interval);
  }, [outageRetryAt, outageNow]);
  const openAlexRetryLabel = outageRetryAt
    ? formatRetryDelay(outageRetryAt - outageNow)
    : null;

  // The notice names whoever went down and what is missing because of it, in
  // the same words the filter pills use.
  const sectionWord = (section) => {
    const option = SEARCH_FILTER_OPTIONS.find(entry => entry.id === section);
    return option ? (isEnglish ? option.labelEn : option.labelEs).toLowerCase() : null;
  };
  const outageSourceNames = joinNames(
    (searchIssue?.sources || []).map(source => SOURCE_LABELS[source]),
    isEnglish,
  );
  // Every failed section, not just OpenAlex's: a simultaneous OpenAIRE failure
  // used to vanish behind the OpenAlex headline.
  const outageSectionNames = joinNames(
    (searchIssue?.sections || []).map(sectionWord),
    isEnglish,
  );
  const outageIsSingleSource = (searchIssue?.sources || []).length === 1;
  const suggestedQueries = [
    {
      label: isEnglish ? 'Cosmology' : 'Cosmología',
      icon: <Lightbulb size={14} />,
      query: isEnglish ? 'Cosmology' : 'Cosmología',
      section: 'topics',
    },
    {
      label: 'MIT',
      icon: <Building2 size={14} />,
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
      label: isEnglish ? 'Horizon projects' : 'Proyectos Horizon',
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
      label: isEnglish ? 'Quantum computing' : 'Computación cuántica',
      icon: <TrendingUp size={14} />,
      query: 'Quantum computing',
      section: 'topics',
    },
  ];

  const updateQuery = (nextQuery, intent = null, filter = activeSearchFilter) => {
    requestAbortRef.current?.abort();
    clearResults();
    setQuery(nextQuery);
    setSearchIntent(intent);
    setActiveSearchFilter(filter);
    setSearchIssue(null);
    setHasSearched(false);
    setIsSearching(Boolean(nextQuery.trim()));
  };

  const handleSuggestedSearch = (suggestion) => {
    updateQuery(suggestion.query, suggestion.section, suggestion.section);
  };

  const handleSearchFilterChange = (filterId) => {
    setActiveSearchFilter(filterId);
    setSearchIntent(filterId === 'all' ? null : filterId);
    // The notice belongs to the sections the previous view was showing. Kept
    // across a filter change it would reappear, unretried, over a view it never
    // described.
    setSearchIssue(null);
  };

  const clearSearch = () => {
    updateQuery('', null, 'all');
  };

  return (
    <div className="search-page-container">
      <div className="search-header">
        <div className="search-header-main">
          <button
            type="button"
            className="search-back-btn"
            onClick={() => navigate('/')}
            aria-label={isEnglish ? 'Back' : 'Volver'}
          >
            <ArrowLeft size={22} />
          </button>
          <div className={`search-input-wrapper ${searchPending ? 'is-searching' : ''}`}>
            <Search className="search-icon" size={18} />
            <input
              type="search"
              className="search-input"
              placeholder={isEnglish ? 'Search PaperTok...' : 'Buscar en PaperTok...'}
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) clearSearch();
              }}
              autoComplete="off"
              autoFocus
            />
            {searchPending && (
              <span
                className="search-input-loader"
                role="status"
                aria-label={isEnglish ? 'Searching' : 'Buscando'}
              >
                <LoaderCircle size={17} aria-hidden="true" />
              </span>
            )}
          </div>
        </div>
        <div
          className="search-filter-bar"
          role="tablist"
          aria-label={isEnglish ? 'Filter search results' : 'Filtrar resultados de búsqueda'}
        >
          {SEARCH_FILTER_OPTIONS.map(({ id, labelEs, labelEn, Icon }) => {
            const isActive = activeSearchFilter === id;
            const label = isEnglish ? labelEn : labelEs;
            return (
              <button
                key={id}
                id={`search-filter-${id}`}
                type="button"
                className={`search-filter-pill ${isActive ? 'active' : ''}`}
                role="tab"
                aria-selected={isActive}
                aria-controls="search-results-panel"
                onClick={() => handleSearchFilterChange(id)}
                title={label}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

      </div>

      <div className="search-results custom-scrollbar">
        <div id="search-results-panel" className="search-results-list" aria-busy={searchPending}>
            {!query.trim() && !isSearching && (
              <div className="search-initial-state">
                <div className="search-initial-hero">
                  <Compass size={48} className="search-initial-icon" />
                  <h2>{isEnglish ? 'Explore knowledge' : 'Explora el conocimiento'}</h2>
                  <p>{isEnglish
                    ? 'Search papers, researchers, topics, institutions, and funded projects.'
                    : 'Busca papers, investigadores, temas, universidades y proyectos financiados.'}</p>
                </div>
                
                <div className="search-suggestions">
                  <h3 className="search-suggestions-title"><Sparkles size={16} /> {isEnglish ? 'Suggested searches' : 'Búsquedas sugeridas'}</h3>
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

            {/* Shown on the pills the outage is actually true for. Switching to
                Papers during an OpenAlex outage keeps it — that IS the pill it
                describes — while Users never matches, because people come from
                Firestore and no provider here serves them. Clearing the notice
                on every filter change traded one lie for another. */}
            {searchIssue && !searchPending && outageAffectsFilter(searchIssue, activeSearchFilter) && (
              <div className="search-service-state" role="status">
                <AlertCircle size={20} aria-hidden="true" />
                <div className="search-service-copy">
                  {/* One notice, always naming the provider that actually went
                      down. The page never claims "the search is unavailable":
                      it is the page itself, it knows perfectly well that it is
                      running, and it used to say that over a list of results. */}
                  <strong>{searchIssue.rateLimited
                    ? (isEnglish
                        ? 'OpenAlex is temporarily unavailable'
                        : 'OpenAlex no está disponible temporalmente')
                    : (isEnglish
                        ? `${outageSourceNames} did not respond`
                        : `${outageSourceNames} no ${outageIsSingleSource ? 'ha' : 'han'} respondido`)}</strong>
                  <span>{[
                    // Only a real rate limit can promise a time; a timeout gets
                    // no invented estimate.
                    searchIssue.rateLimited && (openAlexRetryLabel
                      ? (isEnglish
                          ? `It is estimated to be back in ${openAlexRetryLabel}.`
                          : `Se estima que vuelve en ${openAlexRetryLabel}.`)
                      : (isEnglish
                          ? 'It has not said when it will be back.'
                          : 'No ha dicho cuándo vuelve.')),
                    outageSectionNames
                      ? (isEnglish
                          ? `Meanwhile ${outageSectionNames} may be limited.`
                          : `Mientras tanto pueden faltar ${outageSectionNames}.`)
                      : (isEnglish
                          ? 'Searches may come back incomplete.'
                          : 'Las búsquedas pueden salir incompletas.'),
                  ].filter(Boolean).join(' ')}</span>
                </div>
                {/* No retry while OpenAlex is throttling us with a known wait:
                    the client short-circuits without touching the network, so
                    the button could only fail again, instantly. */}
                {!(searchIssue.rateLimited && openAlexRetryLabel) && (
                  <button
                    type="button"
                    className="search-retry-btn"
                    onClick={() => performSearch(query.trim())}
                    aria-label={isEnglish ? 'Retry search' : 'Reintentar búsqueda'}
                    title={isEnglish ? 'Retry search' : 'Reintentar búsqueda'}
                  >
                    <RotateCw size={17} />
                  </button>
                )}
              </div>
            )}

            {searchPending && (
              <div
                className="search-loading-state"
                role="status"
                aria-label={isEnglish ? 'Preparing search results' : 'Preparando resultados de búsqueda'}
              >
                {[0, 1, 2].map(index => (
                  <div className="search-loading-row" key={index} style={{ '--loading-row-index': index }}>
                    <span className="search-loading-icon" />
                    <span className="search-loading-copy">
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
                <Search size={40} className="search-empty-icon" />
                <p>{hasResults && activeSearchFilter !== 'all'
                  ? (isEnglish
                    ? `No ${activeFilterOption.labelEn.toLowerCase()} found for "${query}"`
                    : `No se encontraron ${activeFilterOption.labelEs.toLowerCase()} para "${query}"`)
                  : (isEnglish ? `No results found for "${query}"` : `No se encontraron resultados para "${query}"`)}</p>
                <span>{hasResults && activeSearchFilter !== 'all'
                  ? (isEnglish ? 'Try another filter or search term' : 'Prueba otro filtro o término de búsqueda')
                  : (isEnglish ? 'Try a different search term' : 'Intenta con otros términos o busca en inglés')}</span>
              </div>
            )}

            {hasVisibleResults && !searchPending && (
              <div key={activeSearchFilter} className="search-filtered-results">
                {/* Direct ORCID */}
                {cleanOrcid && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
                  <div className="search-section" style={{ order: 0 }}>
                    <h3 className="search-section-title">{isEnglish ? 'Direct ORCID search' : 'Búsqueda directa ORCID'}</h3>
                    <div
                      className="search-item"
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`),
                      )}
                    >
                      <div className="search-item-icon" style={{ background: '#a6ce39', color: 'white' }}>
                        <Users size={22} />
                      </div>
                      <div className="search-item-info">
                        <h4 style={{ color: '#a6ce39' }}>{isEnglish ? 'View ORCID profile' : 'Ver perfil ORCID'} {cleanOrcid}</h4>
                        <p>{isEnglish
                          ? 'Explore the author and their work through a verified unique identifier'
                          : 'Explorar autor e historial mediante su identificador único verificado'}</p>
                      </div>
                    </div>
                  </div>
                )}

                <OrderedSearchSections preferredSection={preferredSection}>
            {usersHaveSomethingToSay && (
              <div className="search-section" data-section="users">
                {/* "Users" on the pill, but the heading says which users: the
                    Authors section right below is OpenAlex paper authors, and
                    the two are genuinely different things. */}
                <h3 className="search-section-title">
                  {isEnglish ? 'PaperTok users' : 'Usuarios de PaperTok'}
                </h3>

                {userTermTooShort && (
                  <div className="search-users-note" role="status">
                    <UserRound size={18} aria-hidden="true" />
                    <div className="search-users-note-copy">
                      <span>{isEnglish
                        ? `Type at least ${USER_SEARCH_MIN_LENGTH} characters to search people.`
                        : `Escribe al menos ${USER_SEARCH_MIN_LENGTH} caracteres para buscar personas.`}</span>
                    </div>
                  </div>
                )}

                {!userTermTooShort && userStatus === 'needs-session' && (
                  <div className="search-users-note" role="status">
                    <UserRound size={18} aria-hidden="true" />
                    <div className="search-users-note-copy">
                      <strong>{isEnglish
                        ? 'Finding people needs an account'
                        : 'Encontrar personas necesita una cuenta'}</strong>
                      <span>{isEnglish
                        ? 'Papers, institutions and projects stay open to everyone.'
                        : 'Los papers, las instituciones y los proyectos siguen abiertos a todo el mundo.'}</span>
                    </div>
                    <button type="button" className="search-users-action" onClick={onAuthRequired}>
                      {isEnglish ? 'Sign in' : 'Iniciar sesión'}
                    </button>
                  </div>
                )}

                {(userStatus === 'searching' || userStatus === 'slow') && (
                  <div className="search-users-note" role="status">
                    <LoaderCircle size={18} className="search-users-spinner" aria-hidden="true" />
                    <div className="search-users-note-copy">
                      <span>{userStatus === 'slow'
                        ? (isEnglish
                          ? 'This is taking longer than usual.'
                          : 'Está tardando más de lo normal.')
                        : (isEnglish ? 'Searching people…' : 'Buscando personas…')}</span>
                    </div>
                  </div>
                )}

                {userStatus === 'failed' && (
                  <div className="search-users-note search-users-note--error" role="alert">
                    <AlertCircle size={18} aria-hidden="true" />
                    <div className="search-users-note-copy">
                      <span>{isEnglish
                        ? 'People could not be loaded.'
                        : 'No se han podido cargar las personas.'}</span>
                    </div>
                    {/* Retries only this, never the five external sources: the
                        banner's retry spends OpenAlex quota, which cannot fix
                        a Firestore hiccup. */}
                    <button
                      type="button"
                      className="search-users-action"
                      onClick={() => performUserSearch(normalizeUserSearchTerm(query))}
                    >
                      {isEnglish ? 'Try again' : 'Reintentar'}
                    </button>
                  </div>
                )}

                {userStatus === 'done' && userResults.length === 0 && (
                  <div className="search-users-note" role="status">
                    <UserRound size={18} aria-hidden="true" />
                    <div className="search-users-note-copy">
                      <strong>{isEnglish ? 'Nobody matches that.' : 'No hay nadie con ese nombre.'}</strong>
                      {/* The prefix limit said out loud. Without it an empty
                          people section beside a full page of papers reads as
                          "this person is not on PaperTok", which is usually
                          false — it only searches from the start. */}
                      <span>{isEnglish
                        ? 'It searches from the start of the handle or the name, so "nico" finds "Nicolás" but "muñoz" does not.'
                        : 'Busca desde el principio del handle o del nombre, así que "nico" encuentra "Nicolás" pero "muñoz" no.'}</span>
                    </div>
                  </div>
                )}

                {visibleUserRows.map((person, index) => (
                  <div
                    key={person.uid}
                    className="search-item search-item-enter"
                    style={{ '--search-item-index': Math.min(index, 6) }}
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/public/user/${person.handle}`)}
                    onKeyDown={event => handleSearchItemKeyDown(
                      event,
                      () => navigate(`/public/user/${person.handle}`),
                    )}
                  >
                    {/* A monogram, not a photo: the index carries no photo, and
                        that is the point rather than an omission — the picture
                        is exactly what the F1 review closed the directory on.
                        No follow button either: following a person is the F2
                        graph, and knowing whether you already do would be one
                        read per row. It lives on the profile this opens. */}
                    <div className="search-item-avatar">
                      {initialOf(person.name, person.handle)}
                    </div>
                    <div className="search-item-info">
                      <h4>{person.name || person.handle}</h4>
                      <p>@{person.handle}</p>
                    </div>
                  </div>
                ))}

                {userRowsTruncated && (
                  <button
                    type="button"
                    className="search-users-more"
                    onClick={() => handleSearchFilterChange('users')}
                  >
                    {isEnglish
                      ? `See all ${userResults.length} people`
                      : `Ver las ${userResults.length} personas`}
                  </button>
                )}
              </div>
            )}

            {institutionResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'institutions') && (
              <div className="search-section" data-section="institutions">
                <h3 className="search-section-title">{isEnglish ? 'Universities and institutions' : 'Universidades e instituciones'}</h3>
                {institutionResults.map((inst, index) => {
                  const localizedName = getLocalizedInstitutionName(inst, language);
                  return (
                    <div
                      key={inst.id}
                      className="search-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/institution/${inst.id.split('/').pop()}`),
                      )}
                    >
                      <div className="search-item-icon"><Building2 size={22} /></div>
                      <div className="search-item-info">
                        <h4>{localizedName}</h4>
                        <p>{inst.country_code || (isEnglish ? 'Unknown country' : 'País desconocido')} • {isEnglish ? 'Academic institution' : 'Institución académica'}</p>
                      </div>
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
                    </div>
                  );
                })}
              </div>
            )}

            {projectResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'projects') && (
              <div className="search-section" data-section="projects">
                <h3 className="search-section-title">{isEnglish ? 'Research projects' : 'Proyectos de investigación'}</h3>
                {projectResults.map((project, index) => (
                  <div
                    key={project.id}
                    className="search-item search-item-enter"
                    style={{ '--search-item-index': Math.min(index, 6) }}
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/explorer/project/${project.id}?name=${encodeURIComponent(project.acronym || project.title)}&funder=${encodeURIComponent(project.funder)}`)}
                    onKeyDown={event => handleSearchItemKeyDown(
                      event,
                      () => navigate(`/explorer/project/${project.id}?name=${encodeURIComponent(project.acronym || project.title)}&funder=${encodeURIComponent(project.funder)}`),
                    )}
                  >
                    <div className="search-item-icon"><Briefcase size={22} /></div>
                    <div className="search-item-info">
                      <h4>{project.acronym ? `${project.acronym}: ${project.title}` : project.title}</h4>
                      <p>{project.funder}{project.budget > 0 ? (() => { try { return ` • ${new Intl.NumberFormat(locale, { style: 'currency', currency: project.currency, maximumFractionDigits: 0 }).format(project.budget)}`; } catch { return ` • ${project.budget.toLocaleString(locale)} €`; } })() : ''}</p>
                    </div>
                    <FollowButton
                      entity={{ type: 'project', id: project.id, displayName: project.acronym || project.title, source: 'openaire', metadata: { funder: project.funder } }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
                  </div>
                ))}
              </div>
            )}

            {conceptResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'topics') && (
              <div className="search-section" data-section="topics">
                <h3 className="search-section-title">{isEnglish ? 'Topics and areas' : 'Temas y áreas'}</h3>
                {conceptResults.map((concept, index) => (
                  <div
                    key={concept.id}
                    className="search-item search-topic-item search-item-enter"
                    style={{ '--search-item-index': Math.min(index, 6) }}
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/explorer/topic/${encodeURIComponent(String(concept.id).split('/').pop())}`)}
                    onKeyDown={event => handleSearchItemKeyDown(
                      event,
                      () => navigate(`/explorer/topic/${encodeURIComponent(String(concept.id).split('/').pop())}`),
                    )}
                  >
                    <div className="search-item-icon search-topic-icon"><Lightbulb size={22} /></div>
                    <div className="search-item-info">
                      <h4>{concept.display_name}</h4>
                      <p>
                        {concept._localTopic && concept.level === 0
                          ? `${concept.subcategoryCount || 0} ${isEnglish ? 'related topics' : 'temas relacionados'}`
                          : concept._localTopic
                            ? `${isEnglish ? 'Topic in' : 'Tema de'} ${concept.parent_display_name || (isEnglish ? 'PaperTok taxonomy' : 'la taxonomía de PaperTok')}`
                            : [
                                concept.field_display_name || (isEnglish ? 'OpenAlex topic' : 'Tema de OpenAlex'),
                                Number.isFinite(concept.works_count)
                                  ? `${concept.works_count.toLocaleString(locale)} ${isEnglish ? 'works' : 'trabajos'}`
                                  : '',
                              ].filter(Boolean).join(' • ')}
                      </p>
                    </div>
                    <FollowButton
                      entity={{
                        type: 'topic',
                        id: concept.id,
                        displayName: concept.display_name,
                        source: concept._localTopic ? 'papertok' : 'openalex',
                        metadata: {
                          categoryIds: concept.categoryIds,
                          labelEs: concept.labelEs,
                          labelEn: concept.labelEn,
                        },
                      }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
                  </div>
                ))}
              </div>
            )}

            {authorResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
              <div className="search-section" data-section="authors">
                <h3 className="search-section-title">{isEnglish ? 'Authors' : 'Autores'}</h3>
                {authorResults.map((author, index) => {
                  const authorFollow = { type: 'author', id: author.id, displayName: author.display_name, source: 'openalex', externalIds: { orcid: author.orcid } };
                  const authorInstitution = getLocalizedInstitutionName(
                    author.institutionData || { display_name: author.institution },
                    language,
                  );
                  return (
                    <div
                      key={author.id}
                      className="search-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/author/${author.id.split('/').pop()}`),
                      )}
                    >
                      <div className="search-item-avatar">
                        {author.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="search-item-info">
                        <h4>{author.display_name}</h4>
                        <p>{authorInstitution || (isEnglish ? 'Unknown institution' : 'Institución desconocida')}</p>
                      </div>
                      <FollowButton
                        entity={authorFollow}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {paperResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'papers') && (
              <div className="search-section" data-section="papers">
                <h3 className="search-section-title">{isEnglish ? 'Publications' : 'Publicaciones'}</h3>
                {paperResults.map((paper, index) => {
                  const authors = (paper.authors || []).map(author => author.name || author);
                  return (
                    <div
                      key={paper.id}
                      className="search-item paper-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPaper(paper)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => setSelectedPaper(paper),
                      )}
                    >
                      <div className="search-item-icon"><FileText size={22} /></div>
                      <div className="search-item-info">
                        <h4><ScientificText>{paper.title}</ScientificText></h4>
                        <p className="search-item-authors">{authors.slice(0, 3).join(', ')}{authors.length > 3 ? ` +${authors.length - 3}` : ''}</p>
                        <span className="search-item-meta">
                          {formatPaperDate(paper, locale) || (isEnglish ? 'Unknown date' : 'Fecha desconocida')} • {paper.primaryCategory || paper.journal || 'Paper'}
                        </span>
                      </div>
                    </div>
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
      <AnimatePresence initial={false}>
      {selectedPaper && !pdfPaper && (
        <motion.div
          ref={selectedPaperDialogRef}
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={isEnglish ? 'Paper details' : 'Detalles del paper'}
          tabIndex={-1}
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.995 }}
          transition={prefersReducedMotion
            ? { duration: 0 }
            : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          <button 
            data-dialog-initial-focus
            className="search-back-btn" 
            onClick={closeSelectedPaper}
            aria-label={isEnglish ? 'Back to search results' : 'Volver a los resultados'}
            style={{ position: 'absolute', top: 'max(16px, env(safe-area-inset-top))', left: '16px', zIndex: 1200, background: 'rgba(255,255,255,0.1)', width: '40px', height: '40px' }}
          >
            <ArrowLeft size={22} />
          </button>
          <div style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
            <PaperCard 
              paper={selectedPaper} 
              isLiked={likedPaperIds.has(selectedPaper.id)}
              isSaved={savedPaperIds.has(selectedPaper.id)}
              isRead={readPaperIds.has(selectedPaper.id)}
              onLike={toggleLike}
              onNotInterested={(paper) => { markNotInterested(paper); setSelectedPaper(null); }}
              onMarkAsRead={markAsRead}
              onOpenPdf={(paper) => setPdfPaper(paper)}
              onSaveToList={onSaveToList}
              getInteractionState={getInteractionState}
              trackViewTime={trackViewTime}
              trackSkip={trackSkip}
            />
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* PDF Viewer */}
      {pdfPaper && (
        <PDFViewer paper={pdfPaper} onClose={() => setPdfPaper(null)} />
      )}
    </div>
  );
}
