/**
 * When a downward drag on the feed means "bring me new papers".
 *
 * Pull-to-refresh is touch only and reads two moments: where the finger went
 * down, and how far it had travelled when it came up. Neither calls
 * `preventDefault`, so native scrolling and the CSS scroll-snap are
 * untouched — which is also why the decision has to be made from the event
 * alone, with no measurement of its own.
 *
 * Pure functions rather than two closures inside `FeedContainer`: the refusal
 * below is the whole reason a reader does not lose their place, and a React
 * component this repo cannot mount under node is no place to keep it.
 */

/** How far down the finger must travel before the feed is replaced. */
export const PULL_REFRESH_THRESHOLD_PX = 90;

/**
 * Descendants of the feed that answer a downward drag THEMSELVES, so a pull
 * that starts inside one is not a pull on the feed.
 *
 * `.pc-abstract--open` is the whole list, and it is a real touch scroller:
 * `overflow-y: auto` (PaperCard.css) on a box that is a DOM descendant of
 * `.feed-container`, so its touch events bubble straight into the feed's
 * handlers. `overscroll-behavior: contain` beside it stops a flick that
 * reaches the end of the abstract from CHAINING into the feed; it does
 * nothing whatever to event propagation. Without this refusal, a reader on
 * the first card who expanded the abstract, read down and then dragged back
 * to the first line lifted their finger on `dy > 90` with the feed still at
 * `scrollTop === 0` — and the paper they were reading was replaced by a
 * randomised feed, with no indicator and no undo.
 *
 * What is deliberately NOT in this list, from a sweep of every
 * `overflow*: auto|scroll` inside the card's subtree:
 *   - `.pc-topics` and `.pc-linked-resources-list` scroll horizontally only
 *     (`overflow-x: auto`). A downward drag is never theirs to answer, so
 *     refusing it there would only cost the reader a working pull.
 *   - `.related-list` and `.pc-authors-modal-list` DO scroll vertically, but
 *     both are rendered through a Base UI portal (`Drawer`/`Dialog`), so
 *     neither is a descendant of `.feed-container` and neither one's touches
 *     ever reach these handlers.
 *   - the side-rail buttons, and every other still element on the card: at
 *     `scrollTop === 0` a downward drag on them IS the pull gesture, and
 *     the reader has nowhere else to put their thumb.
 *
 * A `closest()` against a fixed selector is what this costs: one call, no
 * layout and no style reads. The general form — walk the ancestors asking
 * whether each can scroll vertically — needs `getComputedStyle` and
 * `scrollHeight` per ancestor on every touchstart, and it MISFIRES on the
 * card's commonest surface: a COLLAPSED `.pc-abstract` clips its text under
 * a `max-height`, so `scrollHeight > clientHeight` is true there while
 * nothing scrolls at all. `feedPullToRefresh.test.js` re-greps PaperCard.css
 * so a vertical scroller added to the card cannot quietly slip past this.
 */
export const PULL_BLOCKING_SCROLLERS = '.pc-abstract--open';

/**
 * Where a pull starts, or `null` when this touch is not a pull: it began
 * somewhere other than the very top of the feed, or inside a scroller of the
 * card's own. `target?.closest` rather than an `instanceof Element` test —
 * the capability is what this needs, and it is what makes the refusal
 * testable outside a browser.
 */
export function pullStartFrom({ target, scrollTop, clientY }) {
  if (scrollTop !== 0) return null;
  if (typeof target?.closest === 'function' && target.closest(PULL_BLOCKING_SCROLLERS)) return null;
  return clientY;
}

/** Whether a pull that started at `startY` and ended at `endY` asks for a refresh. */
export function isPullRefresh({ startY, endY }) {
  if (typeof startY !== 'number') return false;
  return endY - startY > PULL_REFRESH_THRESHOLD_PX;
}
