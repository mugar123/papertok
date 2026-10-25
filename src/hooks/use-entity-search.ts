import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Paper } from '../models/paper.ts';
import { EMPTY_SEARCH, SEARCH_SECTIONS, searchEntities } from '../services/entity-search-service.ts';
import type { EntitySearch, SearchScope, SearchSnapshot } from '../services/entity-search-service.ts';
import { useAnalyticsConsent } from '../context/analytics-context.tsx';

const SEARCH_DEBOUNCE_MS = 320;
type SearchAnswer = { term: string; signal: AbortSignal; snapshot: SearchSnapshot };
type SearchRequest = { controller: AbortController; search: EntitySearch };

export function useEntitySearch(enabled: boolean, knownPapers: Paper[], section: SearchScope = 'all') {
  const { trackEvent } = useAnalyticsConsent();
  const [query, setTerm] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  // The visible answer has its own lifetime: background replies may only enter
  // it when the user changes scope, edits the query or explicitly retries.
  const [published, setPublished] = useState<(SearchAnswer & { section: SearchScope }) | null>(null);
  const request = useRef<SearchRequest | null>(null);

  const performSearch = useCallback(async (term: string, papers: Paper[], scope: SearchScope) => {
    request.current?.controller.abort();
    const controller = new AbortController();
    setAnswer({ term, signal: controller.signal, snapshot: { ...EMPTY_SEARCH, pending: SEARCH_SECTIONS } });
    const search = searchEntities(term, {
      signal: controller.signal, knownPapers: papers,
      onUpdate: snapshot => {
        if (!controller.signal.aborted) setAnswer({ term, signal: controller.signal, snapshot });
      },
    });
    request.current = { controller, search };
    const snapshot = await search.ask(scope);
    if (controller.signal.aborted) return;
    const count = Object.values(snapshot.results).reduce((total, list) => total + list.length, 0);
    void trackEvent('search_performed', { search_type: scope, result_count: count, has_results: count > 0, query: term });
  }, [trackEvent]);

  const startSearch = useEffectEvent((term: string) => performSearch(term, knownPapers, section));

  useEffect(() => {
    request.current?.controller.abort();
    if (!enabled || !query.trim()) return;
    const timer = setTimeout(() => { void startSearch(query.trim()); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); request.current?.controller.abort(); };
  }, [enabled, query]);

  // A type opened while its search is running is asked for then, so a reader
  // who stays on Papers never pays for the other sections. One opened before
  // the search starts is what the search starts with.
  const openSection = useEffectEvent((scope: SearchScope) => {
    const current = request.current;
    if (current && !current.controller.signal.aborted) void current.search.ask(scope);
  });
  useEffect(() => { openSection(section); }, [section]);

  const setQuery = useCallback((term: string) => {
    if (term === query) return;
    request.current?.controller.abort();
    setTerm(term);
    setAnswer(null);
  }, [query]);
  const reset = useCallback(() => {
    request.current?.controller.abort();
    setTerm('');
    setAnswer(null);
    setPublished(null);
  }, []);
  const retry = () => { if (query.trim()) void performSearch(query.trim(), knownPapers, section); };

  const current = Boolean(query.trim()) && answer?.term === query.trim();
  const ready = current && (section === 'all' ? answer.snapshot.pending.length === 0 : !answer.snapshot.pending.includes(section));
  let visible = published;
  if (ready && (published?.signal !== answer.signal || published.section !== section)) {
    visible = { ...answer, section };
    setPublished(visible);
  }
  const hasSearched = Boolean(ready && visible?.signal === answer?.signal && visible?.section === section);
  const snapshot = hasSearched ? visible!.snapshot : EMPTY_SEARCH;
  const totalResults = Object.values(snapshot.results).reduce((total, list) => total + list.length, 0);
  return {
    query, setQuery, results: snapshot.results, resultsTerm: hasSearched ? visible!.term : '',
    totalResults,
    isPending: Boolean(query.trim()) && !hasSearched, hasSearched,
    pendingSections: hasSearched ? snapshot.pending : SEARCH_SECTIONS,
    searchIssues: snapshot.issues,
    reset, retry,
  };
}
