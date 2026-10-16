import type { Paper } from '../models/Paper.ts';
import type { OpenAlexAuthor, OpenAlexInstitution, OpenAlexTopic } from '../services/adapters/openAlexTypes.ts';
import type { Project } from '../services/openAireService.ts';
import type { trackProductEvent } from '../services/analyticsService.ts';
interface SearchResults { papers: Paper[]; authors: OpenAlexAuthor[]; institutions: OpenAlexInstitution[]; topics: OpenAlexTopic[]; projects: Project[] }
interface SearchOutcome<T> { value: T; status: 'fulfilled' | 'rejected' | 'timeout' }

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  enrichAuthorInstitutionLocalization,
  searchAuthors,
  searchConcepts,
  searchInstitutions,
  searchLocalTopics,
} from '../services/openAlexService.ts';
import { searchProjects } from '../services/openAireService.ts';
import { searchPapersAcrossSources } from '../services/paperSearchService.ts';
import { useLanguage } from '../context/LanguageContext.tsx';
import { useAnalyticsConsent } from '../context/AnalyticsContext.tsx';
import {
  authorProminenceWeight,
  filterRelevantSearchResults,
  isOrganisationAuthorRecord,
} from '../utils/searchRelevance.ts';

/**
 * The search behind the command palette: five external sources.
 *
 * Papers, authors, institutions, topics and projects are OpenAlex and
 * OpenAIRE over HTTP. Each has its own timeout, and the palette waits for all
 * of them before painting anything: the whole answer lands in one commit, so
 * no section can appear late or reshuffle the ranking under a reader who has
 * already started reading. A stale search can never overwrite a newer one nor
 * survive underneath it (see the commit in `performSearch`).
 */

const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6_000;
const SEARCH_MIN_LOADING_MS = 180;

const EMPTY_RESULTS: Readonly<SearchResults> = Object.freeze({
  papers: [],
  authors: [],
  institutions: [],
  topics: [],
  projects: [],
});

const wait = (delayMs: number|undefined) => new Promise<void>(resolve => setTimeout(resolve, delayMs));

/** Resolves to a value either way, so one dead source cannot stall the rest. */
function settleSearch<T>(promise: Promise<T[]>, fallback: T[] = [], timeoutMs = SEARCH_TIMEOUT_MS) {
  return new Promise<SearchOutcome<T[]>>((resolve) => {
    let settled = false;
    let timeoutId: number|null|undefined = null;
    const finish = (value: T[], status: SearchOutcome<T[]>['status']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId!);
      resolve({ value, status });
    };
    timeoutId = setTimeout(() => finish(fallback, 'timeout'), timeoutMs);
    Promise.resolve(promise)
      .then(value => finish(value, 'fulfilled'))
      .catch(() => finish(fallback, 'rejected'));
  });
}

export function useEntitySearch() {
  const { language } = useLanguage();
  const { trackEvent } = useAnalyticsConsent() as { trackEvent: typeof trackProductEvent };

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  // The term `results` answers. Painted rows outlive the query that asked for
  // them on purpose (see the commit below), so the palette needs to be able to
  // say which question they are the answer to.
  const [resultsTerm, setResultsTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIssue, setSearchIssue] = useState<{ unavailableSections: Array<keyof SearchResults> } | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const searchIdRef = useRef(0);

  const performSearch = useCallback(async (searchTerm: string) => {
    const searchStartedAt = Date.now();
    const searchId = ++searchIdRef.current;
    requestAbortRef.current?.abort();
    const requestController = new AbortController();
    requestAbortRef.current = requestController;
    const localTopics = searchLocalTopics(searchTerm, 8);

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
    const track = <K extends keyof SearchResults>(section: K, promise: Promise<SearchOutcome<SearchResults[K]>>) => promise.then(outcome => ({ ...outcome, section }));

    const tasks = [
      // OpenAlex and arXiv, merged and ranked by title match
      // (paperSearchService.js), the same call the page makes.
      track('papers', settleSearch(
        searchPapersAcrossSources(searchTerm, { signal: requestController.signal }),
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
    // stay in state until this single commit, whole and never interleaved with
    // the new ones, and `isPending` below keeps them off screen meanwhile.
    const revealedResults = { ...EMPTY_RESULTS };
    outcomes.forEach(<K extends keyof SearchResults>(outcome: SearchOutcome<SearchResults[K]> & { section: K }) => { revealedResults[outcome.section] = outcome.value; });
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

  useEffect(() => {
    if (!query.trim()) {
      requestAbortRef.current?.abort();
      searchIdRef.current += 1;
      const resetTimeout = setTimeout(() => {
        setResults(EMPTY_RESULTS);
        setResultsTerm('');
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetTimeout);
    }

    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current!);
    debounceRef.current = setTimeout(() => performSearch(query.trim()), SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceRef.current!);
      requestAbortRef.current?.abort();
    };
  }, [performSearch, query]);

  const reset = useCallback(() => {
    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    setQuery('');
    setResults(EMPTY_RESULTS);
    setResultsTerm('');
    setIsSearching(false);
    setHasSearched(false);
    setSearchIssue(null);
  }, []);

  const typedTerm = query.trim();

  const totalResults = Object.values(results)
    .reduce((total, list) => total + list.length, 0);

  // An answer is owed from the first keystroke, not from the end of the
  // debounce. Until it lands the palette shows its skeleton, not the previous
  // answer: rows left from an older query would still take Enter and be read
  // out as results for the one being typed.
  const isPending = isSearching
    || (Boolean(typedTerm) && resultsTerm !== typedTerm);

  return {
    query,
    setQuery,
    results,
    totalResults,
    isPending,
    hasSearched,
    searchIssue,
    reset,
  };
}
