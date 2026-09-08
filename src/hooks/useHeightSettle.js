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
 * 27px up and sliding back down when the thumbnail loaded. `deps` is
 * load-bearing now, not optional: called without it, `depsAreSame(undefined,
 * undefined)` reads as false on every commit, so `depsChanged` is always
 * true and the hook silently becomes "animate on any change of 1px or more"
 * instead of only the ones `deps` says are worth it. A settle in flight is
 * read every commit as well: if its target still stands it resumes on the
 * same keyframes and clock; if the target moved under it, it is re-aimed
 * from where the box is. Calling this "one layout read per commit on a small
 * subtree" would undersell it: `getBoundingClientRect()` flushes layout for
 * the whole document, not just this element, and the caller here
 * (`EntityExplorer`) re-renders on every keystroke of its own in-page search
 * box — so this runs, synchronously, on every one of those keystrokes too.
 * Still the right trade: the alternative is the box snapping instead of
 * settling.
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
 * motion). `suspended` is the same thing decided per commit rather than per
 * render: a function asked, inside the layout effect, whether this particular
 * change should be carried or snapped. It exists because the answer — "is the
 * route transition still moving this page?" — is only true for a few hundred
 * milliseconds and a React flag for it arrives late. Measured 2026-09-07: with
 * the gate on a state flag, the page was visually at rest (opacity 1,
 * translate 0) at 302ms but `animationend` had not been committed yet, and the
 * skeleton-to-hero handover landing at 329ms in that 38ms window was snapped
 * 115.8px instead of settled — a worse defect than the one the gate was for.
 */
export function useHeightSettle(ref, deps, { enabled = true, suspended, duration = 360, easing = EASE } = {}) {
  const lastHeightRef = useRef(null);
  const lastDepsRef = useRef(null);
  // Raised for as long as something else owns the box, and read once on the
  // first commit after that. The memory taken while suspended is a frame of the
  // other owner's animation, so the commit that inherits it must re-sync rather
  // than animate from it.
  const staleMemoryRef = useRef(false);

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
    // Asked here, before anything is cancelled: the DOM knows whether the page
    // is still moving, and it knows it now.
    const standDown = typeof suspended === 'function' && suspended();
    if (standDown && inFlight) {
      // Another owner has taken this box — a child animating its own height.
      // The settle in flight is holding it clipped and SMALLER than its
      // content, so leaving it to finish would hide everything the new owner
      // does and then release it all in one frame. Measured 2026-09-08 on an
      // institution, with this branch returning instead: the Wikipedia fold
      // unfolded inside a box still clamped at 148.8px, and the tab strip
      // jumped 74.8px the frame the clamp let go.
      //
      // Handing the box over costs only what the settle had left to travel,
      // and the handover happens on the new owner's first commit — when it is
      // still at nothing — so that remainder is small.
      inFlight.cancel();
      el.style.overflow = restingOverflow.get(el) ?? '';
      restingOverflow.delete(el);
      lastHeightRef.current = el.getBoundingClientRect().height;
      staleMemoryRef.current = true;
      return;
    }
    let running = null;
    let current = null;
    if (inFlight) {
      const [start, end] = inFlight.effect.getKeyframes();
      running = { from: parseFloat(start.height), to: parseFloat(end.height), currentTime: inFlight.currentTime || 0 };
      current = el.getBoundingClientRect().height;
      inFlight.cancel();
    }
    const natural = el.getBoundingClientRect().height;
    const resync = !standDown && staleMemoryRef.current;
    staleMemoryRef.current = standDown;
    const plan = planHeightSettle({ remembered: lastHeightRef.current, depsChanged, running, current, natural, suspended: standDown, resync });
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
