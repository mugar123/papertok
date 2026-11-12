import type { ComponentProps } from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowsClockwise, CloudSlash, Hourglass, PencilSimple, Tray } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { toastForAccount } from '../ui/toast.ts';
import FeedContainer from '../feed/feed-container.tsx';
import { FeedRetryRefContext } from '../feed/feed-retry-context.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { useCustomFeeds } from '../../hooks/use-custom-feeds.ts';
import { ingredientLabel } from '../../utils/custom-feeds.ts';
import { customFeedPath } from '../../utils/feed-tabs.ts';
import { useCustomFeedPapers } from './use-custom-feed-papers.ts';
import { customFeedPageState, feedFirstLoadPending, gatheringSentence, nextFeedOpen, nextLoadingNotice } from './custom-feed-page-state.ts';

// Before the feed is known (the account's feeds not yet answered, or failed),
// the page still needs its landmark and heading.
const UNNAMED_LANDMARK = { label: 'Papers in your feed', heading: 'Your feed' };

/**
 * Show more papers. It takes the feed's retry ref, so while the pages load
 * the focus waits on the feed's wait, then goes where Try again's does: to
 * the first card, or back to this button when they brought nothing to show.
 */
function ShowMoreButton({ onClick }: { onClick: () => void }) {
  const retryRef = useContext(FeedRetryRefContext);
  return (
    <Button ref={retryRef} size="sm" onClick={onClick}>
      <ArrowDown size={16} aria-hidden="true" />
      {'Show more papers'}
    </Button>
  );
}

/**
 * A custom feed's page, at `/feeds/:feedId`: the shared feed with the papers
 * `useCustomFeedPapers` brings. One FeedContainer from the first wait to the
 * cards, so the feeds answering does not remount it.
 */
export default function CustomFeedPage({ onOpenPdf, onSaveToList }: Pick<ComponentProps<typeof FeedContainer>, 'onOpenPdf' | 'onSaveToList'>) {
  const { feedId } = useParams();
  const { user } = useAuth();
  const { feeds, status, openFeedEditor, retry } = useCustomFeeds();
  const pageState = customFeedPageState(status, feeds, feedId);
  const feed = pageState.kind === 'feed' ? pageState.feed : null;
  const {
    papers, loading, error, hasMore, loadMore, refresh, isRefreshing, emptyKind, loadingIngredients, dismiss, restore,
  } = useCustomFeedPapers(feed);

  const loadingNames = useMemo(() => loadingIngredients.map(ingredientLabel), [loadingIngredients]);
  // Once each time this feed starts having sources to load, not on every page.
  // The notice names the account's sources, so it leaves with the account.
  const notifiedForRef = useRef<string | null>(null);
  const shownFeedId = feed?.id ?? null;
  const uid = user?.uid ?? null;
  useEffect(() => {
    if (!shownFeedId || !uid) return;
    const { notifiedFor, notice } = nextLoadingNotice(notifiedForRef.current, shownFeedId, loadingNames);
    notifiedForRef.current = notifiedFor;
    if (notice) toastForAccount(uid, notice, { id: `custom-feed-loading:${shownFeedId}` });
  }, [shownFeedId, loadingNames, uid]);

  // Once per visit to a feed: not again as its papers reload or after an
  // edit, and again for another feed or when the reader comes back.
  const { trackEvent } = useAnalyticsConsent();
  const openedForRef = useRef<string | null>(null);
  const shownOrder = feed?.order ?? null;
  useEffect(() => {
    const { openedFor, event } = nextFeedOpen(openedForRef.current, shownFeedId && shownOrder ? { id: shownFeedId, order: shownOrder } : null);
    openedForRef.current = openedFor;
    if (event) void trackEvent('custom_feed_open', event);
  }, [shownFeedId, shownOrder, trackEvent]);

  const editFeed = useCallback(() => {
    if (shownFeedId) openFeedEditor({ feedId: shownFeedId });
  }, [openFeedEditor, shownFeedId]);

  const emptyState = useMemo(() => {
    if (pageState.kind === 'unavailable') {
      return (
        <EmptyState
          role="alert"
          icon
          art={<CloudSlash />}
          title={'Your feeds could not be loaded'}
          actions={(
            <Button size="sm" onClick={retry}>
              <ArrowsClockwise size={16} aria-hidden="true" />
              {'Try again'}
            </Button>
          )}
        >
          {'Check your connection and try again.'}
        </EmptyState>
      );
    }
    if (emptyKind === 'more') {
      // The pages the feed asked for by itself had no paper to show (the
      // reader took them out, they were retracted or the corpus dropped
      // them), and the feed has more.
      return (
        <EmptyState
          role="status"
          icon
          art={<Tray />}
          title={'Nothing to show yet'}
          actions={(
            <>
              <ShowMoreButton onClick={loadMore} />
              <Button size="sm" variant="outline" onClick={editFeed}>
                <PencilSimple size={16} aria-hidden="true" />
                {'Edit feed'}
              </Button>
            </>
          )}
        >
          {'None of the papers loaded so far can be shown, and this feed has more to load.'}
        </EmptyState>
      );
    }
    if (emptyKind === 'nothing') {
      return (
        <EmptyState
          role="status"
          icon
          art={<Tray />}
          title={'Nothing here yet'}
          actions={(
            <Button size="sm" onClick={editFeed}>
              <PencilSimple size={16} aria-hidden="true" />
              {'Edit feed'}
            </Button>
          )}
        >
          {'No papers from the last 90 days match this feed.'}
        </EmptyState>
      );
    }
    if (emptyKind === 'gathering') {
      return (
        <EmptyState
          role="status"
          icon
          art={<Hourglass />}
          title={'Gathering papers'}
          actions={(
            <Button size="sm" onClick={refresh}>
              <ArrowsClockwise size={16} aria-hidden="true" />
              {'Check again'}
            </Button>
          )}
        >
          {gatheringSentence(loadingNames)}
        </EmptyState>
      );
    }
    return null;
  }, [pageState.kind, emptyKind, loadingNames, editFeed, loadMore, refresh, retry]);

  const dismissal = useMemo(() => ({ hide: dismiss, restore, label: 'Removed from this feed', hint: 'Remove it from this feed' }), [dismiss, restore]);
  const source = useMemo(() => ({
    papers,
    loading: status === 'loading' || loading,
    initialLoadPending: feedFirstLoadPending({ status, hasPapers: papers.length > 0, emptyKind, error }),
    // Over cards too, as on Following: a failed refresh or next page is still
    // a failure the container has to know about.
    error,
    hasMore,
    loadMore,
    refresh,
    isRefreshing,
    emptyState,
    surface: 'custom_feed',
    dismissal,
  }), [papers, status, loading, emptyKind, error, hasMore, loadMore, refresh, isRefreshing, emptyState, dismissal]);

  if (pageState.kind === 'missing') return <Navigate to="/feed" replace />;

  return (
    <FeedContainer
      // The root of `/feeds/:feedId`, so it supplies the `<main>` and the `<h1>`.
      landmark={feed ? { label: `Papers in ${feed.name}`, heading: feed.name } : UNNAMED_LANDMARK}
      onOpenPdf={onOpenPdf}
      onSaveToList={onSaveToList}
      source={source}
      scrollKey={`feed:${feedId}:${user?.uid ?? ''}`}
      tabPath={feed ? customFeedPath(feed.id) : undefined}
    />
  );
}
