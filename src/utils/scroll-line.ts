/**
 * Geometry of a line that scrolls sideways (the navbar's feed tabs).
 *
 * Scroll positions can be fractional (zoom, high-density screens), so an edge
 * within half a pixel of the end counts as reached: a line scrolled to its end
 * must not keep a fade there for a rounding remainder.
 */
const SLACK_PX = 0.5;

/**
 * How long after its last `scroll` event the line still counts as moving. A
 * fling scrolls every frame (~16 ms), so a press within this window lands on
 * a moving line.
 */
export const LINE_SETTLE_MS = 100;

/**
 * Whether a press on a tab was a tap on a still line, and so may choose the
 * tab. A finger that touches a line still gliding from a fling is stopping it,
 * not choosing what lies under it: browsers suppress the click for that tap,
 * and it starts no new pan, so no `pointercancel` arrives either. Neither a
 * press that starts while the line moves nor one during which it moves is a tap.
 *
 * @param pressedAt          time of the press
 * @param lastScrollAt       time of the line's last `scroll` event (-Infinity if none)
 * @param scrollLeftAtPress  the line's `scrollLeft` at the press
 * @param scrollLeftAtLift   the line's `scrollLeft` when the finger lifts
 */
export function pressedStillLine({ pressedAt, lastScrollAt, scrollLeftAtPress, scrollLeftAtLift }: {
  pressedAt: number;
  lastScrollAt: number;
  scrollLeftAtPress: number;
  scrollLeftAtLift: number;
}): boolean {
  const movingAtPress = lastScrollAt > pressedAt - LINE_SETTLE_MS;
  const movedSince = lastScrollAt >= pressedAt || Math.abs(scrollLeftAtLift - scrollLeftAtPress) >= 1;
  return !movingAtPress && !movedSince;
}

/**
 * Whether a `scroll` event is the line moving under the reader's finger, for
 * the clock `pressedStillLine` reads. The line also scrolls itself, to reveal
 * the current tab after a tap, and those events are not a fling: counted,
 * they refused a deliberate second tap that came right after the reveal.
 *
 * @param revealTo    the `scrollLeft` the line's own reveal is heading for, or null when none is under way
 * @param scrollLeft  the line's `scrollLeft` at this event
 * @returns whether the event counts as the line moving, and the reveal still
 *   under way after it: it ends when the line reaches its target
 */
export function lineScrollEvent(revealTo: number | null, scrollLeft: number): { moved: boolean; revealTo: number | null } {
  if (revealTo === null) return { moved: true, revealTo: null };
  return { moved: false, revealTo: Math.abs(scrollLeft - revealTo) < 1 ? null : revealTo };
}

/** Which edges have more of the line beyond them, and so fade. */
export function fadingEdges(scrollLeft: number, scrollWidth: number, clientWidth: number): { start: boolean; end: boolean } {
  return {
    start: scrollLeft > SLACK_PX,
    end: scrollLeft + clientWidth < scrollWidth - SLACK_PX,
  };
}

/**
 * The scroll position that brings an item into view with the least movement,
 * keeping `padding` clear on the side it arrives at (the width of the fade, so
 * the item does not land under it). An item already in view keeps the
 * position; one wider than the view aligns its start.
 *
 * @param itemLeft   the item's left edge in the line's content coordinates
 * @param itemWidth  the item's width
 */
export function revealScrollLeft(itemLeft: number, itemWidth: number, scrollLeft: number, clientWidth: number, padding = 0): number {
  const start = itemLeft - padding;
  const end = itemLeft + itemWidth + padding;
  if (start < scrollLeft || end - start > clientWidth) return Math.max(0, start);
  if (end > scrollLeft + clientWidth) return end - clientWidth;
  return scrollLeft;
}
