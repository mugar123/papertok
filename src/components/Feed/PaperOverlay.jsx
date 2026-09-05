import { ArrowLeft } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.jsx';
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
 *
 * A full-screen Base UI Dialog (ui/dialog.jsx). The caller owns `open` and
 * keeps the component mounted, so the primitive plays the exit in
 * PaperOverlay.css before the popup leaves the document, and owns the focus
 * trap, Escape and the restore to whatever opened it.
 */
export default function PaperOverlay({ open, onClose, isEnglish, label, children }) {
  return (
    <Dialog open={Boolean(open)} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        className="paper-overlay"
        overlayClassName="paper-overlay-scrim"
        showClose={false}
        closeLabel={isEnglish ? 'Back' : 'Volver'}
        aria-label={label || (isEnglish ? 'Publication details' : 'Detalles de la publicación')}
      >
        <div className="paper-overlay-surface">
          {/* Top-left, and an arrow rather than a cross: this is a place the
              reader came from somewhere to, not a window sitting over it. */}
          <DialogClose
            render={(
              <Button
                variant="outline"
                size="icon"
                className="paper-overlay-back"
                aria-label={isEnglish ? 'Back' : 'Volver'}
                title={isEnglish ? 'Back' : 'Volver'}
              />
            )}
          >
            <ArrowLeft size={22} />
          </DialogClose>
          <div className="paper-overlay-content hide-scroll-hint">
            {children}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
