import { createContext, useCallback, useContext } from 'react';

/**
 * Whether the route page around this subtree is still travelling into place.
 *
 * `PageTransition` puts a FUNCTION here, not a flag, and the difference is the
 * whole point: asked at the moment of a commit it reads the page root's own
 * `data-page-motion` and its running animations, so the answer is the truth
 * right now. A boolean derived from React state was measured answering "still
 * arriving" for 38ms after the page had visually stopped — `animationend` had
 * fired but its `setState` had not been committed — and a 115.8px handover that
 * landed in that window was snapped instead of settled.
 *
 * It exists for one consumer so far — the entity hero's `useHeightSettle` — and
 * for one rule: **one owner per displacement**. A height settle smooths a piece
 * of data that lands late on a page at rest. While the page itself is moving
 * there is no wait to smooth, and a settle there is a second animation of the
 * same content on a different clock. Measured 2026-09-07, stepping back from an
 * author to the institution it was opened from: four settles inside 76ms, each
 * restarting a full 360ms clock under a reveal that was still running.
 *
 * `enabled: false` on the settle keeps its memory of the box up to date without
 * animating, so the first datum that lands after the page comes to rest settles
 * from the right height — the page snaps into shape while it flies in, and
 * animates from then on.
 *
 * It lives in its own module, with no component and no JSX, for the reason
 * `contextIdentity.test.js` enforces: a `createContext()` sharing a module with
 * a component is re-created by Fast Refresh, and consumers holding the previous
 * object silently read the default.
 */
const NOT_ARRIVING = () => false;

const PageArrivalContext = createContext(NOT_ARRIVING);

export const PageArrivalProvider = PageArrivalContext.Provider;

/**
 * Returns a stable predicate: call it to ask whether the page around this
 * component is, at this instant, still animating into place. Outside a
 * `PageTransition` it always answers no.
 */
export function useIsPageArriving() {
  return useContext(PageArrivalContext);
}

/**
 * A promise that settles once this page has finished arriving, or `null` when
 * it is not arriving at all — so a caller with nothing to wait for keeps its
 * synchronous path and costs no frame.
 *
 * `useIsPageArriving` answers about THIS instant, which is what a component
 * committing right now needs. This is for the other shape: work already in
 * flight, whose RESULT must not land on the frames the page is travelling on.
 * Measured 2026-09-11, For you -> Research, production build, real session —
 * tasks over 8ms from the click:
 *
 *   +  0ms  42.6ms  the navigation commit
 *   +127ms  46.8ms  FunctionCall 25, FunctionCall 22, Layout 18
 *
 * and the frame sampler saw the matching holes: no frame from 130 to 163ms,
 * none from 163 to 214ms, both while BOTH pages were still animating. The
 * reverse trip had no hole at all. That is the freeze a reader reports as "it
 * sticks for a moment": the page laying itself out on top of its own arrival.
 *
 * Polled per frame rather than hung off `animationend`, for the same reason
 * `PageTransition` asks the DOM instead of trusting a flag: the answer has to
 * be about the frame being committed. The cap is the backstop for an animation
 * that never ends (a backgrounded tab) and outlasts every duration in
 * PageTransition.css.
 */
const ARRIVAL_WAIT_CAP_MS = 600;

export function useAfterPageArrival() {
  const isArriving = useIsPageArriving();
  return useCallback(() => {
    if (!isArriving()) return null;
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const tick = () => {
        if (!isArriving() || performance.now() - startedAt > ARRIVAL_WAIT_CAP_MS) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, [isArriving]);
}
