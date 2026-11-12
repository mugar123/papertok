import type { CustomFeedsValue } from '../../context/custom-feeds-context.ts';
import type { CustomFeed } from '../../utils/custom-feeds.ts';

/**
 * What a feed's address shows: a wait while the account's feeds have not
 * answered, a failure when they could not be read, nothing (a redirect) when
 * the account has no feed with that id, and otherwise the feed.
 */
export function customFeedPageState(
  status: CustomFeedsValue['status'],
  feeds: readonly CustomFeed[],
  feedId: string | undefined,
): { kind: 'loading' | 'unavailable' | 'missing' } | { kind: 'feed'; feed: CustomFeed } {
  if (status === 'loading') return { kind: 'loading' };
  if (status === 'unavailable') return { kind: 'unavailable' };
  const feed = feeds.find(candidate => candidate.id === feedId);
  return feed ? { kind: 'feed', feed } : { kind: 'missing' };
}

/**
 * Whether the page is still on its first load: the feeds have not answered,
 * or the feed's first page has not come back with papers, an empty verdict or
 * an error. Feeds that could not be read are a failure, not a wait.
 */
export function feedFirstLoadPending({ status, hasPapers, emptyKind, error }: {
  status: CustomFeedsValue['status'];
  hasPapers: boolean;
  emptyKind: string | null;
  error: unknown;
}): boolean {
  if (status !== 'ready') return status === 'loading';
  return !hasPapers && emptyKind === null && !error;
}

const NAMES = new Intl.ListFormat('en-US', { type: 'conjunction' });
const ARRIVAL = 'New sources usually arrive within a few minutes, or overnight when many are added at once.';

/** The sentence saying which of the feed's sources are still loading, or null when none is. */
export function loadingNotice(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const verb = names.length === 1 ? 'is' : 'are';
  return `${NAMES.format(names)} ${verb} still loading. ${ARRIVAL}`;
}

/** The body of the feed's "Gathering papers" state, also when no loading source could be named. */
export function gatheringSentence(names: readonly string[]): string {
  return loadingNotice(names) ?? `This feed's sources are still loading. ${ARRIVAL}`;
}

/**
 * The loading notice to show now, if any, and the feed it has been shown for.
 * It is shown when a feed starts having sources to load (on arrival, or after
 * everything had arrived), not again while that feed is still loading.
 */
export function nextLoadingNotice(
  notifiedFor: string | null,
  feedId: string,
  names: readonly string[],
): { notifiedFor: string | null; notice: string | null } {
  if (names.length === 0) return { notifiedFor: null, notice: null };
  if (notifiedFor === feedId) return { notifiedFor, notice: null };
  return { notifiedFor: feedId, notice: loadingNotice(names) };
}

/**
 * The `custom_feed_open` event to send now, if any, and the feed this visit
 * has been recorded for: once when the page first shows a feed, and again
 * only when it shows another one.
 */
export function nextFeedOpen(
  openedFor: string | null,
  feed: Pick<CustomFeed, 'id' | 'order'> | null,
): { openedFor: string | null; event: { feed_order: CustomFeed['order'] } | null } {
  if (!feed || feed.id === openedFor) return { openedFor, event: null };
  return { openedFor: feed.id, event: { feed_order: feed.order } };
}
