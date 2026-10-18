import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Paper } from '../models/Paper.ts';
import { EMPTY_SEARCH, SEARCH_SECTIONS, searchEntities } from '../services/entitySearchService.ts';
import type { SearchSnapshot } from '../services/entitySearchService.ts';
import { useAnalyticsConsent } from '../context/AnalyticsContext.tsx';

const SEARCH_DEBOUNCE_MS = 320;
const INITIAL_RESULT_WINDOW_MS = 250;

export function useEntitySearch(enabled: boolean, knownPapers: Paper[]) {
  const { trackEvent } = useAnalyticsConsent();
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<{ term: string; snapshot: SearchSnapshot }>({ term: '', snapshot: EMPTY_SEARCH });
  const request = useRef<AbortController | null>(null);

  const performSearch = useCallback(async (term: string, papers: Paper[]) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    let buffered: SearchSnapshot;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let revealed = false;
    const cancelReveal = () => clearTimeout(revealTimer);
    controller.signal.addEventListener('abort', cancelReveal, { once: true });
    const publish = (snapshot: SearchSnapshot) => {
      if (controller.signal.aborted) return;
      buffered = snapshot;
      if (revealed) {
        setAnswer({ term, snapshot });
      } else if (revealTimer === undefined) {
        if (!Object.values(snapshot.results).some(items => items.length > 0)) {
          setAnswer({ term, snapshot });
          return;
        }
        // One window from the first usable answer; later sources cannot extend it.
        revealTimer = setTimeout(() => {
          controller.signal.removeEventListener('abort', cancelReveal);
          if (controller.signal.aborted) return;
          revealed = true;
          setAnswer({ term, snapshot: buffered });
        }, INITIAL_RESULT_WINDOW_MS);
      }
    };
    const snapshot = await searchEntities(term, {
      signal: controller.signal, knownPapers: papers,
      onUpdate: publish,
    });
    if (revealTimer === undefined) controller.signal.removeEventListener('abort', cancelReveal);
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
  }, [enabled, performSearch, query]);

  const reset = useCallback(() => {
    request.current?.abort();
    setQuery('');
    setAnswer({ term: '', snapshot: EMPTY_SEARCH });
  }, []);
  const retry = () => { if (query.trim()) void performSearch(query.trim(), knownPapers); };

  // Hide the old answer from the first keystroke, including its status and
  // keyboard targets. A cancelled request cannot publish into a new query.
  const current = Boolean(query.trim()) && answer.term === query.trim();
  const snapshot = current ? answer.snapshot : EMPTY_SEARCH;
  const totalResults = Object.values(snapshot.results).reduce((total, list) => total + list.length, 0);
  const isPending = Boolean(query.trim()) && (!current || (totalResults === 0 && snapshot.pending.length > 0));
  return {
    query, setQuery, results: snapshot.results, resultsTerm: answer.term,
    totalResults,
    isPending, hasSearched: current,
    pendingSections: query.trim() && !current ? SEARCH_SECTIONS : snapshot.pending,
    searchIssues: snapshot.issues,
    reset, retry,
  };
}
