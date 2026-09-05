/**
 * Which movement a route page runs, from three facts it is handed.
 *
 * The rule behind the table (spec §5): the deeper page goes on top, the other
 * stays underneath, opaque and still. Two pages never fade at the same time,
 * so there is no dip in brightness and no frame without a page painted.
 *
 * `direction` is 1 going deeper, -1 coming back, 0 when the router cannot say
 * (first entry, a replace). `lateral` is a step between two navbar tabs.
 * `present` is whether AnimatePresence still counts the page as mounted; a
 * page on its way out reads the navigation that ejects it, not the one it
 * arrived with.
 *
 *   present  lateral  direction  → motion
 *   true     false    1          → enter          rises 10px over the page it covers
 *   true     true     ±1         → enter-lateral  slides 10px along the bar
 *   true     false    -1         → rest           revealed; nothing to animate
 *   true     any      0          → rest
 *   false    true     ±1         → hold           kept opaque under the new tab
 *   false    false    1          → hold           kept opaque under the deeper page
 *   false    false    -1         → leave          drops 10px and fades, on top
 *   false    any      0          → fade           opacity only, on top
 *
 * Precedence: `present`, then `direction === 0`, then `lateral`, then the
 * sign. Out-of-range input reads as 0 / false / present.
 */
export const PAGE_MOTIONS = Object.freeze(['enter', 'enter-lateral', 'rest', 'hold', 'leave', 'fade']);

/**
 * How long a leaving page may wait for its `animationend` before handing
 * itself back to AnimatePresence anyway — a background tab, a cancelled
 * animation. Longer than every `--page-*-ms` in PageTransition.css, which
 * the stylesheet's test checks.
 */
export const EXIT_SAFETY_MS = 700;

export function pageMotionFor({ direction, lateral, present } = {}) {
  const sign = typeof direction === 'number' && Number.isFinite(direction) ? Math.sign(direction) : 0;
  const isLateral = lateral === true;
  const isPresent = present !== false;

  if (isPresent) {
    if (sign === 0) return 'rest';
    if (isLateral) return 'enter-lateral';
    return sign === 1 ? 'enter' : 'rest';
  }
  if (sign === 0) return 'fade';
  if (isLateral) return 'hold';
  return sign === 1 ? 'hold' : 'leave';
}
