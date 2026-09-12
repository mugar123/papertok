/**
 * Which movement a route page runs, from three facts it is handed.
 *
 * The rule behind the table (spec §5): the deeper page goes on top and
 * travels; the page underneath recedes a little instead of sitting still, so
 * the handover reads as one sheet settling over another. Two pages never
 * fade out at the same time, so there is no dip in brightness and no frame
 * without a page painted.
 *
 * `direction` is 1 going deeper, -1 coming back, 0 when the router cannot say
 * (first entry, a replace). `lateral` is a step between two navbar tabs.
 * `present` is whether AnimatePresence still counts the page as mounted; a
 * page on its way out reads the navigation that ejects it, not the one it
 * arrived with.
 *
 *   present  lateral  direction  → motion
 *   true     false    1          → enter          rises 40px over the page it covers
 *   true     true     ±1         → enter-lateral  slides 10px along the bar
 *   true     false    -1         → reveal         back to size and brightness under the page leaving
 *   true     any      0          → rest
 *   false    true     ±1         → hold-lateral   recedes under the new tab, for as long as the tab takes
 *   false    false    1          → hold           recedes under the deeper page, for as long as it takes
 *   false    false    -1         → leave          drops 40px and fades, on top
 *   false    any      0          → fade           opacity only, on top
 *
 * Precedence: `present`, then `direction === 0`, then `lateral`, then the
 * sign. Out-of-range input reads as 0 / false / present.
 *
 * Two holds, not one, because a held page has to end in the very frame the
 * page on top settles: the arriving page drops its stacking when its own
 * animation ends, and a held page still there after that — fixed, z-index
 * 1 — paints OVER it. One `hold` timed for the longest entrance did exactly
 * that under every tab switch (measured 2026-09-06: eight frames of the For
 * you card at 60% over a Research page already at rest). The held page is
 * named for the entrance above it, and PageTransition.css times it by that
 * entrance's clock.
 */
export const PAGE_MOTIONS = Object.freeze(['enter', 'enter-lateral', 'reveal', 'rest', 'hold', 'hold-lateral', 'leave', 'fade']);

/**
 * How long a leaving page may wait for its `animationend` before handing
 * itself back to AnimatePresence anyway — a background tab, a cancelled
 * animation. Longer than every `--page-*-ms` in PageTransition.css, which
 * the stylesheet's test checks.
 */
export const EXIT_SAFETY_MS = 700;

/**
 * Whether a page running this motion is still ARRIVING — travelling into place,
 * as opposed to sitting at rest or on its way out.
 *
 * What reads this is the height settle inside the page (`useHeightSettle`, via
 * the arrival context). A settle exists to carry a piece of data that lands
 * LATE on a page the reader is already looking at; a page that is still flying
 * in has no wait to smooth over, and a second animated height under a page that
 * is itself moving is two owners of the same displacement.
 *
 * `reveal` counts. Coming back is a fresh mount — `AnimatePresence` keys on the
 * pathname, so the page stepped back to was unmounted when it was left — and
 * its data comes back from cache in bursts. Measured 2026-09-07 on an
 * institution stepped back to from one of its authors: four settles inside
 * 76ms, each restarting a full 360ms clock (302.5>287.4, 296.5>313.8,
 * 291.9>315.4, 288.8>316.8), while the reveal was still running. What a reader
 * sees is the tab strip and the papers wobbling instead of being where they
 * were left.
 *
 * The motions of a page on its way out — `leave`, `hold`, `hold-lateral`,
 * `fade` — are deliberately NOT arrivals. A settle still running on the leaving
 * page finishes: measured at 10.4px of travel on a page that is `position:
 * fixed` and cannot push anything, where cancelling it would snap to opacity
 * 0.9 in one frame instead.
 */
export function isArrivalMotion(motion) {
  return motion === 'enter' || motion === 'enter-lateral' || motion === 'reveal';
}

export function pageMotionFor({ direction, lateral, present } = {}) {
  const sign = typeof direction === 'number' && Number.isFinite(direction) ? Math.sign(direction) : 0;
  const isLateral = lateral === true;
  const isPresent = present !== false;

  if (isPresent) {
    if (sign === 0) return 'rest';
    if (isLateral) return 'enter-lateral';
    return sign === 1 ? 'enter' : 'reveal';
  }
  if (sign === 0) return 'fade';
  if (isLateral) return 'hold-lateral';
  return sign === 1 ? 'hold' : 'leave';
}
