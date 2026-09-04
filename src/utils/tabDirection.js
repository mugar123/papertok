/**
 * Which way the navbar's tabs sit relative to each other.
 *
 * The three tabs are siblings: none is inside another, so a switch between them
 * is a step sideways, not a descent. History cannot tell us which way — every
 * tab press is a push, so `directionForHistoryIndex` returns 1 going to
 * Following AND 1 coming back from it. Measured on the tab bar before this:
 * `data-nav-direction` was 1 in both directions, the incoming page always
 * entered from +18px and the outgoing always left towards -10.8px, so pressing
 * back to a tab you had just left looked like arriving somewhere new.
 *
 * The bar's own order is the only thing that knows which way is which, and the
 * underline in `utils/navRule.js` already moves along it.
 */

/** In the order `Navbar.jsx` renders them. */
export const TAB_ORDER = ['/', '/research', '/following'];

/**
 * The last tab we were on, module scope for the same reason `routeDirection`'s
 * memory is: `App` keys `<Routes>` on the pathname, so every page component is
 * destroyed and remade on the way through and cannot remember anything itself.
 */
const tabMemory = {};

/** `/following/` and `/following` are the same tab; `/` is not `''`. */
function normalize(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return null;
  const trimmed = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * `1` moving right along the bar, `-1` moving left, `null` when this is not a
 * tab-to-tab move at all — in which case the caller keeps the history-based
 * direction it already had.
 *
 * Like `directionForHistoryIndex`, this remembers the answer it gave for the
 * current tab and repeats it. One navigation renders `PageTransition` several
 * times (the leaving page re-renders inside `AnimatePresence`, the arriving one
 * mounts, both animate); without the latch the second render would see the tab
 * it had already recorded, conclude nothing had moved, and hand back `null`
 * halfway through — flipping the page's direction mid-animation.
 */
export function lateralTabDirection(pathname, memory = tabMemory) {
  const path = normalize(pathname);
  const index = path === null ? -1 : TAB_ORDER.indexOf(path);

  if (index === -1) {
    // Left the bar entirely (an entity, settings, the reader). Forget where we
    // were, so coming back to a tab from a deep page is a return through
    // history, not a slide along a bar we were not on.
    memory.index = undefined;
    memory.direction = null;
    return null;
  }

  if (memory.index === index) return memory.direction ?? null;

  const previous = memory.index;
  memory.index = index;
  memory.direction = typeof previous === 'number' ? Math.sign(index - previous) : null;
  return memory.direction;
}
