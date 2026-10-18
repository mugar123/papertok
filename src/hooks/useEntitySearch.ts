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

/** Each section exposes its own result count without waiting for the other providers. */

const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6_000;
const SEARCH_MIN_LOADING_MS = 180;
const SECTIONS = ['papers', 'authors', 'topics', 'institutions', 'projects'] as const;

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
  const [resultsTerm, setResultsTerm] = useState('');
  const [pendingSections, setPendingSections] = useState<Array<keyof SearchResults>>([]);
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

    setResults(EMPTY_RESULTS);
    setResultsTerm(searchTerm);
    setPendingSections([...SECTIONS]);
    setHasSearched(true);
    setSearchIssue(null);

    const isCurrentSearch = () => (
      searchId === searchIdRef.current && !requestController.signal.aborted
    );
    const track = <K extends keyof SearchResults>(section: K, promise: Promise<SearchOutcome<SearchResults[K]>>) => promise.then(async outcome => {
      const remaining = Math.max(0, SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt));
      if (remaining) await wait(remaining);
      if (isCurrentSearch()) {
        setResults(previous => ({ ...previous, [section]: outcome.value }));
        setPendingSections(previous => previous.filter(item => item !== section));
        if (outcome.status !== 'fulfilled') setSearchIssue(previous => ({
          unavailableSections: [...(previous?.unavailableSections || []), section],
        }));
      }
      return { ...outcome, section };
    });

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

    const outcomes = await Promise.all(tasks);
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
    if (requestAbortRef.current === requestController) requestAbortRef.current = null;
  }, [language, trackEvent]);

  useEffect(() => {
    if (!query.trim()) {
      requestAbortRef.current?.abort();
      searchIdRef.current += 1;
      const resetTimeout = setTimeout(() => {
        setResults(EMPTY_RESULTS);
        setResultsTerm('');
        setPendingSections([]);
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
    setPendingSections([]);
    setHasSearched(false);
    setSearchIssue(null);
  }, []);

  const typedTerm = query.trim();

  const totalResults = Object.values(results)
    .reduce((total, list) => total + list.length, 0);

  // Old-query rows and counts stay hidden throughout the debounce.
  const isStale = Boolean(typedTerm) && resultsTerm !== typedTerm;
  const isPending = Boolean(typedTerm) && (isStale || pendingSections.length === SECTIONS.length);

  return {
    query,
    setQuery,
    results: isStale ? EMPTY_RESULTS : results,
    totalResults: isStale ? 0 : totalResults,
    pendingSections: isStale ? [...SECTIONS] : pendingSections,
    resultsTerm,
    isPending,
    hasSearched,
    searchIssue: isStale ? null : searchIssue,
    reset,
  };
}
