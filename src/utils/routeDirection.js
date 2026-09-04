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

/**
 * 1 going deeper, -1 coming back, 0 when there is nothing to claim.
 *
 * The router reports POP for the very first render as well — nothing was
 * pushed — and `historyIndex` (`window.history.state.idx`, which the router
 * keeps at 0 on the first entry and only ever raises after a push) is what
 * tells that arrival apart from a step back. Treated as a return, the first
 * load sat the feed's cards at rest, so the first paper appeared already
 * composed under the atom veil instead of composing as it lifted.
 */
export function directionForNavigationType(navigationType, { historyIndex = null } = {}) {
  if (navigationType === 'POP') return historyIndex === 0 ? 0 : -1;
  if (navigationType === 'PUSH') return 1;
  // REPLACE swaps the current entry for another: same place, different content,
  // so there is no step to animate. A redirect should cross-fade, not slide.
  return 0;
}

/**
 * The direction of the current entry, from the history index alone.
 *
 * React Router 7.18's HashRouter reports POP for every navigation here —
 * measured on the tab bar: a NavLink push and a `navigate('/')` both arrived
 * as POP with `history.state.idx` at 1 and 2. Read through the type, every
 * page entered from the left as a return and the feed's cards sat at rest,
 * on the very tab switch they were choreographed for. The index cannot be
 * misreported: it grows on a push, shrinks on a step back, holds on a
 * replace. `memory` keeps the last index and the direction it produced, so
 * the many renders of one navigation (the leaving page re-rendered inside
 * AnimatePresence, the arriving page mounting, both animating) all read the
 * same answer. The first index this memory sees is an arrival — the first
 * entry, or a reload deep in history — and a missing index (no
 * `history.state`) falls back to the router's own type.
 */
const historyDirectionMemory = {};

export function directionForHistoryIndex(historyIndex, memory = historyDirectionMemory, navigationType = null) {
  if (typeof historyIndex !== 'number') return directionForNavigationType(navigationType);
  if (memory.index === historyIndex) return memory.direction;
  const direction = typeof memory.index === 'number'
    ? Math.sign(historyIndex - memory.index)
    : 0;
  memory.index = historyIndex;
  memory.direction = direction;
  return direction;
}
