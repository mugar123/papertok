import type { ComponentProps, ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowsClockwise, Checks, Tray } from '@phosphor-icons/react';
import Petri from '../onboarding/petri.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import FeedContainer from '../feed/feed-container.tsx';
import { FeedRetryRefContext } from '../feed/feed-retry-context.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { ACCOUNT_DISMISSAL_HINT } from '../../utils/feed-dismissal.ts';
import { recentScrollKey } from '../../utils/recent-feed-pages.ts';
import { recentCheckStatus, recentEmptyKind, settleRecentCheck, type RecentCheck } from './recent-feed-page-state.ts';
import { useRecentFeedPapers } from './use-recent-feed-papers.ts';

const CAUGHT_UP_TITLE = "You're all caught up";
const CAUGHT_UP_BODY = 'You have seen the newest papers in your topics. New ones arrive every day.';

const goToForYou = <Button size="sm" role="link" render={<Link to="/feed" />}>{'Go to For you'}</Button>;

// The end of a list that had cards: nothing unseen is left.
const END_CARD = (
  <EmptyState icon art={<Checks />} title={CAUGHT_UP_TITLE} actions={goToForYou}>
    {CAUGHT_UP_BODY}
  </EmptyState>
);

/**
 * Check again or Show older papers, busy while its check runs and still
 * focusable. It takes the feed's retry ref, so when the check brings papers
 * or fails, its focus goes where Try again's does: to the first card, or to
 * the error's Try again.
 */
function CheckButton({ checking, onClick, children }: { checking: boolean; onClick: () => void; children: ReactNode }) {
  const retryRef = useContext(FeedRetryRefContext);
  return (
    <Button
      ref={retryRef}
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={checking}
      focusableWhenDisabled
      aria-busy={checking || undefined}
    >
      {children}
    </Button>
  );
}

/**
 * Most recent, at `/recent`: the shared feed with the reader's topics ordered
 * by the day each paper arrived, only the papers they have not viewed
 * (`useRecentFeedPapers`).
 */
export default function RecentFeedPage({ onOpenPdf, onSaveToList }: Pick<ComponentProps<typeof FeedContainer>, 'onOpenPdf' | 'onSaveToList'>) {
  const { user } = useAuth();
  const { markNotInterested, undoNotInterested } = useFeed();
  const { papers, loading, error, hasMore, loadMore, refresh, isRefreshing, hasTopics } = useRecentFeedPapers();

  // Check again's and Show older papers' loads run under the empty state, with
  // the button busy and still holding the focus, instead of the feed's wait,
  // which would take the button out of the page and drop its focus to the
  // body. The result is said in the state's own status (recentCheckStatus).
  const [check, setCheck] = useState<RecentCheck>('idle');
  const settledCheck = settleRecentCheck(check, { busy: loading || isRefreshing, hasPapers: papers.length > 0, error });
  if (settledCheck !== check) setCheck(settledCheck);
  const checking = settledCheck === 'asked' || settledCheck === 'asked-older';
  const checkAgain = useCallback(() => {
    setCheck('asked');
    refresh();
  }, [refresh]);
  // The same run goes on after the pages it stopped at. Check again would
  // start from the newest papers and bring the same ones again.
  const showOlder = useCallback(() => {
    if (loadMore()) setCheck('asked-older');
  }, [loadMore]);

  // Any other load counts as loading here: it may bring papers, so the list
  // is not called caught up while it is on its way.
  const emptyKind = recentEmptyKind({ hasTopics, hasPapers: papers.length > 0, hasMore, loading: !checking && (loading || isRefreshing), error });
  const checkStatus = recentCheckStatus(settledCheck);

  const emptyState = useMemo(() => {
    if (emptyKind === 'no-topics') {
      return (
        <EmptyState
          role="status"
          art={<Petri pose="flask" className="feed-error-petri" />}
          title={'No topics yet'}
          actions={<Button size="sm" role="link" render={<Link to="/settings/discovery" />}>{'Open Settings'}</Button>}
        >
          {'Pick the topics you read in Settings.'}
        </EmptyState>
      );
    }
    if (emptyKind === 'caught-up') {
      return (
        <EmptyState
          role="status"
          icon
          art={<Checks />}
          title={CAUGHT_UP_TITLE}
          actions={(
            <>
              {goToForYou}
              <CheckButton checking={checking} onClick={checkAgain}>
                <ArrowsClockwise size={16} aria-hidden="true" />
                {'Check again'}
              </CheckButton>
            </>
          )}
        >
          {/* Its own text node, so the status speaks the change alone. */}
          {CAUGHT_UP_BODY}
          {checkStatus ? ` ${checkStatus}` : null}
        </EmptyState>
      );
    }
    if (emptyKind === 'more') {
      // The list stopped asking by itself (MAX_EMPTY_AUTO_PAGES) before its end.
      return (
        <EmptyState
          role="status"
          icon
          art={<Tray />}
          title={'Nothing new so far'}
          actions={(
            <>
              {goToForYou}
              <CheckButton checking={checking} onClick={showOlder}>
                <ArrowDown size={16} aria-hidden="true" />
                {'Show older papers'}
              </CheckButton>
            </>
          )}
        >
          {'The latest papers in your topics are ones you viewed or marked Not interested. Older ones may still be new to you.'}
          {checkStatus ? ` ${checkStatus}` : null}
        </EmptyState>
      );
    }
    // A failure with no cards is the container's error state, with Try again.
    return null;
  }, [checkAgain, checkStatus, checking, emptyKind, showOlder]);

  // The account's Not interested, shown on this page. Undo passes no place:
  // with one, the paper would go back into For you's own list.
  const dismissal = useMemo(() => ({
    hide: (paper: Paper) => { void markNotInterested(paper); },
    restore: (paper: Paper) => { void undoNotInterested(paper); },
    label: 'Marked as not interested',
    hint: ACCOUNT_DISMISSAL_HINT,
  }), [markNotInterested, undoNotInterested]);

  const source = useMemo(() => ({
    papers,
    // A check's load is not the feed's: the container would replace the empty
    // state with its wait.
    loading: loading && !checking,
    // The first wait is the feeds' discovery screen, until the first page
    // brings papers, an empty verdict or an error. A refresh from an empty
    // list is not a first load: the container shows its own wait for it.
    initialLoadPending: !papers.length && emptyKind === null && !error && !isRefreshing,
    // Over cards too, as on Following: a failed refresh or next page is still
    // a failure the container has to know about.
    error,
    hasMore,
    loadMore,
    refresh,
    isRefreshing: isRefreshing && !checking,
    emptyState,
    endCard: END_CARD,
    surface: 'recent',
    dismissal,
  }), [papers, loading, checking, emptyKind, error, hasMore, loadMore, refresh, isRefreshing, emptyState, dismissal]);

  return (
    <FeedContainer
      // The root of `/recent`, so it supplies the `<main>` and the `<h1>`.
      landmark={{ label: 'Most recent papers in your topics', heading: 'Most recent' }}
      onOpenPdf={onOpenPdf}
      onSaveToList={onSaveToList}
      source={source}
      scrollKey={recentScrollKey(user?.uid ?? '')}
      tabPath="/recent"
    />
  );
}
