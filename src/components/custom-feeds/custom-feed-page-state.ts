import type { Paper } from '../../models/paper.ts';
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

/** What the page says when a refresh found no paper the reader had not seen. */
export const NOTHING_UNSEEN_NOTICE = { title: 'No unseen papers in this feed', description: 'Showing it from the top.' };

/**
 * What the page does as a refresh ends, and the feed whose refresh it is
 * watching. `replaced`: a refresh of this feed just ended without failing, so
 * its list may be a new one, in which the card remembered for the old one
 * names no place (`placeAfterRefresh`). `notice`: whether to show `NOTHING_UNSEEN_NOTICE`. A refresh
 * starts with the papers the reader has not seen (`walksUnseen`); one that
 * ends over papers without any shows the feed as it was, so the page says why
 * nothing changed. Neither for a refresh that failed or a feed the reader
 * left meanwhile, and no notice for a feed with no papers.
 */
export function nextRefreshEnd(
  watchedFeed: string | null,
  feedId: string,
  now: { isRefreshing: boolean; failed: boolean; hasPapers: boolean; walksUnseen: boolean },
): { watchedFeed: string | null; replaced: boolean; notice: boolean } {
  if (now.isRefreshing) return { watchedFeed: feedId, replaced: false, notice: false };
  const replaced = watchedFeed === feedId && !now.failed;
  return { watchedFeed: null, replaced, notice: replaced && now.hasPapers && !now.walksUnseen };
}

/**
 * The place to remember for a feed whose refresh just ended, or null when the
 * one remembered still names its card: the list is the same one, or a scroll
 * since already wrote the place. A place whose paper is no longer at its index
 * was remembered for the list the refresh replaced. The reader is at the same
 * position of the new one, where a refresh puts the first card unless they
 * scrolled meanwhile; past the end of a shorter list, on its last card, where
 * the browser keeps the scroll.
 */
export function placeAfterRefresh(papers: readonly Paper[], place: { scrollTop: number; index: number; paperId: string | null }): { scrollTop: number; index: number; paperId: string | null } | null {
  const onScreen = papers[place.index];
  if (onScreen?.id === place.paperId) return null;
  if (onScreen) return { ...place, paperId: onScreen.id };
  const last = Math.max(papers.length - 1, 0);
  return { scrollTop: last > 0 ? place.scrollTop : 0, index: last, paperId: papers[last]?.id ?? null };
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
