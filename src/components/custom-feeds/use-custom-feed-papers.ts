import type { Paper } from '../../models/paper.ts';
import type { CustomFeed, FeedIngredient } from '../../utils/custom-feeds.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { fetchCorpusPage } from '../../services/paper-store-service.ts';
import { MAX_DISMISSED_PER_FEED, readDismissed, saveDismissed } from '../../utils/custom-feed-dismissed.ts';
import {
  advancesByItself,
  customFeedPagesCache,
  customFeedRunsCache,
  feedEmptyKind,
  feedOpening,
  feedPageRequest,
  feedPagesKey,
  feedRunSignals,
  loadingIngredientsOf,
  mergeFeedPage,
  type CustomFeedPages,
  type FeedRunSignals,
} from '../../utils/custom-feed-pages.ts';
import { withoutNotInterested } from '../../utils/following-feed.ts';

type Pending = 'first' | 'more' | 'refresh';

/**
 * One feed's pages for one account (`key`) and the run they belong to; the
 * load the reader started (`pending`), how many pages in a row the feed asked
 * for by itself while it showed nothing, the last press on its tab that
 * was answered, and a refresh waiting for the profile. Loads an effect starts are not marked: they are derived from
 * what is missing (no pages, nothing shown, a press not yet answered).
 */
interface PagesState {
  key: string | null; pages: CustomFeedPages | null; run: FeedRunSignals | null;
  error: unknown; pending: Pending | null; emptyAdvances: number; answeredPress: number | null;
  /** A refresh the reader asked for before the profile was ready, started once it is. */
  queued: boolean;
}

// A feed that names nothing the corpus can serve is not asked for: it is empty.
const NOTHING: CustomFeedPages = { papers: [], page: 0, hasMore: false, loading: [] };
const NO_PAPERS: Paper[] = [];
const NO_IDS: string[] = [];
const NO_SIGNALS: FeedRunSignals = { positiveIds: NO_IDS, excludedIds: NO_IDS };

// A press standing when the state starts is an earlier visit's: it counts as answered.
const seeded = (key: string | null, press: number | null): PagesState => ({
  key,
  pages: key ? customFeedPagesCache.get(key) ?? null : null,
  run: key ? customFeedRunsCache.get(key) ?? null : null,
  error: null,
  pending: null,
  emptyAdvances: 0,
  answeredPress: press,
  queued: false,
});
const storedDismissed = (uid: string | null, feedId: string | undefined) => (uid && feedId ? readDismissed(uid, feedId) : NO_IDS);

/**
 * The papers of a custom feed's page, for FeedContainer's source: its pages
 * from the corpus, merged, minus the papers the reader marked Not interested
 * anywhere and the ones removed from this feed. The pages are kept for the
 * session under the account and what the feed asks for, so a return visit
 * resumes them. A run (a first page or a refresh) takes the reader's newest
 * examples and the feed's removed papers when it starts, and every later page
 * of it asks with the same ones; a like or a removal reaches the ranking at the
 * next refresh, and a removal leaves the screen at once.
 */
export function useCustomFeedPapers(feed: CustomFeed | null): {
  papers: Paper[]; loading: boolean; error: unknown; hasMore: boolean;
  loadMore: () => boolean; refresh: () => void; isRefreshing: boolean;
  emptyKind: 'gathering' | 'nothing' | 'error' | null; loadingIngredients: FeedIngredient[];
  dismiss: (paper: Paper) => void; restore: (paper: Paper) => void;
} {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { notInterestedIds, getPositiveExampleIds, getRecommendationProfileSnapshot } = useFeed();
  const { refreshRequest } = useCustomFeeds();
  // The reader's latest press on this feed's tab while on it.
  const press = refreshRequest && feed && refreshRequest.feedId === feed.id ? refreshRequest.n : null;

  // A run starts only once this account's profile has loaded, so it never
  // locks in the empty examples the profile holds before. The snapshot's
  // identity changes when readiness flips. Readiness always comes: FeedProvider
  // marks the profile ready in a `finally` once its read answers, fails or
  // runs out of INTERACTIONS_NETWORK_TIMEOUT_MS (5 s; `loadInteractions` in
  // feed-context.tsx), and a profile that never arrives leaves the examples
  // empty, which is then what the run starts with.
  const profile = useMemo(() => getRecommendationProfileSnapshot(), [getRecommendationProfileSnapshot]);
  const profileReady = profile.ready && profile.userId === uid;

  const key = uid && feed ? feedPagesKey(uid, feed) : null;
  const asksNothing = feed !== null && feedPageRequest(feed, NO_SIGNALS, 0) === null;

  // A new account, feed, ingredient or order starts from that key's own pages.
  const [state, setState] = useState(() => seeded(key, press));
  if (state.key !== key) setState(seeded(key, press));
  const view = state.key === key ? state : seeded(key, press);

  const owner = uid && feed ? `${uid}\n${feed.id}` : null;
  const [removed, setRemoved] = useState(() => ({ owner, ids: storedDismissed(uid, feed?.id) }));
  if (removed.owner !== owner) setRemoved({ owner, ids: storedDismissed(uid, feed?.id) });
  const dismissed = removed.owner === owner ? removed.ids : NO_IDS;
  // The list as the last dismiss or restore left it, before React renders it,
  // so two of them in one render both land.
  const removedRef = useRef(removed);
  useEffect(() => {
    removedRef.current = removed;
  }, [removed]);
  const currentDismissed = useCallback(
    () => (removedRef.current.owner === owner ? removedRef.current.ids : storedDismissed(uid, feed?.id)),
    [feed?.id, owner, uid],
  );

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
   * Asks for page `page`, with its run's signals, and applies the answer if it
   * is still the latest request; `settled` goes into the state with it, answer
   * or failure. Sets no state before the answer.
   */
  const fetchPage = useCallback((purpose: string, page: number, settled: Partial<PagesState> = {}) => {
    if (!key || !feed) return false;
    const signals = feedRunSignals(view.run, page, { positiveIds: getPositiveExampleIds(), dismissed: currentDismissed() });
    const request = feedPageRequest(feed, signals, page);
    if (!request) return false;
    tokenRef.current += 1;
    const token = tokenRef.current;
    inFlightRef.current = { token, purpose };
    void fetchCorpusPage(request).then((answer) => {
      if (tokenRef.current !== token) return;
      inFlightRef.current = null;
      setState(current => (current.key === key
        ? { ...current, ...settled, pages: mergeFeedPage(current.pages, answer, page), run: signals, error: null, pending: null }
        : current));
    }, (error: unknown) => {
      if (tokenRef.current !== token) return;
      inFlightRef.current = null;
      // The pages already shown, and their run, stay; the error says the request failed.
      setState(current => (current.key === key ? { ...current, ...settled, error, pending: null } : current));
    });
    return true;
  }, [currentDismissed, feed, getPositiveExampleIds, key, view.run]);

  const pages = asksNothing ? NOTHING : view.pages;
  useEffect(() => {
    if (!view.key || !view.pages || !view.run) return;
    customFeedPagesCache.set(view.key, view.pages);
    customFeedRunsCache.set(view.key, view.run);
  }, [view.key, view.pages, view.run]);

  const papers = useMemo(() => {
    if (!pages) return NO_PAPERS;
    const shown = withoutNotInterested(pages.papers, notInterestedIds);
    if (!dismissed.length) return shown;
    const gone = new Set(dismissed);
    return shown.filter(paper => !gone.has(paper.id));
  }, [pages, notInterestedIds, dismissed]);

  // Papers on screen again end the streak of pages asked for by themselves.
  if (papers.length > 0 && state.key === key && state.emptyAdvances > 0) setState({ ...state, emptyAdvances: 0 });

  // The loads the feed starts by itself: an unanswered press on its tab (a new
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

  const changeDismissed = useCallback((change: (ids: string[]) => string[]) => {
    if (!uid || !feed) return;
    const ids = change(currentDismissed()).slice(-MAX_DISMISSED_PER_FEED);
    removedRef.current = { owner, ids };
    saveDismissed(uid, feed.id, ids);
    setRemoved({ owner, ids });
  }, [currentDismissed, feed, owner, uid]);

  const dismiss = useCallback((paper: Paper) => {
    changeDismissed(ids => [...ids.filter(id => id !== paper.id), paper.id]);
  }, [changeDismissed]);

  const restore = useCallback((paper: Paper) => {
    changeDismissed(ids => ids.filter(id => id !== paper.id));
  }, [changeDismissed]);

  const loadingIngredients = useMemo(() => (feed && pages ? loadingIngredientsOf(feed, pages.loading) : []), [feed, pages]);
  const loading = view.pending === 'first' || view.pending === 'more' || needsFirstPage || needsNextPage || (pressPending && !view.pages);

  return {
    papers,
    loading,
    error: view.error,
    hasMore: Boolean(pages?.hasMore),
    loadMore,
    refresh,
    isRefreshing: view.pending === 'refresh' || (pressPending && Boolean(view.pages)),
    // Not while a page is on its way, which may still bring papers to show.
    emptyKind: loading ? null : feedEmptyKind(pages && { ...pages, papers }, view.error),
    loadingIngredients,
    dismiss,
    restore,
  };
}
