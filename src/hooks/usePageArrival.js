import { createContext, useContext } from 'react';

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
