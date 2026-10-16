/**
 * How far to scroll a list so that one of its items can be read: nothing when
 * it already can, down to its top when it sits above the view or is taller
 * than the view, and up just far enough to show its bottom otherwise — a card
 * that fits comes into view whole, a card that does not starts at its first
 * line. Both rects are viewport boxes, as `getBoundingClientRect()` gives them;
 * the answer is a `scrollTop` delta.
 */
export function revealScrollDelta(view, item) {
  if (item.top < view.top) return item.top - view.top;
  if (item.bottom > view.bottom) return Math.min(item.bottom - view.bottom, item.top - view.top);
  return 0;
}
