import { motion, useReducedMotion } from 'framer-motion';
import { usePageTransitionCustomValue } from '../../hooks/usePageTransitionCustom.js';

/**
 * How far a page travels on its way in or out.
 *
 * Small on purpose. The page is not arriving from off-screen — it is settling
 * into a place it already belongs — and past about twenty pixels the movement
 * stops reading as a settle and starts reading as a carousel.
 */
const TRAVEL_PX = 18;

/**
 * Entering costs more time than leaving, and both ride the same curve.
 *
 * The exit used to run at 0.12s on an accelerating ease while the entrance took
 * 0.28s on a decelerating one, and `AnimatePresence mode="wait"` makes the two
 * strictly sequential: the old page must finish before the new one starts. A
 * snap followed by a glide, with a beat of nothing between them — and that beat
 * is what made pressing back feel like a jump cut rather than a step. Bringing
 * the exit up to 0.2s and onto the same curve makes the pair read as one
 * handover.
 */
const ENTER_MS = 0.3;
const EXIT_MS = 0.2;
const EASE = [0.16, 1, 0.3, 1];

/**
 * A step sideways is shorter than a step down.
 *
 * The pair above is the budget for entering a hierarchy — opening an author
 * from a card is a place you have not been, and it can afford half a second.
 * Two tabs of one bar are not that. Measured before this, on a signed-in
 * session: the outgoing page was gone at 250ms and the incoming one did not
 * reach full opacity until ~549ms, because `AnimatePresence mode="wait"` makes
 * the two strictly sequential — 0 frames ever carried both pages. Over half a
 * second to change tab, on a control the reader presses dozens of times a day.
 */
const LATERAL_ENTER_MS = 0.2;
const LATERAL_EXIT_MS = 0.14;

/**
 * Leaving is not arriving reversed.
 *
 * `EASE` is an expo-out. Arriving, that is the whole point: the page appears
 * at once and settles. Leaving, it means the page is gone before it has
 * started going — measured on a switch between two feeds, the outgoing page
 * was at 14% opacity 59ms in and at 0.1% by 159ms, while `mode="wait"` held
 * the incoming one back until 226ms. That left **184ms of blank screen**
 * between two tabs of the same bar, which is the whole of the "it doesn't
 * flow" feeling: not a slow transition, a gap in the middle of a fast one.
 *
 * An ease-in holds the outgoing page up and drops it at the end, so the
 * handover is one page giving way to another instead of two pages either side
 * of nothing.
 */
const EASE_LEAVING = [0.4, 0, 1, 1];

/**
 * `direction` is 1 going deeper, -1 coming back, 0 when the router cannot say.
 *
 * The sign is what makes a hierarchy feel like one: opening an author brings
 * the page in from the right and sends the feed out to the left, and the back
 * arrow reverses both, so returning retraces the step instead of looking like
 * another arrival. Before this, both directions slid the same way and coming
 * back felt like going somewhere new.
 *
 * Opacity and a slide, nothing else.
 *
 * The page used to arrive from `scale: 0.997` (0.995 for a project) and
 * leave towards 0.999. At that size the scale is not a movement anyone sees —
 * three thousandths of a 390px sheet is about a pixel — but it is a raster
 * the browser has to redo: text on a layer scaled by a fraction is drawn at
 * that fraction and drawn again, sharp, the frame the transform comes off.
 * Measured on the production build (390×844, `open` probe): the wrapper
 * settles to `transform: none` some 300ms after the page mounts, and that
 * frame is a full re-raster of a 1300px page under an animated skeleton — the
 * "small glitch" at the end of opening an author. A translate-only transform
 * rasters once at the final size and only moves it.
 */
const routeVariants = {
  initial: ({ direction }) => ({
    opacity: 0,
    x: direction * TRAVEL_PX,
  }),
  enter: ({ lateral }) => ({
    opacity: 1,
    x: 0,
    transition: { duration: lateral ? LATERAL_ENTER_MS : ENTER_MS, ease: EASE },
  }),
  exit: ({ direction, lateral }) => ({
    opacity: 0,
    // Out the opposite side from the one the next page arrives on, which is
    // what makes the two look like one movement instead of two.
    x: direction * -TRAVEL_PX * 0.6,
    transition: { duration: lateral ? LATERAL_EXIT_MS : EXIT_MS, ease: EASE_LEAVING },
  }),
};

const reducedMotionVariants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.12 } },
  exit: { opacity: 0, transition: { duration: 0.08 } },
};

export default function PageTransition({ children }) {
  // Which way we are going, and whether it was a step along the navbar rather
  // than into a hierarchy — handed down from `App`, never computed here. This
  // component must not ask for itself: the page on its way out is kept mounted
  // by `AnimatePresence` inside a `<Routes location={…}>` that still provides
  // the location it was rendered for, so asking would answer for the tab being
  // left rather than the one being entered (see the note on the context).
  const custom = usePageTransitionCustomValue();
  const { direction } = custom;
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      // The direction, for the page's own content: coming back (-1) is a
      // return to something that was there, so the feed's cards resume at
      // rest instead of arriving again (PaperCard.css reads this).
      data-nav-direction={direction}
      custom={custom}
      initial="initial"
      animate="enter"
      exit="exit"
      variants={prefersReducedMotion ? reducedMotionVariants : routeVariants}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </motion.div>
  );
}
