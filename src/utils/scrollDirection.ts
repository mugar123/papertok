/**
 * Which way the reader is going, and therefore whether the bar is in the way.
 *
 * Hides going down and comes back going up — deliberately NOT on "stopped".
 * Real reading is mostly stillness, so returning on stillness would leave the
 * bar up almost always and turn the whole behaviour into motion for nothing.
 *
 * The threshold is what separates intent from tremor: a finger resting on a
 * scrolling surface moves a few pixels either way, and without it the bar
 * would flicker on every one of them.
 */
export function nextBarVisibility({ previousTop, currentTop, visible, threshold = 8 }) {
  const delta = currentTop - previousTop;
  // The top of the document always shows the bar: a reader who has scrolled
  // back to the title is not reading, and this is the cheapest way back for
  // someone who has not worked out that scrolling up returns it.
  if (currentTop <= 0) return true;
  if (Math.abs(delta) < threshold) return visible;
  return delta < 0;
}
