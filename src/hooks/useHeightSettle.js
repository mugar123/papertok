import { useLayoutEffect, useRef } from 'react';

const SETTLE_ID = 'height-settle';
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** The `overflow` each element had before a settle clipped it, by element. */
const restingOverflow = new WeakMap();

/**
 * Settles an element's height across a change in what it holds, instead of
 * letting the box snap to its new size in one frame.
 *
 * FLIP on one property: after each commit the hook measures the element and,
 * if the height it last measured was different, plays a Web Animation from
 * that height to this one. The natural height is never written to the
 * element — the animation holds the old value and releases to whatever layout
 * says — so the content underneath keeps laying out on its own and nothing
 * has to know the final number in advance.
 *
 * The ref may point at a different element from one commit to the next (a
 * skeleton and the live block it hands over to): the remembered height
 * belongs to the slot, not the node, which is what makes the handover between
 * the two settle rather than jump. A settle still running when the next
 * change lands is read for where the box is right now and cancelled, so a
 * burst of arrivals chains into one movement instead of restarting from a
 * stale height.
 *
 * While a settle runs the element clips (`overflow: hidden`), because its box
 * is smaller than its content on the way down and on the way up; the
 * `overflow` it had is put back when the last settle ends, so a menu or a
 * focus ring that hangs outside the box at rest is only clipped while the
 * box is moving.
 *
 * `deps` are the pieces of state that can change the height; the effect runs
 * only on those, so the one forced layout it costs is paid per arrival, not
 * per render. `enabled: false` keeps the memory up to date without animating
 * (reduced motion).
 */
export function useHeightSettle(ref, deps, { enabled = true, duration = 360, easing = EASE } = {}) {
  const lastHeightRef = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      lastHeightRef.current = null;
      return;
    }
    let from = lastHeightRef.current;
    const running = typeof el.getAnimations === 'function'
      ? el.getAnimations().find((animation) => animation.id === SETTLE_ID)
      : null;
    if (running) {
      from = el.getBoundingClientRect().height;
      running.cancel();
    }
    const to = el.getBoundingClientRect().height;
    lastHeightRef.current = to;
    if (!enabled || from == null || Math.abs(to - from) < 1 || typeof el.animate !== 'function') return;
    if (!restingOverflow.has(el)) restingOverflow.set(el, el.style.overflow);
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration, easing },
    );
    animation.id = SETTLE_ID;
    const release = () => {
      // A newer settle may have taken over the box; it will release it.
      if (el.getAnimations().some((other) => other.id === SETTLE_ID)) return;
      el.style.overflow = restingOverflow.get(el) ?? '';
      restingOverflow.delete(el);
    };
    animation.finished.then(release, release);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
