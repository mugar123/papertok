import { useCallback, useEffect, useRef, useState } from 'react';
import {
  enrichAuthorInstitutionLocalization,
  searchAuthors,
  searchConcepts,
  searchInstitutions,
  searchLocalTopics,
} from '../services/openAlexService';
import { searchProjects } from '../services/openAireService';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter';
import { PaperBuilder } from '../services/PaperBuilder';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useAnalyticsConsent } from '../context/AnalyticsContext';
import {
  authorProminenceWeight,
  filterRelevantSearchResults,
  isOrganisationAuthorRecord,
} from '../utils/searchRelevance';
import { isTransientReadError, patientRead } from '../utils/boundedRead.js';
import {
  USER_SEARCH_DEBOUNCE_MS,
  UserSearchAuthRequiredError,
  UserSearchUnsupportedError,
  isSearchableTerm,
  normalizeUserSearchTerm,
  searchUsers,
} from '../services/userSearchService';

/**
 * The search behind the command palette: five external sources and people.
 *
 * The five — papers, authors, institutions, topics, projects — are OpenAlex and
 * OpenAIRE over HTTP. Each has its own timeout, and the palette waits for all
 * of them before painting anything: the whole answer lands in one commit, so
 * no section can appear late or reshuffle the ranking under a reader who has
 * already started reading. A stale search can never overwrite a newer one nor
 * survive underneath it (see the commit in `performSearch`).
 *
 * People are the sixth section and deliberately NOT the sixth task. They come
 * from our own Firestore, on our own quota: they are kept out of `results` and
 * out of `searchIssue` so a Firestore hiccup can never reach a banner that
 * speaks for OpenAlex, they run on their own 400 ms clock with a two-character
 * floor, and they are only looked up when the caller says the section is going
 * to be painted. `src/components/Search/searchIntegration.test.js` pins all
 * three, for this file and for the page that did it first.
 */

const paperSearchAdapter = new OpenAlexAdapter();
const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6_000;
const SEARCH_MIN_LOADING_MS = 180;
/** Firestore has no client-side timeout; this is the one the palette imposes. */
const USER_SEARCH_TIMEOUT_MS = 6_000;

const EMPTY_RESULTS = Object.freeze({
  papers: [],
  authors: [],
  institutions: [],
  topics: [],
  projects: [],
});

/**
 * The people channel, as one value.
 *
 * `term` is the question the channel is working on; `rowsTerm` is the question
 * `rows` are the answer to. They differ exactly while a search is in flight,
 * which is the window in which the palette must not pass the previous rows off
 * as this answer — and keeping both here means "a people query is still owed"
 * is something the render can derive, instead of a status the query effect has
 * to go and write on every keystroke.
 *
 * status: idle | searching | slow | done | failed | needs-session | unsupported
 */
const EMPTY_PEOPLE = Object.freeze({ status: 'idle', term: '', rows: [], rowsTerm: '' });

const wait = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs));

/** Resolves to a value either way, so one dead source cannot stall the rest. */
function settleSearch(promise, fallback = [], timeoutMs = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ value, status });
    };
    const timeoutId = setTimeout(() => finish(fallback, 'timeout'), timeoutMs);
    Promise.resolve(promise)
      .then(value => finish(value, 'fulfilled'))
      .catch(() => finish(fallback, 'rejected'));
  });
}

/**
 * `usersRequested` is a spend gate, not a preference: every other source is
 * somebody else's quota and costs nothing to over-ask, while a people search is
 * two Firestore reads on ours. It defaults to off so a caller that never
 * renders the section never pays for it by accident.
 */
export function useEntitySearch({ usersRequested = false } = {}) {
  const { language } = useLanguage();
  const { user } = useAuth();
  const { trackEvent } = useAnalyticsConsent();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  // The term `results` answers. Painted rows outlive the query that asked for
  // them on purpose (see the commit below), so the palette needs to be able to
  // say which question they are the answer to.
  const [resultsTerm, setResultsTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIssue, setSearchIssue] = useState(null);

  // People live in their own state, not in `results`, so that they cannot end
  // up in `unavailableSections` — the list that feeds a banner naming OpenAlex.
  const [people, setPeople] = useState(EMPTY_PEOPLE);

  const debounceRef = useRef(null);
  const requestAbortRef = useRef(null);
  const searchIdRef = useRef(0);
  const userSearchIdRef = useRef(0);

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

    const isCurrentSearch = () => (
      searchId === searchIdRef.current && !requestController.signal.aborted
    );
    // Only tags the outcome with its section. Painting used to happen here as
    // well, one straggler at a time, which is what assembled the palette on
    // screen over several seconds; the whole search now lands in a single
    // commit below, exactly as the page already did it.
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
        }).then(items => filterRelevantSearchResults(
          searchTerm,
          // OpenAlex answers an organisation name with institution-as-author
          // records: four of them are called "University of Salamanca". They
          // score 100 and took the top of this section from the people who
          // actually wrote something.
          items.filter(author => !isOrganisationAuthorRecord(author)),
          author => [author.display_name],
          // Several exact matches all score 100; prominence decides which of
          // them a reader was looking for.
          { getWeight: authorProminenceWeight },
        )).then(items => Promise.all(
          items.map(author => enrichAuthorInstitutionLocalization(author, { timeoutMs: 1500 })),
        )),
        [],
        5_000,
      )),
      track('institutions', settleSearch(
        searchInstitutions(searchTerm, {
          signal: requestController.signal,
          throwOnError: true,
        }),
        [],
        4_500,
      )),
      track('topics', settleSearch(
        searchConcepts(searchTerm, {
          language,
          limit: 8,
          signal: requestController.signal,
        }),
        localTopics,
        4_500,
      )),
      track('projects', settleSearch(
        searchProjects(searchTerm, 1, {
          signal: requestController.signal,
          throwOnError: true,
        }).then(result => filterRelevantSearchResults(
          searchTerm,
          result.projects || [],
          project => [project.acronym, project.title, project.funder],
        )),
      )),
    ];

    // One settle. Every source is bounded by its own deadline above, so this
    // waits at most as long as the slowest deadline and then commits the whole
    // palette at once.
    //
    // It used to reveal twice — whatever had arrived by 520 ms, then every
    // straggler painting on its own. Institutions can land 4.5 s in and authors
    // 5 s in, so sections appeared minutes apart in interface time and the
    // ranking was recomputed on each one, moving groups that were already being
    // read. Waiting costs the slowest source; the skeleton covers the wait.
    const outcomes = await Promise.all(tasks);
    const remainingMinimumDelay = Math.max(
      0,
      SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt),
    );
    if (remainingMinimumDelay > 0) await wait(remainingMinimumDelay);
    if (!isCurrentSearch()) return;

    // The commit REPLACES the whole object; it does not merge into whatever the
    // last search left behind. Merging is what used to leave the previous
    // query's authors and institutions sitting under the new query's papers: a
    // source that ran out its timeout never wrote its section, so its old rows
    // survived the entire search with nothing on screen to say they answered a
    // different question.
    //
    // The trade, deliberately: `results` is NOT emptied when a search starts.
    // Emptying it there is the obvious fix and the wrong one — it would turn
    // every keystroke into a blink to nothing and back. So the previous answers
    // stay up until this single commit, whole and never interleaved with the
    // new ones, and `isStale` below marks them while they do.
    const revealedResults = { ...EMPTY_RESULTS };
    outcomes.forEach((outcome) => { revealedResults[outcome.section] = outcome.value; });
    setResults(revealedResults);
    setResultsTerm(searchTerm);

    const resultCount = outcomes.reduce(
      (total, outcome) => total + (Array.isArray(outcome.value) ? outcome.value.length : 0),
      0,
    );
    trackEvent('search_performed', {
      search_type: 'all',
      result_count: resultCount,
      has_results: resultCount > 0,
    });
    const unavailableSections = outcomes
      .filter(outcome => outcome.status !== 'fulfilled')
      .map(outcome => outcome.section);
    setSearchIssue(unavailableSections.length > 0 ? { unavailableSections } : null);
    setIsSearching(false);
    if (requestAbortRef.current === requestController) requestAbortRef.current = null;
  }, [language, trackEvent]);

  /**
   * The people channel. Never routed through `settleSearch`: that envelope
   * turns a failure into an empty array plus an entry in `unavailableSections`,
   * and the banner those feed says the external providers are down. Firestore
   * failing is a different sentence, so it gets its own status and says it
   * itself.
   */
  const performUserSearch = useCallback(async (term) => {
    const searchId = ++userSearchIdRef.current;
    const isCurrent = () => searchId === userSearchIdRef.current;
    // Rows are only replaced by an answer. A search that is merely starting,
    // or one that has gone slow, leaves the previous rows where they are —
    // clearing them would blink the section to empty on every keystroke — and
    // `rowsTerm` keeps saying which question they answered.
    const settlePeople = (status, rows) => setPeople(current => (
      rows ? { status, term, rows, rowsTerm: term } : { ...current, status, term }
    ));

    // Checked before the request, as the page does: the service refuses a
    // signed-out search before the network. The palette only mounts with a
    // session, so this is a state nobody should reach — and if they do it is
    // silent, not an error the palette invents.
    if (!user) {
      settlePeople('needs-session', []);
      return;
    }

    settlePeople('searching');
    try {
      // Firestore has no client timeout: against a connection that is open but
      // silent the promise never settles, and the palette would spin forever.
      // `patientRead` bounds the wait without throwing the answer away — a
      // stall that ends at nine seconds still fills the section at nine.
      const found = await patientRead(() => searchUsers(term), {
        attempts: 2,
        ms: USER_SEARCH_TIMEOUT_MS,
        label: 'user search',
        onSlow: () => { if (isCurrent()) settlePeople('slow'); },
        onLateResult: (rows) => { if (isCurrent()) settlePeople('done', rows); },
      });
      if (!isCurrent()) return;
      settlePeople('done', found);
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof UserSearchAuthRequiredError) {
        settlePeople('needs-session', []);
        return;
      }
      // Demo builds have no people index at all. Not a failure, and not worth a
      // word on screen: the section is simply not part of that build.
      if (error instanceof UserSearchUnsupportedError) {
        settlePeople('unsupported', []);
        return;
      }
      // A timeout is not a failure, it is a wait that is still running: the
      // late answer may still land through onLateResult.
      if (isTransientReadError(error)) {
        settlePeople('slow');
        return;
      }
      console.error('User search failed:', error);
      settlePeople('failed', []);
    }
  }, [user]);

  useEffect(() => {
    if (!query.trim()) {
      requestAbortRef.current?.abort();
      searchIdRef.current += 1;
      userSearchIdRef.current += 1;
      const resetTimeout = setTimeout(() => {
        setResults(EMPTY_RESULTS);
        setResultsTerm('');
        setPeople(EMPTY_PEOPLE);
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetTimeout);
    }

    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    // A people answer for the term just abandoned can no longer paint. That a
    // new one is owed needs no write here: `people.term` still names the old
    // question, which is what keeps `peoplePending` true through the gap
    // between the two debounces.
    userSearchIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(query.trim()), SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceRef.current);
      requestAbortRef.current?.abort();
    };
  }, [performSearch, query]);

  // The second clock. The fan-out above debounces at 320 ms against APIs that
  // do not bill us; this one waits the 400 ms the design fixed for our own
  // quota, and below two characters no query is issued at all, so one typed
  // word costs one search and two reads instead of one search per letter.
  useEffect(() => {
    const term = normalizeUserSearchTerm(query);
    if (!usersRequested || !isSearchableTerm(term)) return undefined;
    const timer = setTimeout(() => performUserSearch(term), USER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, usersRequested, performUserSearch]);

  const reset = useCallback(() => {
    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    userSearchIdRef.current += 1;
    setQuery('');
    setResults(EMPTY_RESULTS);
    setResultsTerm('');
    setPeople(EMPTY_PEOPLE);
    setIsSearching(false);
    setHasSearched(false);
    setSearchIssue(null);
  }, []);

  const typedTerm = query.trim();
  const typedUserTerm = normalizeUserSearchTerm(typedTerm);

  // A people query is owed while the channel is still working on an older
  // question: the two debounces are 80 ms apart and the external one fires
  // first, so between the keystroke and the people timer there is a window
  // where nothing is running yet, and without counting it a fast external
  // answer would settle the palette just before the people search starts.
  // 'slow' deliberately does not count — that wait has already announced
  // itself and still has a live read behind it.
  const peopleWillRun = usersRequested && isSearchableTerm(typedUserTerm);
  // Outside a search this channel is going to run, it has nothing to say: a
  // failure from three keystrokes ago is not a fact about the term on screen
  // now, and a note about it would be the palette talking to itself.
  const userStatus = peopleWillRun ? people.status : 'idle';
  const peoplePending = peopleWillRun
    && (people.term !== typedUserTerm || userStatus === 'searching');

  // Rows outlive the keystroke that made them stale on purpose, but only while
  // an answer for what is being typed is still on its way. Once none is coming
  // — the term fell below two characters, or the section stopped being painted
  // at all — rows answering an older question are not "the previous answer"
  // any more, they are simply wrong, and they go.
  const users = people.rowsTerm === typedUserTerm || peoplePending
    ? people.rows
    : EMPTY_PEOPLE.rows;

  const externalCount = Object.values(results)
    .reduce((total, list) => total + list.length, 0);
  const totalResults = externalCount + users.length;

  // True while what is on screen answers an older question than the one being
  // typed. It is the price of not blinking to empty on every keystroke, and the
  // palette pays it out loud: rows that are still the previous answer are
  // dimmed rather than passed off as this one.
  const isStale = Boolean(typedTerm) && (
    (externalCount > 0 && resultsTerm !== typedTerm)
    || (users.length > 0 && people.rowsTerm !== typedUserTerm)
  );

  return {
    query,
    setQuery,
    results,
    users,
    userStatus,
    totalResults,
    isSearching,
    peoplePending,
    isStale,
    hasSearched,
    searchIssue,
    reset,
  };
}

/** The external fan-out, in order. People are a channel, not one of these. */
export const SEARCH_SECTIONS = Object.freeze(['papers', 'authors', 'institutions', 'topics', 'projects']);
