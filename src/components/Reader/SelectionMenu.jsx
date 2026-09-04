import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Highlighter, Loader2, PenLine, Sparkles } from 'lucide-react';
import { MAX_NOTE_LENGTH } from '../../services/userHighlightService.js';
import { placeSelectionMenu } from '../../utils/selectionMenuPlacement.js';

/**
 * What to do with the passage you just selected.
 *
 * Three ways out — mark it, write on it, ask about it — and then, for the
 * middle one, the same box grows into the place you write. It grows rather than
 * being replaced: closing one popover and opening another loses the thread back
 * to the sentence that started it, and that thread is the whole point of
 * putting this over the selection instead of in a sidebar.
 *
 * Placement is by the selection's own rectangle. It prefers to sit under the
 * passage and flips above when there is no room, clamped to the viewport on
 * both axes so a selection at the edge of the page still gets a usable menu.
 */

export default function SelectionMenu({
  anchor,
  copy,
  usesLeft,
  unlimited = false,
  canAsk = true,
  busy = false,
  onHighlight,
  onSaveNote,
  onAsk,
  onClose,
}) {
  const prefersReducedMotion = useReducedMotion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const handlePointer = (event) => {
      if (!rootRef.current?.contains(event.target)) onClose();
    };
    // Capture, so a click on the document behind closes the menu before that
    // click can start a new selection underneath it.
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('mousedown', handlePointer, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('mousedown', handlePointer, true);
    };
  }, [onClose]);

  useEffect(() => {
    if (composing) textareaRef.current?.focus();
  }, [composing]);

  const position = placeSelectionMenu(anchor, {
    width: window.innerWidth,
    height: window.innerHeight,
  }, composing);

  const submit = (event) => {
    event.preventDefault();
    const note = draft.trim();
    if (note) onSaveNote(note);
  };

  return (
    <motion.div
      ref={rootRef}
      className="rd-menu"
      role="dialog"
      aria-label={copy.selectionTitle}
      data-composing={composing ? '' : undefined}
      style={{ left: position.left, top: position.top, width: position.width }}
      layout={prefersReducedMotion ? false : 'size'}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={prefersReducedMotion
        ? { opacity: 0, transition: { duration: 0.08 } }
        : { opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.11, ease: 'easeIn' } }}
      transition={{ duration: prefersReducedMotion ? 0.1 : 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* The inner blocks carry `layout` of their own so the parent's size
          animation does not scale their type: framer counter-scales a laid-out
          child, and without it the words stretch for the length of the morph. */}
      {composing ? (
        <motion.form layout={prefersReducedMotion ? false : 'position'} className="rd-menu-compose" onSubmit={submit}>
          <span className="rd-menu-label">
            <i className="rd-menu-pen" aria-hidden="true" />
            {copy.yourNote}
          </span>
          <textarea
            ref={textareaRef}
            className="rd-menu-input"
            value={draft}
            maxLength={MAX_NOTE_LENGTH}
            placeholder={copy.notePlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter writes a newline; the shortcut is the one every comment
              // box in this app already uses.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
            }}
          />
          <div className="rd-menu-actions">
            <button type="submit" className="rd-menu-save" disabled={!draft.trim() || busy}>
              {busy ? <Loader2 size={14} className="spinning" /> : null}
              {copy.save}
            </button>
            <button type="button" className="rd-menu-cancel" onClick={onClose}>{copy.cancel}</button>
          </div>
        </motion.form>
      ) : (
        <motion.div layout={prefersReducedMotion ? false : 'position'} className="rd-menu-list">
          <button type="button" className="rd-menu-item" onClick={onHighlight}>
            <Highlighter size={15} />
            {copy.justHighlight}
          </button>
          <button type="button" className="rd-menu-item" onClick={() => setComposing(true)}>
            <PenLine size={15} />
            {copy.writeNote}
          </button>
          <button
            type="button"
            className="rd-menu-item"
            onClick={onAsk}
            disabled={!canAsk}
            title={canAsk ? undefined : copy.noUsesLeft}
          >
            <Sparkles size={15} />
            {copy.explainThis}
            {/* The price, stated before it is spent. A daily allowance that only
                announces itself once it is gone is a trap — and where there is
                no allowance there is no price to state. */}
            {!unlimited && <small>{canAsk ? copy.oneUse : copy.noUsesLeftShort}</small>}
          </button>
          {typeof usesLeft === 'number' && (
            <p className="rd-menu-foot">{copy.usesLeftLine(usesLeft)}</p>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}
