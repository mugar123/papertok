import type { SyntheticEvent } from 'react';
import type { ReaderCopy } from './PaperReader.tsx';
type SelectionRect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
interface SelectionMenuProps {
  open?: boolean; anchor?: SelectionRect | null; copy: ReaderCopy; noteNumber?: number; notePlace?: string;
  usesLeft?: number | null; usesLimit?: number | null; unlimited?: boolean; canAsk?: boolean; busy?: boolean;
  onHighlight: () => void; onSaveNote: (note: string) => void;
  onAsk: () => void; onClose: () => void;
}
import { useEffect, useId, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { CircleNotch, Highlighter, PencilLine, Sparkle } from '@phosphor-icons/react';
import { MAX_NOTE_LENGTH } from '../../services/userHighlightService.ts';
import { Popover } from '../ui/popover.tsx';
import { Textarea } from '../ui/textarea.tsx';
import UsesCount from './UsesCount.tsx';

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
 * a virtual element re-anchored on every selection: it sits under the passage,
 * flips above when there is no room, and is shifted back inside the viewport at the edges — what
 * `placeSelectionMenu` used to compute by hand. Outside press and Escape are
 * the primitive's; both arrive here as `onClose`. The Positioner is composed
 * from the primitive rather than through `PopoverContent` because only the
 * Positioner takes an `anchor`, and the ui wrapper does not forward one.
 *
 * Kept mounted while the reader is open, with `open` following whether there is a pending selection: the popup has to keep
 * pointing at the last rectangle for the length of its leave, after the
 * selection that produced it has already been dismissed.
 */

/** A floating-ui virtual element over a viewport rectangle captured at selection time. */
function virtualAnchor(rect: SelectionRect | null | undefined) {
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
  noteNumber,
  notePlace,
  usesLeft,
  usesLimit,
  unlimited = false,
  canAsk = true,
  busy = false,
  onHighlight,
  onSaveNote,
  onAsk,
  onClose,
}: SelectionMenuProps) {
  const noteFieldId = useId();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Where focus lands on open: the first action. The keyboard route into this
  // menu (Enter on a focused paragraph) leaves focus on the paragraph, so
  // without this the menu opened and the reader could not reach it.
  const firstActionRef = useRef<HTMLButtonElement | null>(null);
  // The rectangle the menu is anchored to, as a value Base UI re-reads. It
  // was a stable function returning the latest rectangle, and Base UI only
  // resolves a function anchor when the popup mounts: select another sentence
  // while the menu is still leaving — a double-click, a short drag — and it
  // reopened over the previous selection (measured 2026-09-17). Latched in
  // render, the documented way to derive state from a prop: it changes with
  // every selection, so Base UI re-anchors, and it is kept while `anchor` is
  // gone, so the leave still points at the passage it was about. A new
  // selection also puts the composer away — the draft was about the last one.
  const [anchorSeen, setAnchorSeen] = useState(anchor);
  const [anchorElement, setAnchorElement] = useState(() => virtualAnchor(anchor));
  if (anchor && anchor !== anchorSeen) {
    setAnchorSeen(anchor);
    setAnchorElement(virtualAnchor(anchor));
    setComposing(false);
    setDraft('');
  }

  useEffect(() => {
    if (composing) textareaRef.current?.focus();
  }, [composing]);

  const submit = (event: SyntheticEvent) => {
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
          anchor={anchorElement}
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
                <div className="rd-menu-compose-row">
                  {noteNumber ? <span className="rd-menu-number" aria-hidden="true">{noteNumber}</span> : null}
                  <Textarea
                    id={noteFieldId}
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
                </div>
                <label className="visually-hidden" htmlFor={noteFieldId}>
                  {notePlace ? `${copy.yourNote} · ${notePlace}` : copy.yourNote}
                </label>
                <div className="rd-menu-actions">
                  <button type="button" className="rd-menu-act" onClick={onClose}>{copy.cancel}</button>
                  <button type="submit" className="rd-menu-act rd-menu-act--save" disabled={!draft.trim() || busy}>
                    {busy ? <CircleNotch size={13} className="spinning" /> : null}
                    {copy.save}
                  </button>
                </div>
              </form>
            ) : (
              <div className="rd-menu-list">
                <button type="button" className="rd-menu-item" ref={firstActionRef} onClick={onHighlight}>
                  <Highlighter size={15} />
                  {copy.justHighlight}
                </button>
                <button type="button" className="rd-menu-item" onClick={() => setComposing(true)}>
                  <PencilLine size={15} />
                  {copy.writeNote}
                </button>
                <button
                  type="button"
                  className="rd-menu-item"
                  onClick={onAsk}
                  disabled={!canAsk}
                  title={canAsk ? undefined : copy.noUsesLeft}
                >
                  <Sparkle size={15} />
                  {copy.explainThis}
                  {/* The price, stated before it is spent. A daily allowance that only
                      announces itself once it is gone is a trap — and where there is
                      no allowance there is no price to state. */}
                  {!unlimited && (
                    typeof usesLeft === 'number' && usesLimit ? (
                      <small><UsesCount left={usesLeft} limit={usesLimit} copy={copy} /></small>
                    ) : <small>{canAsk ? copy.oneUse : copy.noUsesLeftShort}</small>
                  )}
                </button>
              </div>
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}
