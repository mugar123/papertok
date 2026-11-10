import { useMemo } from 'react';
import { allFeedTabs, type FeedTabEntry } from '../utils/feed-tabs.ts';
import { useCustomFeeds } from './use-custom-feeds.ts';

export function useFeedTabs(): FeedTabEntry[] {
  const { feeds } = useCustomFeeds();
  return useMemo(() => allFeedTabs(feeds), [feeds]);
}
