/**
 * The theme switch, and which of three routes it takes to get there.
 *
 * The flip itself is cheap — under a millisecond to commit, a few more to
 * recompute the CSS tokens. What costs is the animation wrapped around it:
 * `startViewTransition` snapshots the whole page before the callback runs,
 * and on a phone at device pixel ratio that snapshot is tens of megabytes of
 * texture. Add a 420 ms `clip-path` circle on top of a capture that already
 * ate a long frame, and the sweep is what reads as heavy — not the theme
 * change underneath it.
 *
 *   1. `instant` — no animation at all. Either the reader asked for reduced
 *      motion, in which case a circle crossing the viewport is exactly the
 *      movement that preference exists to refuse, or the browser has no
 *      View Transitions API, in which case the fallback used to be a 240 ms
 *      `!important` transition on every element in the app. That was a
 *      bigger cost than the sweep it was standing in for; doing nothing is
 *      cheaper and reads as instant, which is the correct affordance for a
 *      browser this old.
 *   2. `fade` — a short, composited opacity cross-fade, for coarse pointers
 *      (touch). Still goes through `startViewTransition` for the snapshot
 *      swap, but skips the `clip-path` sweep: on mobile, the capture cost is
 *      already paid, so the animation on top of it needs to be the cheapest
 *      thing a GPU can do. Opacity alone composites everywhere; 160 ms is
 *      short enough that the extra frame from the snapshot doesn't register
 *      as lag.
 *   3. `sweep` — the ink sweep, for everything else (mouse/trackpad with
 *      View Transitions, i.e. desktop). A circle of the incoming theme opens
 *      out of the control the reader just pressed, rather than a fade of the
 *      whole window. Desktop GPUs and DPRs make the same capture cheap
 *      enough that the extra 420 ms of `clip-path` doesn't cost what it
 *      would on a phone.
 *
 * The animation itself is CSS (`global.css`, "Theme switch"); this module
 * only picks the route and, for `sweep`, tells the CSS where the circle
 * starts and how far it has to reach.
 *
 * `commit` must change the theme synchronously — it runs inside the transition
 * callback, and React's own re-render lands after it.
 */

/**
 * Pure so it is testable without a DOM: three booleans in, one route out.
 * Everything that actually reads `window`/`matchMedia` lives in the caller.
 */
export function pickThemeRoute({ reducedMotion, hasViewTransitions, coarsePointer }) {
  if (reducedMotion) return 'instant';
  if (!hasViewTransitions) return 'instant';
  return coarsePointer ? 'fade' : 'sweep';
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function coarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * The centre of the control, and the distance from there to the farthest
 * corner — the radius at which the circle has covered the window.
 */
function markSweepOrigin(origin) {
  const root = document.documentElement;
  const rect = origin?.getBoundingClientRect?.();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth;
  const y = rect ? rect.top + rect.height / 2 : 0;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  root.style.setProperty('--theme-sweep-x', `${Math.round(x)}px`);
  root.style.setProperty('--theme-sweep-y', `${Math.round(y)}px`);
  root.style.setProperty('--theme-sweep-r', `${Math.ceil(radius)}px`);
}

const PLAIN_CLASS = 'theme-switch-plain';

export function runThemeSwitch(commit, origin) {
  const route = pickThemeRoute({
    reducedMotion: prefersReducedMotion(),
    hasViewTransitions: typeof document.startViewTransition === 'function',
    coarsePointer: coarsePointer(),
  });

  if (route === 'instant') {
    commit();
    return;
  }

  if (route === 'fade') {
    const root = document.documentElement;
    root.classList.add(PLAIN_CLASS);
    const vt = document.startViewTransition(commit);
    // `finished` rejects when a transition is skipped or aborted; `.then`
    // with both handlers cleans up either way and — unlike `.finally` —
    // doesn't re-throw and log an unhandled rejection for the common case
    // of a reader toggling the theme again before the fade finishes.
    const cleanup = () => root.classList.remove(PLAIN_CLASS);
    vt.finished.then(cleanup, cleanup);
    return;
  }

  markSweepOrigin(origin);
  document.startViewTransition(commit);
}
