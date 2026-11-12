import type { Paper } from '../../models/paper.ts';
import type { CustomFeed, FeedIngredient } from '../../utils/custom-feeds.ts';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useCorpusFeedPages } from '../../hooks/use-corpus-feed-pages.ts';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { fetchCorpusPage } from '../../services/paper-store-service.ts';
import { changeDismissed, readDismissed, subscribeDismissed } from '../../utils/custom-feed-dismissed.ts';
import {
  customFeedPagesCache,
  customFeedRunsCache,
  feedPageOf,
  feedPageRequest,
  feedPagesKey,
  feedRunSignals,
  loadingIngredientsOf,
  type FeedRunSignals,
} from '../../utils/custom-feed-pages.ts';
import { customFeedTabKey } from '../../utils/feed-tabs.ts';
import { withoutNotInterested } from '../../utils/following-feed.ts';

const NO_IDS: string[] = [];
const NO_SIGNALS: FeedRunSignals = { positiveIds: NO_IDS, excludedIds: NO_IDS };
const CACHES = { pages: customFeedPagesCache, runs: customFeedRunsCache };

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
  emptyKind: 'more' | 'gathering' | 'nothing' | 'error' | null; loadingIngredients: FeedIngredient[];
  dismiss: (paper: Paper) => void; restore: (paper: Paper) => void;
} {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { notInterestedIds, getPositiveExampleIds, getRecommendationProfileSnapshot } = useFeed();
  const { refreshRequest } = useCustomFeeds();
  // The reader's latest press on this feed's tab while on it.
  const press = refreshRequest && feed && refreshRequest.tab === customFeedTabKey(feed.id) ? refreshRequest.n : null;

  // A run starts only once this account's profile has loaded, so it never
  // locks in the empty examples the profile holds before. The snapshot's
  // identity changes when readiness flips. Readiness always comes: FeedProvider
  // marks the profile ready in a `finally` once its read answers, fails or
  // runs out of INTERACTIONS_NETWORK_TIMEOUT_MS (5 s; `loadInteractions` in
  // feed-context.tsx), and a profile that never arrives leaves the examples
  // empty, which is then what the run starts with.
  const profile = useMemo(() => getRecommendationProfileSnapshot(), [getRecommendationProfileSnapshot]);
  const profileReady = profile.ready && profile.userId === uid;

  // A new account, feed, ingredient or order starts from that key's own pages.
  const key = uid && feed ? feedPagesKey(uid, feed) : null;
  const asksNothing = feed !== null && feedPageRequest(feed, NO_SIGNALS, 0) === null;

  // The papers removed from this feed as they are now: an Undo whose toast
  // outlived an earlier visit changes what this visit shows too.
  const feedId = feed?.id;
  const subscribe = useCallback(
    (onChange: () => void) => (uid && feedId ? subscribeDismissed(uid, feedId, onChange) : () => undefined),
    [feedId, uid],
  );
  // Stable, so a render that changed nothing does not read storage again after it commits.
  const readRemoved = useCallback(() => storedDismissed(uid, feedId), [feedId, uid]);
  const dismissed = useSyncExternalStore(subscribe, readRemoved);

  // A run's signals are taken from the reader's newest examples and the
  // feed's removed papers when its first page is asked for.
  const runFor = useCallback(
    (run: FeedRunSignals | null, page: number) => feedRunSignals(run, page, { positiveIds: getPositiveExampleIds(), dismissed: storedDismissed(uid, feedId) }),
    [feedId, getPositiveExampleIds, uid],
  );
  const ask = useCallback((signals: FeedRunSignals, page: number) => {
    const request = feed && feedPageRequest(feed, signals, page);
    // Not reached: the pages hook asks for nothing without a key (no feed) or when the feed asks for nothing.
    if (!request) return Promise.reject(new Error('The feed names nothing the corpus can serve.'));
    return fetchCorpusPage(request).then(feedPageOf);
  }, [feed]);
  const shown = useCallback((papers: Paper[]) => {
    const kept = withoutNotInterested(papers, notInterestedIds);
    if (!dismissed.length) return kept;
    const gone = new Set(dismissed);
    return kept.filter(paper => !gone.has(paper.id));
  }, [notInterestedIds, dismissed]);

  const { pages, ...list } = useCorpusFeedPages({ key, ready: profileReady, press, asksNothing, runFor, ask, shown, caches: CACHES });

  const dismiss = useCallback((paper: Paper) => {
    if (uid && feedId) changeDismissed(uid, feedId, ids => [...ids.filter(id => id !== paper.id), paper.id]);
  }, [feedId, uid]);

  const restore = useCallback((paper: Paper) => {
    if (uid && feedId) changeDismissed(uid, feedId, ids => ids.filter(id => id !== paper.id));
  }, [feedId, uid]);

  const loadingIngredients = useMemo(() => (feed && pages ? loadingIngredientsOf(feed, pages.loading) : []), [feed, pages]);

  return { ...list, loadingIngredients, dismiss, restore };
}
