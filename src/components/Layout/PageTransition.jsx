import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePresence, usePresenceData } from 'framer-motion';
import { usePageTransitionCustomValue } from '../../hooks/usePageTransitionCustom.js';
import RouteFallback from './RouteFallback.jsx';
import { EXIT_SAFETY_MS, pageMotionFor } from './pageMotion.js';
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

  // A page re-entered while it was leaving — back, then forward, before its
  // exit finished — is a new arrival: it animates in again instead of
  // snapping to rest with the `settled` of its first visit. State adjusted
  // during render, the documented way to reset state when a prop changes.
  const [wasPresent, setWasPresent] = useState(present);
  if (present !== wasPresent) {
    setWasPresent(present);
    if (present) setSettled(false);
  }

  const motion = present && settled ? 'rest' : pageMotionFor({ direction, lateral, present });

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
  }, [present]);

  // The safety clock: a background tab or a cancelled animation never fires
  // `animationend`, and a page that never hands itself back is a page
  // AnimatePresence keeps forever. Cleared if the page becomes present again.
  useEffect(() => {
    if (present || !safeToRemove) return undefined;
    const timer = window.setTimeout(safeToRemove, EXIT_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [present, safeToRemove]);

  // The cards and the hero animate too, and their `animationend` bubbles up
  // here; only the root's own counts.
  const handleAnimationEnd = useCallback((event) => {
    if (event.target !== rootRef.current) return;
    if (present) setSettled(true);
    else if (safeToRemove) safeToRemove();
  }, [present, safeToRemove]);

  // `data-nav-direction` is for the page's own content: coming back (-1) is a
  // return to something that was there, so the feed's cards resume at rest
  // instead of arriving again (PaperCard.css reads this).
  return (
    <div
      ref={rootRef}
      className="page-transition"
      data-nav-direction={direction}
      data-page-motion={motion}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* A chunk that is not cached suspends HERE, inside the page arriving,
          so the fallback (delayed 320ms in RouteFallback.css) is drawn over
          this page alone while the one leaving stays on screen. */}
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </div>
  );
}
