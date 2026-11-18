import { PULL_YIELDING_SCROLLERS } from './feed-pull-to-refresh.ts';

/**
 * Whose key an ArrowUp or ArrowDown is when it is pressed over a feed.
 *
 * With the focus on nothing the feed takes it and goes to the next or the
 * previous paper. With the focus in a control or a field the key is left to
 * the browser, which uses it there.
 *
 * `[role="dialog"]` covers a non-modal popup over the feed, such as a
 * visitor's Privacy panel: its keys are its own, and with large text it
 * scrolls with them.
 */
const KEY_OWNERS = 'input, textarea, select, button, a, summary, [contenteditable="true"], [role="textbox"], [role="button"], [role="link"], [role="dialog"]';

type Box = { top: number; bottom: number };
/** What a key was pressed on: an Element in the page, a stand-in in the tests. */
type PageNode<Feed> = {
  matches: (selectors: string) => boolean;
  contains: (other: Feed) => boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => Box;
};
type KeyTarget<Feed> = { closest: (selectors: string) => PageNode<Feed> | null } | null;

/**
 * Whether an arrow pressed on `target` takes `feed` to another paper.
 *
 * The card's no-abstract state scrolls inside a panel too short for it
 * (paper-card.css). It holds no control, so Chrome and Firefox make the
 * scroller itself a Tab stop for the arrows to move it. While the focused
 * state can still move the way of the key, the key is the state's and the
 * browser scrolls it. At its end the key is the feed's, as a drag is
 * (`PULL_YIELDING_SCROLLERS`): left to the browser there, the key could stop
 * a pixel short of the end and then move nothing. A pixel is the rounding of
 * the scroller's heights. The key is also the feed's once the feed has left
 * the state's card, which is then out of sight.
 */
export function arrowKeyMovesFeed<Feed extends { getBoundingClientRect: () => Box }>({ target, key, feed }: {
  target: KeyTarget<Feed>;
  key: 'ArrowDown' | 'ArrowUp';
  feed: Feed;
}): boolean {
  const owner = target?.closest(KEY_OWNERS);
  // The Similar layer is a modal dialog this feed lives IN: its arrows are
  // this feed's, and the feed under it is the one that keeps still.
  if (owner && !(owner.matches('[role="dialog"]') && owner.contains(feed))) return false;
  const state = target?.closest(PULL_YIELDING_SCROLLERS);
  if (!state) return true;
  const box = state.getBoundingClientRect();
  const view = feed.getBoundingClientRect();
  if (box.bottom <= view.top || box.top >= view.bottom) return true;
  const room = key === 'ArrowDown' ? state.scrollHeight - state.clientHeight - state.scrollTop : state.scrollTop;
  return room <= 1;
}
