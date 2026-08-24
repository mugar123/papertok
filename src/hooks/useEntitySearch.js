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
import { useLanguage } from '../context/LanguageContext';
import { useAnalyticsConsent } from '../context/AnalyticsContext';
import { filterRelevantSearchResults } from '../utils/searchRelevance';

/**
 * The five-source search behind the command palette.
 *
 * Each source has its own timeout and settles independently, so one slow
 * provider cannot hold up the rest; results appear together after a short reveal
 * window, and a stale search can never overwrite a newer one.
 */

const paperSearchAdapter = new OpenAlexAdapter();
const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6_000;
const SEARCH_MIN_LOADING_MS = 180;
const SEARCH_INITIAL_REVEAL_MS = 520;

const EMPTY_RESULTS = Object.freeze({
  papers: [],
  authors: [],
  institutions: [],
  topics: [],
  projects: [],
});

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

export function useEntitySearch() {
  const { language } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(EMPTY_RESULTS);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIssue, setSearchIssue] = useState(null);

  const debounceRef = useRef(null);
  const requestAbortRef = useRef(null);
  const searchIdRef = useRef(0);

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

    const resolvedOutcomes = new Map();
    let initialResultsRevealed = false;
    const isCurrentSearch = () => (
      searchId === searchIdRef.current && !requestController.signal.aborted
    );
    const applySection = (section, value) => {
      setResults(current => ({ ...current, [section]: value }));
    };
    const track = (section, promise) => promise.then((outcome) => {
      const trackedOutcome = { ...outcome, section };
      resolvedOutcomes.set(section, trackedOutcome);
      if (initialResultsRevealed && isCurrentSearch()) applySection(section, outcome.value);
      return trackedOutcome;
    });

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
          items,
          author => [author.display_name],
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

    const allOutcomesPromise = Promise.all(tasks);
    await Promise.race([allOutcomesPromise, wait(SEARCH_INITIAL_REVEAL_MS)]);
    const remainingMinimumDelay = Math.max(
      0,
      SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt),
    );
    if (remainingMinimumDelay > 0) await wait(remainingMinimumDelay);

    if (!isCurrentSearch()) return;
    resolvedOutcomes.forEach(outcome => applySection(outcome.section, outcome.value));
    initialResultsRevealed = true;

    const outcomes = await allOutcomesPromise;
    if (!isCurrentSearch()) return;

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
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetTimeout);
    }

    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(query.trim()), SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceRef.current);
      requestAbortRef.current?.abort();
    };
  }, [performSearch, query]);

  const reset = useCallback(() => {
    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    setQuery('');
    setResults(EMPTY_RESULTS);
    setIsSearching(false);
    setHasSearched(false);
    setSearchIssue(null);
  }, []);

  const totalResults = Object.values(results)
    .reduce((total, list) => total + list.length, 0);

  return {
    query,
    setQuery,
    results,
    totalResults,
    isSearching,
    hasSearched,
    searchIssue,
    reset,
  };
}

export const SEARCH_SECTIONS = Object.freeze(['papers', 'authors', 'institutions', 'topics', 'projects']);
