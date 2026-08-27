/**
 * Which way a route change is going.
 *
 * The page transition slid the same way whichever direction you were
 * travelling: opening an author and pressing back out of it both moved the page
 * left to right, so returning felt like arriving somewhere new rather than
 * retracing a step.
 *
 * The router already answers this. `useNavigationType()` reports POP for a step
 * backwards through history — which is what the Explorer's back arrow produces,
 * since `handleBack` calls `navigate(-1)` whenever there is history behind it —
 * and PUSH for a new entry. Deriving it from the router rather than from
 * remembered paths means nothing has to hold state across a navigation, which
 * matters here because `App` keys `<Routes>` on the pathname and every page
 * component is destroyed and remade on the way through.
 */

/** 1 going deeper, -1 coming back, 0 when there is nothing to claim. */
export function directionForNavigationType(navigationType) {
  if (navigationType === 'POP') return -1;
  if (navigationType === 'PUSH') return 1;
  // REPLACE swaps the current entry for another: same place, different content,
  // so there is no step to animate. A redirect should cross-fade, not slide.
  return 0;
}
