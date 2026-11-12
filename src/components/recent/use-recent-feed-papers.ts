import type { Paper } from '../../models/paper.ts';
import { useCallback, useEffect, useMemo } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useCorpusFeedPages } from '../../hooks/use-corpus-feed-pages.ts';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { fetchCorpusPage } from '../../services/paper-store-service.ts';
import { feedResumeMemory } from '../../utils/feed-resume-memory.ts';
import { withoutNotInterested } from '../../utils/following-feed.ts';
import {
  recentPageRequest,
  recentPagesCache,
  recentPagesKey,
  recentRunFor,
  recentRunsCache,
  recentScrollKey,
  recentSeenIds,
  settleRecentPage,
  startsNewRecentList,
  type RecentRun,
} from '../../utils/recent-feed-pages.ts';

const CACHES = { pages: recentPagesCache, runs: recentRunsCache };

/**
 * The papers of Most recent, for FeedContainer's source: the reader's topics
 * ordered by the day each paper arrived, only papers they have not viewed,
 * minus the ones marked Not interested anywhere. The pages are kept for the
 * session under the account and its topics, so a return visit resumes them,
 * and new topics start the list again. A run (a first page or a refresh)
 * takes the reader's groups, rejections and exclusions when it starts; every
 * page takes what the reader viewed afresh, with what the run received.
 *
 * `hasTopics` is false only once this account's profile has loaded with no
 * interest groups: before that, no groups is not yet an answer.
 */
export function useRecentFeedPapers(): {
  papers: Paper[]; loading: boolean; error: unknown; hasMore: boolean;
  loadMore: () => boolean; refresh: () => void; isRefreshing: boolean; hasTopics: boolean;
} {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const { notInterestedIds, getInterestRunSignals, getRecommendationProfileSnapshot } = useFeed();
  const { refreshRequest } = useCustomFeeds();
  // The reader's latest press on this tab while on it.
  const press = refreshRequest?.tab === 'recent' ? refreshRequest.n : null;

  // As in useCustomFeedPapers: a run starts only once this account's profile
  // has loaded, and the snapshot's identity changes when readiness flips or
  // the topics change.
  const profile = useMemo(() => getRecommendationProfileSnapshot(), [getRecommendationProfileSnapshot]);
  const profileReady = profile.ready && profile.userId === uid;
  // Whether a new run would plan any interest group, the fact that makes
  // `recentPageRequest` ask for nothing. The signals' identity changes with
  // the topics, the snapshot's with readiness; before the profile is ready
  // the plan has no groups whatever the topics, so it is not read.
  const plansGroups = useMemo(
    () => !profile.ready || getInterestRunSignals().plan.groups.length > 0,
    [getInterestRunSignals, profile],
  );
  const hasTopics = !profileReady || plansGroups;

  // A new account or new topics start from that key's own pages; an answer
  // for the old key is dropped by the pages hook.
  const key = uid ? recentPagesKey(uid, profile.userPreferences) : null;

  const runFor = useCallback(
    (run: RecentRun | null, page: number) => recentRunFor(run, page, getInterestRunSignals()),
    [getInterestRunSignals],
  );
  // What the reader viewed is read when the page is asked for; the run's
  // plan, rejections and exclusions are the ones its first page took. Every
  // paper of the answer, shown or not, goes into the run as received.
  const ask = useCallback((run: RecentRun, page: number) => {
    const { viewedIds } = getInterestRunSignals();
    const seen = recentSeenIds(viewedIds, run.received);
    const request = recentPageRequest(run, page, seen);
    // Not reached: the pages hook asks for nothing when no group is planned.
    if (!request) return Promise.reject(new Error('Most recent has no topics to ask for.'));
    return fetchCorpusPage(request).then((answer) => {
      const { papers, hasMore, received } = settleRecentPage(answer, new Set(seen), new Set(viewedIds));
      return { papers, hasMore, run: { ...run, received: [...run.received, ...received] } };
    });
  }, [getInterestRunSignals]);
  // A paper viewed, liked or saved after it arrived stays until the next run;
  // one marked Not interested leaves at once, and comes back on Undo.
  const shown = useCallback((papers: Paper[]) => withoutNotInterested(papers, notInterestedIds), [notInterestedIds]);

  const { papers, loading, error, hasMore, loadMore, refresh, isRefreshing } = useCorpusFeedPages({
    key,
    ready: profileReady,
    press,
    asksNothing: profileReady && !plansGroups,
    runFor,
    ask,
    shown,
    caches: CACHES,
  });

  // A new list opens on its first card: the card remembered for this tab
  // after a reload is a place in a list that is gone, and the new one skips
  // the papers seen since. Forgotten as the run starts, before its first page
  // can reach FeedContainer; a list resumed from its kept pages keeps its card.
  useEffect(() => {
    if (!uid || !startsNewRecentList(key, profileReady, recentPagesCache)) return;
    const scrollKey = recentScrollKey(uid);
    feedResumeMemory.remember(scrollKey);
    feedResumeMemory.persist(scrollKey);
  }, [key, profileReady, uid]);

  return { papers, loading, error, hasMore, loadMore, refresh, isRefreshing, hasTopics };
}
