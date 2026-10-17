import type { Transition } from 'framer-motion';
export interface Progress { count: number; index: number; max?: number; ariaLabel: string; label: (index: number, count: number) => string }
import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

// The progress dots: a dot added grows in place with a light bounce, one taken
// away shrinks in place over the same time, no bounce; each waits DOT_STAGGER
// after its neighbour, so they come and go one at a time.
const DOT_GROW: Transition = { type: 'spring', duration: 0.36, bounce: 0.3 };
const DOT_FOLD: Transition = { duration: 0.36, ease: [0.33, 1, 0.68, 1] };
const DOT_STAGGER = 0.08;
// The row's geometry: a dot is 6px, the current screen's bar 22px, 6px apart.
const DOT = 6;
const BAR = 22;
const DOT_GAP = 6;


export default function ProgressDots({ dots, still }: { dots: Progress; still?: boolean | null }) {
  // The count before the last change: where the new dots start counting from.
  const [counts, setCounts] = useState({ now: dots.count, before: dots.count });
  if (counts.now !== dots.count) setCounts({ now: dots.count, before: counts.now });
  const { before } = counts;
  // One bar and the rest dots, a gap after each but the last.
  const span = (count: number) => (count - 1) * (DOT + DOT_GAP) + BAR;
  return (
    <ol
      className={`gw-dots${dots.max ? ' gw-dots--fixed' : ''}`}
      aria-label={dots.ariaLabel}
      style={dots.max ? { width: span(dots.max) } : undefined}
    >
      <AnimatePresence initial={false} custom={before}>
        {Array.from({ length: dots.count }, (_, index) => (
          <motion.li
            key={index}
            className={`gw-dot${index === dots.index ? ' is-active' : ''}${index < dots.index ? ' is-done' : ''}`}
            aria-current={index === dots.index ? 'step' : undefined}
            variants={{
              born: { opacity: 0, scale: 0 },
              shown: {
                opacity: 1,
                scale: 1,
                width: index === dots.index ? BAR : DOT,
                transition: still
                  ? { duration: 0 }
                  : { default: { ...DOT_GROW, delay: Math.max(0, index - before) * DOT_STAGGER }, width: DOT_FOLD },
              },
              // `custom` is the count before the change, so the last dot goes first.
              folded: (previousCount: number) => ({
                opacity: 0,
                scale: 0,
                transition: still ? { duration: 0 } : { ...DOT_FOLD, delay: Math.max(0, previousCount - 1 - index) * DOT_STAGGER },
              }),
            }}
            initial="born"
            animate="shown"
            exit="folded"
          >
            <span className="gw-dot-label">{dots.label(index + 1, dots.count)}</span>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}
