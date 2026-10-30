import type { ComponentProps } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { WaitRetry } from '../../hooks/use-wait-focus.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Checks, MagnifyingGlass } from '@phosphor-icons/react';
import Petri from '../onboarding/petri.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { emptyStateDescription } from '../ui/empty-state-text.ts';
import FeedContainer from '../feed/feed-container.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { useFollowingUpdates } from '../../context/following-updates-context.tsx';
import { FOLLOWING_ORDER_STORAGE_KEY } from '../../utils/following-order-storage.ts';
import {
  followingFirstLoadPending,
  mergeOrderedPapers,
  orderFollowingFeedPapers,
  orderKeysOf,
  resumeOrderedPapers,
  withoutNotInterested,
} from '../../utils/following-feed.ts';
import './following-feed-page.css';

// The order the page left with, as keys, in the tab's own storage: a reload
// of the tab (which it gives itself after a deploy, see main.jsx) keeps the
// items in localStorage but loses `lastOrder` below with the module, and a
// fresh ranking then moved the card the reader was on. sessionStorage, so a
// new tab still ranks afresh — and a reload the READER asked for clears it,
// which `utils/app-reload.ts` does before this module ever reads it.
const ORDER_STORAGE_KEY = FOLLOWING_ORDER_STORAGE_KEY;

function readStoredOrderKeys() {
  try {
    const keys = JSON.parse(sessionStorage.getItem(ORDER_STORAGE_KEY) || 'null');
    return Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function writeStoredOrderKeys(keys: string[]) {
  try {
    if (keys.length) sessionStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(keys));
    else sessionStorage.removeItem(ORDER_STORAGE_KEY);
  } catch {
    // A full or locked storage means the order lives only until the reload.
  }
}

/**
 * The Following feed: the same experience as For You (vertical cards, gestures,
 * actions, AI explanation) fed EXCLUSIVELY with papers proven to belong to a
 * followed author, topic, institution or project. Content selection lives in
 * followingUpdatesService (stable-id matching, dedupe across entities); this
 * page applies one relevance-and-diversity ranking across every follow and
 * hands it to the shared container, so no feed mechanics are duplicated.
 */
// The order the page left with, for the next mount to resume — module scope,
// because the page is remounted on every visit and the feed the reader left
// must be the feed they come back to (`resumeOrderedPapers`).
const lastOrder: { items: Paper[] | null; ordered: Paper[]; orderKeys?: string[] } = { items: null, ordered: [] };
lastOrder.orderKeys = readStoredOrderKeys();

export default function FollowingFeedPage({ onOpenPdf, onSaveToList }: Pick<ComponentProps<typeof FeedContainer>, 'onOpenPdf' | 'onSaveToList'>) {
  const navigate = useNavigate();
  const { followedEntities } = useFollowing();
  // Skip writes into this set (`markNotInterested`), and For You gets its
  // effect for free because that same call drops the paper from the list it
  // renders. This page renders its own, so it has to read the set itself.
  const { notInterestedIds } = useFeed();
  const { items, seenIds, loading, refreshing, error, lastUpdatedAt, refresh, markSeen } = useFollowingUpdates();

  // Ranked on the first render, not in an effect after it: the state used to
  // start empty and be filled by an effect, so the page's first paint was the
  // "nothing new from what you follow" state for a frame, and the cards then
  // replaced it — the first of the pops the reader saw on entering.
  //
  // And resumed, not re-ranked: the order the reader left is the order they
  // come back to (`resumeOrderedPapers`), so the card they were on is still
  // where they left it and the container can scroll back to it. Ranking
  // captures the seen-set only when the item list itself changes: marking
  // cards as seen mid-scroll must never reshuffle under the thumb. A refresh
  // that lands while the cards are on screen keeps their order
  // (`mergeOrderedPapers`) and appends what is new.
  const [orderedPapers, setOrderedPapers] = useState(() => resumeOrderedPapers(lastOrder, items, seenIds));
  const lastItemsRef = useRef(items);
  useEffect(() => {
    if (lastItemsRef.current === items) return;
    lastItemsRef.current = items;
    setOrderedPapers(current => mergeOrderedPapers(current, orderFollowingFeedPapers(items, seenIds)));
  }, [items, seenIds]);
  useEffect(() => {
    lastOrder.items = items;
    lastOrder.ordered = orderedPapers;
    writeStoredOrderKeys(orderKeysOf(orderedPapers));
  }, [items, orderedPapers]);

  // What the reader actually sees: the ranked order minus what they skipped.
  // Derived rather than removed from `orderedPapers`, so the ranking stays the
  // one the page stores and resumes, and so a skip that arrives from anywhere
  // — this feed, For You, a paper page — takes the card out of here too.
  const shownPapers = useMemo(
    () => withoutNotInterested(orderedPapers, notInterestedIds),
    [orderedPapers, notInterestedIds],
  );

  const hasFollows = followedEntities.length > 0;

  const emptyState = useCallback((retry: WaitRetry) => hasFollows ? (
    <EmptyState
      textId={retry.textId}
      role="status"
      icon
      art={<Checks />}
      title={'No new publications from what you follow'}
      actions={(
        <button ref={retry.ref} aria-describedby={emptyStateDescription(retry.textId)} className="feed-retry-btn" onClick={() => { void refresh(); }}>
          {'Check for updates'}
        </button>
      )}
    >
      {'This feed collects recent work from what you follow and will update when new papers appear.'}
    </EmptyState>
  ) : (
    <EmptyState
      role="status"
      art={<Petri pose="bell" className="following-petri" />}
      title={"You're not following anything yet"}
      actions={(
        <>
          <button className="feed-retry-btn" onClick={() => { void navigate('/feed'); }}>
            {'Discover papers'}
          </button>
          <button className="feed-retry-btn ff-empty-secondary" onClick={() => { void navigate('/search'); }}>
            <MagnifyingGlass size={15} aria-hidden="true" /> {'Search entities'}
          </button>
        </>
      )}
    >
      {'Follow anything from a paper or its page and its publications will appear here.'}
    </EmptyState>
  ), [hasFollows, navigate, refresh]);

  const source = useMemo(() => ({
    papers: shownPapers,
    loading,
    // The first wait is For You's discovery screen, not a skeleton card: the
    // container reads this instead of guessing from `loading`, which is false
    // for the tick before the first refresh starts.
    initialLoadPending: followingFirstLoadPending({ items, loading, lastUpdatedAt, error }),
    error: error && shownPapers.length === 0 ? 'FOLLOWING_LOAD_FAILED' : null,
    hasMore: false,
    loadMore: () => {},
    refresh,
    isRefreshing: refreshing,
    emptyState,
    onPaperViewed: markSeen,
  }), [shownPapers, items, loading, lastUpdatedAt, error, refresh, refreshing, emptyState, markSeen]);

  return (
    <FeedContainer
      // This page is the root of `/following`, so it is the one that supplies
      // the `<main>` and the `<h1>`. Without this the route had neither:
      // `/feed` gets them from app.tsx, and Following lost both along the
      // way.
      landmark={{
        label: 'Papers from what you follow',
        heading: 'Following',
      }}
      onOpenPdf={onOpenPdf}
      onSaveToList={onSaveToList}
      source={source}
      scrollKey="following"
    />
  );
}
