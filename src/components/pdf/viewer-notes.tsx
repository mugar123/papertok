import type { SyntheticEvent } from 'react';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Highlighter, Trash, X } from '@phosphor-icons/react';
import { Popover } from '../ui/popover.tsx';
import { Button } from '../ui/button.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import type { HighlightColor } from '../../services/user-highlight-service.ts';
import { HIGHLIGHT_COLORS, MAX_NOTE_LENGTH } from '../../services/user-highlight-service.ts';
import './viewer-notes.css';

const COLOR_NAMES: Record<HighlightColor, string> = { yellow: 'Yellow', teal: 'Teal', sky: 'Blue', violet: 'Violet', rose: 'Rose' };
const ERROR = 'Could not save. Check your connection and try again.';

type PassageEditorProps = {
  quote: string;
  error: boolean;
  initialNote: string;
  returnFocus: HTMLElement | null;
  anchor: { top: number; bottom: number; left: number; right: number };
  busy: boolean;
  sheet: boolean;
  onSave: (note: string, color: HighlightColor) => void;
  onCancel: () => void;
};

export function PassageEditor({ quote, anchor, busy, error, initialNote, returnFocus, sheet, onSave, onCancel }: PassageEditorProps) {
  const [draft, setDraft] = useState(initialNote);
  const [color, setColor] = useState<HighlightColor>('yellow');
  const noteId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const mountField = useCallback((node: HTMLTextAreaElement | null) => {
    field.current = node;
    if (node && !sheet) setTimeout(() => node.focus());
  }, [sheet]);
  useEffect(() => {
    document.documentElement.dataset.passageColor = color;
    return () => { delete document.documentElement.dataset.passageColor; };
  }, [color]);
  const note = draft.trim();
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!busy) onSave(note, color);
  };
  const virtual = useMemo(() => ({
    getBoundingClientRect: () => DOMRect.fromRect({ x: anchor.left, y: anchor.top, width: anchor.right - anchor.left, height: anchor.bottom - anchor.top }),
  }), [anchor]);
  const form = (
    <form onSubmit={submit}>
      <label htmlFor={noteId} className="visually-hidden">Note (optional)</label>
      <Textarea
        id={noteId}
        ref={mountField}
        rows={1}
        className="vn-pop-input"
        value={draft}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Add a note (optional)"
        aria-describedby={error ? errorId : undefined}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !sheet) submit(event); }}
      />
      {error && <p id={errorId} className="vn-pop-error">{ERROR}</p>}
      <div className="vn-pop-bar">
        <fieldset className="vn-swatches">
          <legend className="visually-hidden">Highlight colour</legend>
          {HIGHLIGHT_COLORS.map(option => (
            <label key={option} className="vn-swatch" data-color={option} title={COLOR_NAMES[option]}>
              <input type="radio" name={`${noteId}-color`} value={option} checked={color === option} onChange={() => setColor(option)} />
              <span className="visually-hidden">{COLOR_NAMES[option]}</span>
            </label>
          ))}
        </fieldset>
        {sheet
          ? <Button type="submit" disabled={busy}>{note ? 'Save note' : 'Highlight'}</Button>
          : (
            <Button type="submit" size="icon-sm" disabled={busy} aria-label={note ? 'Save highlight with note' : 'Save highlight'} title="Save (Enter)">
              <Highlighter size={16} aria-hidden="true" />
            </Button>
          )}
      </div>
    </form>
  );
  if (sheet) {
    return (
      <Drawer open onOpenChange={(next) => { if (!next) onCancel(); }}>
        <DrawerContent className="vn-sheet" overlayClassName="vn-sheet-backdrop" forceOverlay viewportClassName="vn-sheet-viewport" finalFocus={() => returnFocus ?? true}>
          <DrawerHandle />
          <DrawerTitle render={<h2 />} className="vn-sheet-title">Highlight this passage</DrawerTitle>
          <DrawerDescription render={<blockquote />} className="vn-quote vn-sheet-quote" data-color={color}>{quote}</DrawerDescription>
          {form}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={virtual} side="bottom" align="start" sideOffset={8} collisionPadding={10} className="vn-pop-positioner">
          <PopoverPrimitive.Popup className="vn-pop" aria-label="Highlight this passage" initialFocus={field} finalFocus={() => returnFocus ?? true}>
            <PopoverPrimitive.Description className="visually-hidden">{quote}</PopoverPrimitive.Description>
            {form}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}

export function NotesSidebar({ id, open, passages, onRemove, onClose }: {
  id: string;
  open: boolean;
  passages: PassageAnnotation[];
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const list = useRef<HTMLElement | null>(null);
  const remove = (index: number) => {
    const rows = list.current?.querySelectorAll<HTMLElement>('.vn-delete');
    (rows?.[index + 1] ?? rows?.[index - 1] ?? list.current?.querySelector<HTMLElement>('.vn-side-title'))?.focus();
    onRemove(passages[index].id);
  };
  return (
    <aside id={id} className="vn-side" data-hidden={open ? undefined : ''} inert={!open} aria-labelledby={`${id}-title`} ref={list}>
      <div className="vn-side-head">
        <h2 id={`${id}-title`} className="vn-side-title" tabIndex={-1}>Notes <span className="vn-count">{passages.length}</span></h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close notes" title="Close" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </Button>
      </div>
      {passages.length === 0
        ? <p className="vn-empty">Select text in the paper to highlight it or add a note.</p>
        : (
          <ul className="vn-list">
            {passages.map((passage, index) => (
              <li key={passage.id} className="vn-item">
                <div className="vn-entry">
                  <blockquote className="vn-quote" data-color={passage.color ?? 'yellow'}>{passage.quote}</blockquote>
                  <Button variant="ghost" size="icon-sm" className="vn-delete" aria-label={`Delete highlight “${passage.quote}”`} title="Delete" onClick={() => remove(index)}>
                    <Trash size={15} aria-hidden="true" />
                  </Button>
                </div>
                {passage.note && <p className="vn-note">{passage.note}</p>}
              </li>
            ))}
          </ul>
        )}
    </aside>
  );
}
