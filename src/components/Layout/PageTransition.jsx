import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePresence, usePresenceData } from 'framer-motion';
import { usePageTransitionCustomValue } from '../../hooks/usePageTransitionCustom.js';
import { PageArrivalProvider } from '../../hooks/usePageArrival.js';
import RouteFallback from './RouteFallback.jsx';
import { EXIT_SAFETY_MS, isArrivalMotion, pageMotionFor } from './pageMotion.js';
import './PageTransition.css';

/**
 * One route page, and how it arrives or leaves.
 *
 * Two pages share the screen during a navigation (`AnimatePresence
 * mode="sync"` in App.jsx): the deeper one on top, the other underneath,
 * opaque and still. Which is which — and whether this page moves at all —
 * is `pageMotionFor`'s table, written to `data-page-motion` for
 * PageTransition.css to animate. Everything visible is CSS keyframes on
 * opacity and transform: predetermined motion that has to stay smooth while
 * the arriving page mounts 1300px of content, which JS-driven values do not.
 * framer-motion is only the bookkeeper here — who is still present, and the
 * navigation the leaving page must answer to.
 *
 * Measured before this (signed in, chunk warm): `mode="wait"` left two frames
 * with no page painted between the feed going and the entity arriving, the
 * exit accelerated on an ease-in, and the whole handover took ~500ms.
 */
export default function PageTransition({ children }) {
  // `present` flips to false the moment the router leaves this page;
  // AnimatePresence keeps it mounted until `safeToRemove` is called.
  const [present, safeToRemove] = usePresence();
  // The navigation this page belongs to. On the way OUT it is the one that
  // ejects it — AnimatePresence hands it down as `custom` (usePresenceData),
  // the supported channel for an exiting child — and the provider `App` fills
  // once per render answers the same for the page arriving. This component
  // never computes a direction itself: the page leaving is kept mounted under
  // a <Routes location={…}> that still names the route it came from, and
  // asking there answered for the wrong one (see usePageTransitionCustom.js).
  const presenceCustom = usePresenceData();
  const providerCustom = usePageTransitionCustomValue();
  const { direction, lateral } = presenceCustom ?? providerCustom;

  const rootRef = useRef(null);
  // The window scroll this page had, kept while it is present. Read at the
  // moment it leaves it would already be the value the browser restored on a
  // popstate, and a page that left at 800px would jump to its top for its
  // last 180ms.
  const scrollYRef = useRef(0);
  // The direction this page ARRIVED with: the reset below runs once, and
  // must not re-run when the context changes to the navigation that ejects it.
  const arrivalDirection = useRef(direction);
  // True once the arrival animation has ended: the page drops its motion
  // attribute, and with it the stacking context it needed while animating.
  const [settled, setSettled] = useState(false);

  // The direction this page ARRIVED with, frozen for the attribute below. On
  // the way out `direction` is the navigation that ejects the page, and the
  // held feed's cards took that flip as a new arrival: `PaperCard.css` keeps
  // them at rest under `[data-nav-direction="-1"]`, the attribute became "1"
  // in the commit that made the page `hold`, and `pcArrive` replayed from
  // opacity 0 under an entity page still near-transparent. State, so a page
  // re-entered while leaving takes the new arrival's direction.
  const [arrivedWith, setArrivedWith] = useState(direction);

  // A page re-entered while it was leaving — back, then forward, before its
  // exit finished — is a new arrival: it animates in again instead of
  // snapping to rest with the `settled` of its first visit. State adjusted
  // during render, the documented way to reset state when a prop changes.
  const [wasPresent, setWasPresent] = useState(present);
  if (present !== wasPresent) {
    setWasPresent(present);
    if (present) {
      setSettled(false);
      setArrivedWith(direction);
    }
  }

  const motion = present && settled ? 'rest' : pageMotionFor({ direction, lateral, present });

  // Handed to everything inside the page, so a settle in there does not animate
  // a second displacement while this one is travelling. A callback, not a flag:
  // it is asked at the moment of a commit and answers from the DOM — the
  // attribute this render wrote, and whether the animation is still running —
  // rather than from a `settled` that is one React commit behind the frame the
  // page actually stopped on. See usePageArrival.js for the measurement.
  const isArriving = useCallback(() => {
    const root = rootRef.current;
    if (!root || !isArrivalMotion(root.dataset.pageMotion)) return false;
    return root.getAnimations().some((animation) => animation.playState === 'running');
  }, []);

  // A new page starts at the top. It used to by accident: with the pages in
  // sequence the document emptied between exit and entrance and the scroll
  // clamped to 0. With both mounted it never empties, and an entity's scroll
  // would carry into the next. `instant`, because `html { scroll-behavior:
  // smooth }` would turn the reset into a visible glide.
  useLayoutEffect(() => {
    if (arrivalDirection.current !== 0) window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Track the scroll only while present. A layout effect so the listener is
  // gone in the mutation phase of the commit that ejects the page — before
  // the arriving page's reset above can fire a scroll event into it.
  useLayoutEffect(() => {
    if (!present) return undefined;
    const record = () => { scrollYRef.current = window.scrollY; };
    record();
    window.addEventListener('scroll', record, { passive: true });
    return () => window.removeEventListener('scroll', record);
  }, [present]);

  // Out of flow the same frame it stops being present: the stylesheet makes
  // a leaving page `position: fixed`, and this lifts it by the scroll it had,
  // so what was on screen stays on screen while it goes.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.top = present ? '' : `${-scrollYRef.current}px`;
    if (present) root.style.visibility = '';
  }, [present]);

  // `safeToRemove` is a new function on every AnimatePresence render, so an
  // effect keyed on it would restart the clock on any app state change during
  // the exit; the ref keeps the latest one and the clock keys on presence.
  const safeToRemoveRef = useRef(safeToRemove);
  useLayoutEffect(() => {
    safeToRemoveRef.current = safeToRemove;
  });

  // The safety clock: a background tab or a cancelled animation never fires
  // `animationend`, and a page that never hands itself back is a page
  // AnimatePresence keeps forever. Handing back is not always enough either:
  // AnimatePresence waits for EVERY registrant of the page's presence context,
  // and a motion element inside the page whose exit never settles would leave
  // this root mounted — fixed, opaque, and painting over the live page. Hidden,
  // the worst case is a page that vanishes 700ms early. Cleared if the page
  // becomes present again.
  useEffect(() => {
    if (present) return undefined;
    const root = rootRef.current;
    const timer = window.setTimeout(() => {
      if (root) root.style.visibility = 'hidden';
      if (safeToRemoveRef.current) safeToRemoveRef.current();
    }, EXIT_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [present]);

  // The cards and the hero animate too, and their `animationend` bubbles up
  // here; only the root's own counts.
  const handleAnimationEnd = useCallback((event) => {
    if (event.target !== rootRef.current) return;
    // The root now runs TWO animations at once: the travel, which owns the
    // clock and the tuned per-frame curve, and a shorter fade that covers or
    // uncovers early so two text pages are never both legible (PageTransition.css
    // says why). The short one ends first, and acting on it would settle a page
    // still moving and hand a leaving page back halfway out. Ask the element
    // which of its own animations are still running rather than naming them:
    // a fade added later is then handled without touching this.
    const stillMoving = rootRef.current
      .getAnimations()
      .some((animation) => animation.playState === 'running');
    if (stillMoving) return;
    if (present) setSettled(true);
    else {
      // Nested motion elements may keep this presence context mounted after
      // the route finishes. Hide its held frame before the arriving page
      // drops its stacking context, even if removal has to wait for them.
      rootRef.current.style.visibility = 'hidden';
      if (safeToRemove) safeToRemove();
    }
  }, [present, safeToRemove]);

  // `data-nav-direction` is for the page's own content: coming back (-1) is a
  // return to something that was there, so the feed's cards resume at rest
  // instead of arriving again (PaperCard.css reads this). The leaving page
  // keeps the direction it ARRIVED with, not the one that ejects it — `arrivedWith`,
  // frozen above — or its own cards would read the eject as a fresh arrival
  // and replay `pcArrive` under the page covering them. `inert` takes the
  // leaving page — two `<main>` landmarks and a duplicate heading for up to
  // 220ms otherwise — out of the accessibility tree and the tab order, the
  // way `pointer-events: none` (PageTransition.css) already takes it out of
  // the pointer's.
  return (
    <div
      ref={rootRef}
      className="page-transition"
      data-nav-direction={present ? direction : arrivedWith}
      data-leave-direction={present ? undefined : direction}
      data-page-motion={motion}
      inert={!present || undefined}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* A chunk that is not cached suspends HERE, inside the page arriving,
          so the fallback (delayed 320ms in RouteFallback.css) is drawn over
          this page alone while the one leaving stays on screen. */}
      <PageArrivalProvider value={isArriving}>
        <Suspense fallback={<RouteFallback />}>{children}</Suspense>
      </PageArrivalProvider>
    </div>
  );
}
