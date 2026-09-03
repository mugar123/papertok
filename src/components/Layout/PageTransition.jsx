import { motion, useReducedMotion } from 'framer-motion';
import { useLocation, useNavigationType } from 'react-router-dom';
import { directionForNavigationType } from '../../utils/routeDirection.js';

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
 */
const routeVariants = {
  initial: ({ direction, isProject }) => ({
    opacity: 0,
    x: direction * TRAVEL_PX,
    scale: isProject ? 0.995 : 0.997,
  }),
  enter: () => ({
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { duration: ENTER_MS, ease: EASE },
  }),
  exit: ({ direction, isProject }) => ({
    opacity: 0,
    // Out the opposite side from the one the next page arrives on, which is
    // what makes the two look like one movement instead of two.
    x: direction * -TRAVEL_PX * 0.6,
    scale: isProject ? 0.997 : 0.999,
    transition: { duration: EXIT_MS, ease: EASE_LEAVING },
  }),
};

const reducedMotionVariants = {
  initial: { opacity: 0 },
  enter: { opacity: 1, transition: { duration: 0.12 } },
  exit: { opacity: 0, transition: { duration: 0.08 } },
};

export default function PageTransition({ children }) {
  const location = useLocation();
  // The router already knows which way we are going, and it knows it without
  // any state of our own: `App` keys `<Routes>` on the pathname, so this
  // component is unmounted and remade on every navigation and could not
  // remember the previous route even if it tried. `handleBack` in the Explorer
  // calls `navigate(-1)` whenever there is history behind it, which is exactly
  // what makes this report POP.
  const direction = directionForNavigationType(useNavigationType());
  const prefersReducedMotion = useReducedMotion();

  const isProject = location.pathname.startsWith('/explorer/project/');

  return (
    <motion.div
      // The direction, for the page's own content: coming back (-1) is a
      // return to something that was there, so the feed's cards resume at
      // rest instead of arriving again (PaperCard.css reads this).
      data-nav-direction={direction}
      custom={{ direction, isProject }}
      initial="initial"
      animate="enter"
      exit="exit"
      variants={prefersReducedMotion ? reducedMotionVariants : routeVariants}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        transformOrigin: '50% 35%',
      }}
    >
      {children}
    </motion.div>
  );
}
