import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Paper } from '../models/Paper.ts';
import { EMPTY_SEARCH, SEARCH_SECTIONS, searchEntities } from '../services/entitySearchService.ts';
import type { SearchSection, SearchSnapshot } from '../services/entitySearchService.ts';
import { useAnalyticsConsent } from '../context/AnalyticsContext.tsx';

const SEARCH_DEBOUNCE_MS = 320;
type SearchScope = 'all' | SearchSection;
type SearchAnswer = { term: string; signal: AbortSignal; snapshot: SearchSnapshot };

export function useEntitySearch(enabled: boolean, knownPapers: Paper[], section: SearchScope = 'all') {
  const { trackEvent } = useAnalyticsConsent();
  const [query, setTerm] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | null>(null);
  // The visible answer has its own lifetime: background replies may only enter
  // it when the user changes scope, edits the query or explicitly retries.
  const [published, setPublished] = useState<(SearchAnswer & { section: SearchScope }) | null>(null);
  const request = useRef<AbortController | null>(null);

  const performSearch = useCallback(async (term: string, papers: Paper[]) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAnswer({ term, signal: controller.signal, snapshot: { ...EMPTY_SEARCH, pending: SEARCH_SECTIONS } });
    const snapshot = await searchEntities(term, {
      signal: controller.signal, knownPapers: papers,
      onUpdate: snapshot => {
        if (!controller.signal.aborted) setAnswer({ term, signal: controller.signal, snapshot });
      },
    });
    if (controller.signal.aborted) return;
    const count = Object.values(snapshot.results).reduce((total, list) => total + list.length, 0);
    trackEvent('search_performed', { search_type: 'all', result_count: count, has_results: count > 0 });
  }, [trackEvent]);

  const startSearch = useEffectEvent((term: string) => performSearch(term, knownPapers));

  useEffect(() => {
    request.current?.abort();
    if (!enabled || !query.trim()) return;
    const timer = setTimeout(() => { void startSearch(query.trim()); }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [enabled, query]);

  const setQuery = useCallback((term: string) => {
    if (term === query) return;
    request.current?.abort();
    setTerm(term);
    setAnswer(null);
  }, [query]);
  const reset = useCallback(() => {
    request.current?.abort();
    setTerm('');
    setAnswer(null);
    setPublished(null);
  }, []);
  const retry = () => { if (query.trim()) void performSearch(query.trim(), knownPapers); };

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
