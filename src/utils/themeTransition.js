/**
 * The ink sweep: a circle of the incoming theme opening out of the control the
 * reader just pressed, rather than a fade of the whole window.
 *
 * The animation itself is CSS (`global.css`, "Theme switch"); this only tells
 * it where the circle starts and how far it has to reach, and picks which of
 * the three routes the switch takes:
 *
 *   1. View Transitions, where the browser has them. The theme flips inside
 *      `startViewTransition`, so the old page is a snapshot and the new one
 *      grows over it — one composited clip-path, no duplicated DOM.
 *   2. A 200 ms colour cross-fade otherwise. Bounded to the switch itself:
 *      the class goes on for the length of the fade and comes straight off,
 *      because a permanent `* { transition: background-color }` would put a
 *      fade on every hover in the app.
 *   3. Nothing at all under `prefers-reduced-motion`. A circle sweeping the
 *      whole viewport is exactly the movement that preference exists to
 *      refuse, and the fade is still movement of the same kind, just slower.
 *
 * `commit` must change the theme synchronously — it runs inside the transition
 * callback, and React's own re-render lands after it.
 */

const CROSSFADE_CLASS = 'theme-crossfade';
const CROSSFADE_MS = 240;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

export function runThemeSwitch(commit, origin) {
  if (prefersReducedMotion()) {
    commit();
    return;
  }

  if (typeof document.startViewTransition !== 'function') {
    const root = document.documentElement;
    root.classList.add(CROSSFADE_CLASS);
    window.setTimeout(() => root.classList.remove(CROSSFADE_CLASS), CROSSFADE_MS);
    commit();
    return;
  }

  markSweepOrigin(origin);
  document.startViewTransition(commit);
}
