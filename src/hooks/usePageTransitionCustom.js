import { createContext, useContext } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { directionForHistoryIndex } from '../utils/routeDirection.js';
import { lateralTabDirection } from '../utils/tabDirection.js';

/**
 * Computed once, in `App`, and read from here by every `PageTransition`.
 *
 * It has to be exactly once. Both direction helpers keep a module-level memory
 * of the entry they last answered for, and a `Routes` carrying its own
 * `location` prop — which is how `App` renders it — gives its subtree a
 * location context of its OWN. So the outgoing page, which `AnimatePresence`
 * keeps mounted through its exit, sees the location it was rendered for rather
 * than the one being navigated to. Measured with `PageTransition`
 * calling the hook itself: on a switch from For you to Following the leaving
 * page re-rendered, asked about "/" while the memory had already moved to
 * "/following", and got -1 — dragging the shared memory back to the tab it was
 * leaving and mis-reporting `data-nav-direction` for the rest of the run. One
 * caller, one answer, handed down.
 */
const PageTransitionCustomContext = createContext({ direction: 0, lateral: false });

export const PageTransitionCustomProvider = PageTransitionCustomContext.Provider;

/** What `PageTransition` reads. Never recomputes; never touches the memory. */
export function usePageTransitionCustomValue() {
  return useContext(PageTransitionCustomContext);
}

/**
 * What the route transition needs to know, for the page arriving AND the one
 * leaving.
 *
 * `App` passes this to `AnimatePresence` as well as letting `PageTransition`
 * read it, and the reason is the leaving page. `AnimatePresence` keeps the
 * previous `Routes` ELEMENT mounted while it exits — the same React element,
 * not a re-render — so the outgoing `PageTransition` never learns that the
 * navigation happened and would resolve its `exit` variant against whatever
 * `custom` it was mounted with. Measured before `App` passed this down: the
 * first tab switch after arriving at the bar still ran the 200ms hierarchy
 * exit and left in the direction it had mounted with, while the incoming page
 * correctly used the lateral one — the two halves of one handover disagreeing.
 * Every switch after that was right, which is what made it easy to miss.
 * `AnimatePresence`'s own `custom` is the supported way to hand an exiting
 * child a fresh value.
 *
 * It lives here rather than beside `PageTransition` because a component file
 * that also exports a function breaks Fast Refresh for the whole module.
 *
 * **Call this once per render pass, from `App`, and nowhere else** — see the
 * context above for what a second caller does to the shared memory.
 */
export function usePageTransitionCustom() {
  // The index, not the type: this router reports POP for every navigation
  // (measured on the tab bar — a push arrived as POP with the index at 1), so
  // the type alone made every page a return. The index grows on a push,
  // shrinks on a step back, holds on a replace; the type only stands in where
  // there is no index at all.
  const historyDirection = directionForHistoryIndex(
    typeof window !== 'undefined' ? window.history.state?.idx : null,
    undefined,
    useNavigationType(),
  );
  // History cannot answer between the navbar's own tabs: every tab press is a
  // push, so the index only ever grows and both going to Following and coming
  // back from it reported 1. The bar's order is what knows which way is which;
  // `lateralTabDirection` returns null for anything that is not a tab-to-tab
  // move, and history keeps the question.
  const lateral = lateralTabDirection(useLocation().pathname);
  return { direction: lateral ?? historyDirection, lateral: lateral !== null };
}
