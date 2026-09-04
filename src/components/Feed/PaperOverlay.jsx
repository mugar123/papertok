import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import './PaperOverlay.css';

/**
 * Opening a paper from anywhere that is not the feed.
 *
 * There were three of these. The explorer and search both took the screen over
 * — an opaque surface edge to edge, with a back arrow in the top-left corner,
 * the way a phone pushes a detail view — while Research floated the same card
 * in a 1080×88vh window with a dimmed backdrop and an X in the top-right. Same
 * card, same gesture, two different promises about where the reader had gone
 * and how to get back.
 *
 * This is the takeover, once. The caller keeps its own `PaperCard` and passes
 * it as children, because what each surface hands the card differs a lot; what
 * is shared is the frame, the way in, and the way back.
 */
export default function PaperOverlay({ open, onClose, isEnglish, label, children }) {
  const prefersReducedMotion = useReducedMotion();
  const dialogRef = useDialogFocus(Boolean(open), onClose);

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          ref={dialogRef}
          className="paper-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={label || (isEnglish ? 'Publication details' : 'Detalles de la publicación')}
          tabIndex={-1}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0.1 : 0.2, ease: 'easeOut' }}
        >
          <motion.div
            className="paper-overlay-surface"
            initial={prefersReducedMotion ? false : { opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.99 }}
            transition={prefersReducedMotion
              ? { duration: 0.1 }
              : { type: 'spring', damping: 30, stiffness: 330, mass: 0.72 }}
          >
            {/* Top-left, and an arrow rather than a cross: this is a place the
                reader came from somewhere to, not a window sitting over it. */}
            <Button
              variant="outline"
              size="icon"
              data-dialog-initial-focus
              className="paper-overlay-back"
              onClick={onClose}
              aria-label={isEnglish ? 'Back' : 'Volver'}
              title={isEnglish ? 'Back' : 'Volver'}
            >
              <ArrowLeft size={22} />
            </Button>
            <div className="paper-overlay-content hide-scroll-hint">
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
