import type { Paper } from '../models/paper.ts';
import type { LoadingFollow } from '../services/paper-store-service.ts';
import type { SessionCache } from '../utils/session-cache.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  advancesByItself,
  feedEmptyKind,
  feedOpening,
  mergeFeedPage,
  type CustomFeedPages,
} from '../utils/custom-feed-pages.ts';

type Pending = 'first' | 'more' | 'refresh';

/**
 * One list's pages for one key and the run they belong to; the load the
 * reader started (`pending`), how many pages in a row the list asked for by
 * itself while it showed nothing, the last press on its tab that was answered,
 * and a refresh waiting for the profile. Loads an effect starts are not marked: they are derived from
 * what is missing (no pages, nothing shown, a press not yet answered).
 */
interface PagesState<Run> {
  key: string | null; pages: CustomFeedPages | null; run: Run | null;
  error: unknown; pending: Pending | null; emptyAdvances: number; answeredPress: number | null;
  /** A refresh the reader asked for before the profile was ready, started once it is. */
  queued: boolean;
}

interface Caches<Run> { pages: SessionCache<CustomFeedPages>; runs: SessionCache<Run> }

// A list that names nothing the corpus can serve is not asked for: it is empty.
const NOTHING: CustomFeedPages = { papers: [], page: 0, hasMore: false, loading: [] };
const NO_PAPERS: Paper[] = [];

// A press standing when the state starts is an earlier visit's: it counts as answered.
const seeded = <Run>(caches: Caches<Run>, key: string | null, press: number | null): PagesState<Run> => ({
  key,
  pages: key ? caches.pages.get(key) ?? null : null,
  run: key ? caches.runs.get(key) ?? null : null,
  error: null,
  pending: null,
  emptyAdvances: 0,
  answeredPress: press,
  queued: false,
});

/**
 * A list paged from the corpus, as a custom feed's: its pages merged, kept for
 * the session under `key` so a return visit resumes them, and the run they
 * belong to. A run (a first page or a refresh) starts only once the reader's
 * profile is `ready`, and every later page of it asks with what `runFor` gave
 * its first page. While the list shows nothing it asks for its next page by
 * itself, a few times in a row at most. A press on its tab starts a new run;
 * so does `refresh`, which waits for the profile when it is not ready yet.
 * An answer that arrives after a newer request, a new key or the unmount is
 * dropped. `caches` must keep its two caches' identities across renders.
 */
export function useCorpusFeedPages<Run>(options: {
  /** The list's identity; a new key starts from that key's kept pages. Null: no list. */
  key: string | null;
  /** False until the reader's profile has loaded: no run starts before. */
  ready: boolean;
  /** The reader's latest press on this list's tab while on it, or null. */
  press: number | null;
  /** True when the list has nothing to ask the corpus for: it is empty and asks nothing. */
  asksNothing: boolean;
  /** The run page `page` belongs to: `current` after a run's first page, a new one otherwise. */
  runFor: (current: Run | null, page: number) => Run;
  /** Asks the corpus for the page. `run`, when returned, replaces the run kept with the pages. */
  ask: (run: Run, page: number) => Promise<{ papers: Paper[]; hasMore: boolean; loading?: LoadingFollow[]; run?: Run }>;
  /** The papers of the merged list to show now. */
  shown: (papers: Paper[]) => Paper[];
  caches: Caches<Run>;
}): {
  pages: CustomFeedPages | null; papers: Paper[]; loading: boolean; error: unknown; hasMore: boolean;
  loadMore: () => boolean; refresh: () => void; isRefreshing: boolean;
  emptyKind: 'gathering' | 'nothing' | 'error' | null;
} {
  const { key, ready: profileReady, press, asksNothing, runFor, ask, shown, caches } = options;
  const { pages: pagesCache, runs: runsCache } = caches;

  // A new key starts from that key's own pages.
  const [state, setState] = useState(() => seeded(caches, key, press));
  if (state.key !== key) setState(seeded(caches, key, press));
  const view = state.key === key ? state : seeded(caches, key, press);

  // Each request takes a token; an answer whose token is no longer the latest,
  // because another request, a new key or the unmount came after it, is
  // dropped. `purpose` names the load, so an effect does not start it twice.
  const tokenRef = useRef(0);
  const inFlightRef = useRef<{ token: number; purpose: string } | null>(null);
  useEffect(() => () => {
    tokenRef.current += 1;
    inFlightRef.current = null;
  }, [key]);

  /**
   * Asks for page `page`, with its run, and applies the answer if it is still
   * the latest request; `settled` goes into the state with it, answer or
   * failure. Sets no state before the answer.
   */
  const fetchPage = useCallback((purpose: string, page: number, settled: Partial<PagesState<Run>> = {}) => {
    if (!key || asksNothing) return false;
    const run = runFor(view.run, page);
    tokenRef.current += 1;
    const token = tokenRef.current;
    inFlightRef.current = { token, purpose };
    void ask(run, page).then((answer) => {
      if (tokenRef.current !== token) return;
      inFlightRef.current = null;
      const incoming = { papers: answer.papers, hasMore: answer.hasMore, loading: answer.loading ?? [] };
      setState(current => (current.key === key
        ? { ...current, ...settled, pages: mergeFeedPage(current.pages, incoming, page), run: answer.run ?? run, error: null, pending: null }
        : current));
    }, (error: unknown) => {
      if (tokenRef.current !== token) return;
      inFlightRef.current = null;
      // The pages already shown, and their run, stay; the error says the request failed.
      setState(current => (current.key === key ? { ...current, ...settled, error, pending: null } : current));
    });
    return true;
  }, [ask, asksNothing, key, runFor, view.run]);

  const pages = asksNothing ? NOTHING : view.pages;
  useEffect(() => {
    if (!view.key || !view.pages || !view.run) return;
    pagesCache.set(view.key, view.pages);
    runsCache.set(view.key, view.run);
  }, [pagesCache, runsCache, view.key, view.pages, view.run]);

  const papers = useMemo(() => (pages ? shown(pages.papers) : NO_PAPERS), [pages, shown]);

  // Papers on screen again end the streak of pages asked for by themselves.
  if (papers.length > 0 && state.key === key && state.emptyAdvances > 0) setState({ ...state, emptyAdvances: 0 });

  // The loads the list starts by itself: an unanswered press on its tab (a new
  // run), its first page, and its next page while every paper shown was taken
  // out, a few times in a row at most.
  const servable = key !== null && !asksNothing;
  const pressPending = servable && press !== null && press !== view.answeredPress;
  const idle = servable && !view.error && view.pending === null;
  const opening = feedOpening(Boolean(view.pages), profileReady);
  const needsFirstPage = idle && opening !== 'show';
  const needsNextPage = idle && Boolean(view.pages) && advancesByItself(Boolean(view.pages?.hasMore), papers.length, view.emptyAdvances);
  const nextPage = (view.pages?.page ?? -1) + 1;
  const advances = view.emptyAdvances;
  const queued = view.queued;
  useEffect(() => {
    const running = inFlightRef.current?.purpose;
    if (pressPending && profileReady) {
      // A press supersedes whatever is loading.
      if (running !== `press:${press}`) fetchPage(`press:${press}`, 0, { answeredPress: press, emptyAdvances: 0, queued: false });
    } else if (queued && profileReady) {
      if (running !== 'queued') fetchPage('queued', 0, { emptyAdvances: 0, queued: false });
    } else if (running !== undefined) {
      // A load is already on its way.
    } else if (needsFirstPage && opening === 'start') {
      fetchPage('first', 0, { emptyAdvances: 0 });
    } else if (needsNextPage) {
      fetchPage(`auto:${nextPage}`, nextPage, { emptyAdvances: advances + 1 });
    }
  }, [advances, fetchPage, needsFirstPage, needsNextPage, nextPage, opening, press, pressPending, profileReady, queued]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== null || !view.pages?.hasMore) return false;
    const page = view.pages.page + 1;
    if (!fetchPage('more', page, { emptyAdvances: 0 })) return false;
    setState(current => (current.key === key ? { ...current, pending: 'more' } : current));
    return true;
  }, [fetchPage, key, view.pages]);

  // A new run from the first page; the papers shown stay until it arrives.
  // Before the profile is ready it is queued, and starts when it is.
  const refresh = useCallback(() => {
    const kind: Pending = view.pages ? 'refresh' : 'first';
    if (profileReady ? !fetchPage(kind, 0, { emptyAdvances: 0 }) : asksNothing || !key) return;
    setState(current => (current.key === key
      ? { ...current, pending: kind, queued: !profileReady, ...(kind === 'first' ? { error: null } : {}) }
      : current));
  }, [asksNothing, fetchPage, key, profileReady, view.pages]);

  const loading = view.pending === 'first' || view.pending === 'more' || needsFirstPage || needsNextPage || (pressPending && !view.pages);

  return {
    pages,
    papers,
    loading,
    error: view.error,
    hasMore: Boolean(pages?.hasMore),
    loadMore,
    refresh,
    isRefreshing: view.pending === 'refresh' || (pressPending && Boolean(view.pages)),
    // Not while a page is on its way, which may still bring papers to show.
    emptyKind: loading ? null : feedEmptyKind(pages && { ...pages, papers }, view.error),
  };
}
