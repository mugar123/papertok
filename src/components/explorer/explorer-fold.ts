import type { Transition } from 'framer-motion';

// A fold's collapse. What travels is the page under the fold, and it has to
// land, so the space rides a gentle ease-in-out while the contents fade
// evenly. 300ms because this is a click's answer — the reader is waiting on it.
//
// The curve itself was chosen by measurement on the Wikipedia fold, back when
// that one still closed its own height (four probe runs with
// `scripts/diagnostics/explorer-loading-probe.mjs`): what a collapse costs the reader is its worst single
// frame — travel × steepness ÷ frames — not its duration, and a steep
// ease-in-out given too few frames measured WORSE than the front-loaded curve
// it replaced. Shortening this is no free way to make it feel quicker.
const FOLD_OUT: Transition = {
  opacity: { duration: 0.16, ease: 'linear' },
  height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
};

export function foldMotion(reduce: boolean | null) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, height: 0 },
    animate: { opacity: 1, height: 'auto' },
    exit: reduce ? { opacity: 0 } : { opacity: 0, height: 0, transition: FOLD_OUT },
    transition: reduce
      ? { duration: 0 }
      : { opacity: { duration: 0.24, ease: 'linear' }, height: { duration: 0.3, ease: [0.4, 0, 0.2, 1] } } as Transition,
  };
}
