import { motion, useReducedMotion } from 'framer-motion';
import ThinkingDots from './ThinkingDots.jsx';

/**
 * The island. The mobile reader's whole control surface (2026-08-29): the
 * level, the download, and the streaming indicator while a rewrite is being
 * written. It hides with a downward scroll and returns on the way up
 * (`useBarScrollVisibility` in `PaperReader.jsx` drives `visible`).
 *
 * It used to also be the annotations surface — selection actions, a note
 * composer with `visualViewport` keyboard tracking, tap-to-unhighlight. All
 * of that is fine-pointer-only now; the mobile experience is deliberately
 * this small until "explain this" gets the mobile redesign it needs (see
 * docs/superpowers/plans/2026-08-29-lector-movil-recorte.md). The services
 * and the Worker route it used are all still alive for that return.
 *
 * `levelSlot` / `exportSlot` are the SAME controls the desktop dock renders
 * (`levelControl` / `exportControl` in `PaperReader.jsx`): one control, two
 * surfaces, no second implementation to drift.
 */
export default function ReaderBar({ copy, levelSlot, exportSlot, streaming, visible }) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      className="rd-bar"
      data-state="rest"
      // `y: '110%'` hides the bar by translating it by its own height, so it
      // clears the screen at any bar height without a magic pixel figure.
      // A rewrite in flight keeps it up regardless of scroll: the streaming
      // indicator lives here and nowhere else on the touch route.
      animate={{ y: visible || streaming ? 0 : '110%' }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="rd-bar-row" data-row="rest">
        {levelSlot}

        {streaming && (
          <span className="rd-bar-streaming">
            <ThinkingDots />
            {copy.writing}
          </span>
        )}

        {exportSlot}
      </div>
    </motion.div>
  );
}
