/**
 * A bottom sheet dragged by its header.
 *
 * Two functions, both arithmetic, both kept out of the component so they can be
 * held to a test: where the sheet sits while the finger is down, and which state
 * it belongs to when the finger lifts.
 *
 * The second one is where sheets go wrong. Judged on distance alone, a fast
 * flick — the gesture people actually make — travels thirty pixels and does
 * nothing, so the sheet feels stuck. Judged on velocity alone, a slow
 * deliberate pull most of the way across does nothing either. It takes both,
 * and the flick needs a floor of its own or a tap with a few pixels of tremor
 * throws the sheet open.
 *
 * Everything here is in the DOM's terms: `deltaY` and `velocity` are positive
 * downwards, and `travel` is the distance between the two resting states — the
 * sheet's height less the peek it is left peeking by.
 */

/**
 * Movement under this is a tap, not a drag. Shared with the component, which
 * uses the same number to decide whether to let the click through: below it the
 * header is still a button, and tapping it still toggles.
 */
export const SHEET_DRAG_SLOP = 8;

/** How far across it has to be pulled to settle on the far side by distance. */
const SETTLE_DISTANCE_RATIO = 0.25;

/** And how fast it has to be moving to settle there without going that far. */
const FLICK_VELOCITY = 0.4;

/**
 * Where the sheet sits mid-drag, clamped so it cannot be pulled past either
 * resting state. Without the clamp a sheet can be dragged off the top of the
 * screen, which reads as a broken sheet rather than a stiff one.
 */
export function sheetDragOffset({ expanded, deltaY, travel }) {
  const span = Math.max(0, travel);
  const base = expanded ? 0 : span;
  return Math.min(span, Math.max(0, base + deltaY));
}

/**
 * The state the sheet lands in — not whether to toggle, because the caller has
 * to set a state either way and an answer phrased as "flip it" makes the caller
 * do this reasoning a second time.
 */
export function shouldSettleOpen({ expanded, deltaY, travel, velocity = 0 }) {
  const span = Math.max(0, travel);
  // Measured before layout, or a sheet shorter than its own peek: there is no
  // gesture to read, and guessing would move it for no reason.
  if (span <= 0) return expanded;

  // Both restated as "towards the state it is not in", so open and closed are
  // one case instead of two mirrored ones.
  const towards = expanded ? deltaY : -deltaY;
  const speed = expanded ? velocity : -velocity;

  const pulledFarEnough = towards >= span * SETTLE_DISTANCE_RATIO;
  const flicked = speed >= FLICK_VELOCITY && towards >= SHEET_DRAG_SLOP;

  return pulledFarEnough || flicked ? !expanded : expanded;
}
