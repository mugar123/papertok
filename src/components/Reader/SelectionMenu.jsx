import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Highlighter, Loader2, PenLine, Sparkles } from 'lucide-react';
import { MAX_NOTE_LENGTH } from '../../services/userHighlightService.js';
import { Popover } from '../ui/popover.jsx';
import { Textarea } from '../ui/textarea.jsx';

/**
 * What to do with the passage you just selected.
 *
 * Three ways out — mark it, write on it, ask about it — and then, for the
 * middle one, the same box grows into the place you write. It grows rather than
 * being replaced: closing one popover and opening another loses the thread back
 * to the sentence that started it, and that thread is the whole point of
 * putting this over the selection instead of in a sidebar.
 *
 * A Base UI Popover anchored to the selection's own rectangle, handed over as
 * a virtual element: it sits under the passage, flips above when there is no
 * room, and is shifted back inside the viewport at the edges — what
 * `placeSelectionMenu` used to compute by hand. Outside press and Escape are
 * the primitive's; both arrive here as `onClose`. The Positioner is composed
 * from the primitive rather than through `PopoverContent` because only the
 * Positioner takes an `anchor`, and the ui wrapper does not forward one.
 *
 * Kept mounted while the reader is on the fine-pointer route, with `open`
 * following whether there is a pending selection: the popup has to keep
 * pointing at the last rectangle for the length of its leave, after the
 * selection that produced it has already been dismissed.
 */

/** A floating-ui virtual element over a viewport rectangle captured at selection time. */
function virtualAnchor(rect) {
  if (!rect) return null;
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  return {
    getBoundingClientRect: () => ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width,
      height,
      toJSON() { return this; },
    }),
  };
}

export default function SelectionMenu({
  open = false,
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
  const noteFieldId = useId();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef(null);
  // Where focus lands on open: the first action. The keyboard route into this
  // menu (Enter on a focused paragraph) leaves focus on the paragraph, so
  // without this the menu opened and the reader could not reach it.
  const firstActionRef = useRef(null);
  // The last rectangle the menu opened on. Written from an effect, not during
  // render (`react-hooks/refs`), and read only when Base UI asks where to put
  // the popup — which it does on open and on every layout shift after.
  const anchorRef = useRef(null);
  useEffect(() => {
    if (anchor) anchorRef.current = anchor;
  }, [anchor]);
  const resolveAnchor = useCallback(() => virtualAnchor(anchorRef.current), []);

  useEffect(() => {
    if (composing) textareaRef.current?.focus();
  }, [composing]);

  const submit = (event) => {
    event.preventDefault();
    const note = draft.trim();
    if (note) onSaveNote(note);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      // The composer is the menu's own state: a menu that reopens on the next
      // selection already in "write a note" mode is answering a question the
      // reader has not asked yet. Reset once the leave has played.
      onOpenChangeComplete={(next) => {
        if (next) return;
        setComposing(false);
        setDraft('');
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={resolveAnchor}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={10}
          className="isolate z-[12055]"
        >
          <PopoverPrimitive.Popup
            initialFocus={firstActionRef}
            className="rd-menu"
            aria-label={copy.selectionTitle}
            data-composing={composing ? '' : undefined}
          >
            {composing ? (
              <form className="rd-menu-compose" onSubmit={submit}>
                <label className="rd-menu-label" htmlFor={noteFieldId}>
                  <i className="rd-menu-pen" aria-hidden="true" />
                  {copy.yourNote}
                </label>
                <Textarea
                  id={noteFieldId}
                  ref={textareaRef}
                  className="rd-menu-input"
                  value={draft}
                  maxLength={MAX_NOTE_LENGTH}
                  placeholder={copy.notePlaceholder}
                  aria-label={copy.yourNote}
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
              </form>
            ) : (
              <div className="rd-menu-list">
                <button type="button" className="rd-menu-item" ref={firstActionRef} onClick={onHighlight}>
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
              </div>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
