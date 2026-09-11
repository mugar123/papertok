/**
 * The theme switch, and which of two routes it takes to get there.
 *
 * The flip itself is cheap — under a millisecond to commit, a few more to
 * recompute the CSS tokens. What costs is the animation wrapped around it.
 * Measured on desktop on 2026-09-11 (DPR 2, 60 Hz): `startViewTransition`
 * spends about 50 ms capturing its two snapshots, and then a composited
 * crossfade runs at a steady 60 fps. Every alternative without snapshots
 * was worse. A CSS colour transition wide enough that nothing snaps — `*`,
 * or just the visible cards' subtree — drops the page to 8-9 frames per
 * 300 ms, and animating registered colour tokens on `:root` does the same,
 * because both put a style recalc of hundreds of elements on every frame.
 * The circular ink sweep that lived here before also ran at 60 fps, but its
 * hard edge read as a cut; the crossfade has no edge.
 *
 * Routes:
 *   1. `instant` — reduced motion, or no View Transitions API. The theme
 *      just flips; the attribute swap is cheaper than any animation.
 *   2. `fade` — everything else: the incoming snapshot fades in over the
 *      outgoing one (`global.css`, "Theme switch"), opacity only.
 *
 * Pure so it is testable without a DOM: two booleans in, one route out.
 * Everything that actually reads `window`/`matchMedia` lives in the caller.
 */
export function pickThemeRoute({ reducedMotion, hasViewTransitions }) {
  if (reducedMotion) return 'instant';
  if (!hasViewTransitions) return 'instant';
  return 'fade';
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const PLAIN_CLASS = 'theme-switch-plain';

export function runThemeSwitch(commit) {
  const route = pickThemeRoute({
    reducedMotion: prefersReducedMotion(),
    hasViewTransitions: typeof document.startViewTransition === 'function',
  });

  if (route === 'instant') {
    commit();
    return;
  }

  const root = document.documentElement;
  root.classList.add(PLAIN_CLASS);
  const vt = document.startViewTransition(commit);
  // `finished` rejects when a transition is skipped or aborted; `.then`
  // with both handlers cleans up either way and — unlike `.finally` —
  // doesn't re-throw and log an unhandled rejection for the common case
  // of a reader toggling the theme again before the fade finishes.
  const cleanup = () => root.classList.remove(PLAIN_CLASS);
  vt.finished.then(cleanup, cleanup);
}
