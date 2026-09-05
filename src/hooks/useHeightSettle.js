import { useLayoutEffect, useRef } from 'react';
import { depsAreSame, planHeightSettle } from './heightSettlePlan.js';

const SETTLE_ID = 'height-settle';
const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** The `overflow` each element had before a settle clipped it, by element. */
const restingOverflow = new WeakMap();

/**
 * Settles an element's height across a change in what it holds, instead of
 * letting the box snap to its new size in one frame.
 *
 * FLIP on one property: after each commit the hook measures the element and,
 * if the decision (`planHeightSettle`) says so, plays a Web Animation from
 * the height it remembers to this one. The natural height is never written
 * to the element — the animation holds the old value and releases to whatever
 * layout says — so the content underneath keeps laying out on its own and
 * nothing has to know the final number in advance.
 *
 * The effect has NO dependency list on purpose. `deps` still say which
 * changes are worth a movement, but the memory of the box's height is kept
 * on every commit: a height that changed without a dep (a toggle mounting a
 * frame after the paragraph it belongs to, the reader folding a panel) used
 * to leave the memory behind, and the next dep animated the box from a
 * height it had already left — measured on a topic page as the list jumping
 * 27px up and sliding back down when the thumbnail loaded. A settle in
 * flight is read every commit as well: if its target still stands it resumes
 * on the same keyframes and clock; if the target moved under it, it is
 * re-aimed from where the box is. The cost is one layout read per commit on
 * a small subtree, which the browser was about to do before paint anyway.
 *
 * The ref may point at a different element from one commit to the next (a
 * skeleton and the live block it hands over to): the remembered height
 * belongs to the slot, not the node, which is what makes the handover between
 * the two settle rather than jump.
 *
 * While a settle runs the element clips (`overflow: hidden`), because its box
 * is smaller than its content on the way up; the `overflow` it had is put
 * back when the last settle ends, so a menu that hangs outside the box at
 * rest is only clipped while the box is moving.
 *
 * `enabled: false` keeps the memory up to date without animating (reduced
 * motion).
 */
export function useHeightSettle(ref, deps, { enabled = true, duration = 360, easing = EASE } = {}) {
  const lastHeightRef = useRef(null);
  const lastDepsRef = useRef(null);

  useLayoutEffect(() => {
    const depsChanged = !depsAreSame(lastDepsRef.current, deps);
    lastDepsRef.current = deps;
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      lastHeightRef.current = null;
      return;
    }
    const inFlight = typeof el.getAnimations === 'function'
      ? el.getAnimations().find((animation) => animation.id === SETTLE_ID)
      : null;
    let running = null;
    let current = null;
    if (inFlight) {
      const [start, end] = inFlight.effect.getKeyframes();
      running = { from: parseFloat(start.height), to: parseFloat(end.height), currentTime: inFlight.currentTime || 0 };
      current = el.getBoundingClientRect().height;
      inFlight.cancel();
    }
    const natural = el.getBoundingClientRect().height;
    const plan = planHeightSettle({ remembered: lastHeightRef.current, depsChanged, running, current, natural });
    lastHeightRef.current = plan.remember;
    if (!enabled || plan.action === 'none' || typeof el.animate !== 'function') return;
    if (!restingOverflow.has(el)) restingOverflow.set(el, el.style.overflow);
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [{ height: `${plan.from}px` }, { height: `${plan.to}px` }],
      { duration, easing },
    );
    animation.id = SETTLE_ID;
    if (plan.action === 'resume') animation.currentTime = plan.currentTime;
    const release = () => {
      // A newer settle may have taken over the box; it will release it.
      if (el.getAnimations().some((other) => other.id === SETTLE_ID)) return;
      el.style.overflow = restingOverflow.get(el) ?? '';
      restingOverflow.delete(el);
    };
    animation.finished.then(release, release);
  });
}
