import type { ReactNode, SyntheticEvent } from 'react';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChatCircleDots, Highlighter, Sparkle, Trash, X } from '@phosphor-icons/react';
import { Popover } from '../ui/popover.tsx';
import { Button } from '../ui/button.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Drawer, DrawerContent, DrawerDescription, DrawerHandle, DrawerTitle } from '../ui/drawer.tsx';
import type { HighlightColor } from '../../services/user-highlight-service.ts';
import { HIGHLIGHT_COLORS, MAX_NOTE_LENGTH, highlightColor, passageQuote } from '../../services/user-highlight-service.ts';
import ScientificText from '../scientific-text.ts';
import ThinkingDots from '../reader/thinking-dots.tsx';
import { EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import '../ui/tag.css';
import './viewer-notes.css';

const COLOR_NAMES: Record<HighlightColor, string> = { yellow: 'Yellow', teal: 'Teal', sky: 'Blue', violet: 'Violet', rose: 'Rose' };

type PassageEditorProps = {
  quote: string;
  error: string | null;
  initialNote: string;
  returnFocus: HTMLElement | null;
  anchor: { top: number; bottom: number; left: number; right: number };
  busy: boolean;
  sheet: boolean;
  /** With it, the editor switches between a note and a question for the AI. */
  ask?: { price: ReactNode; disabled: boolean; title?: string; onAsk: (question: string) => void };
  onSave: (note: string, color: HighlightColor) => void;
  onCancel: () => void;
};

export function PassageEditor({ quote, anchor, busy, error, initialNote, returnFocus, sheet, ask, onSave, onCancel }: PassageEditorProps) {
  const [draft, setDraft] = useState(initialNote);
  const [color, setColor] = useState<HighlightColor>('yellow');
  const [mode, setMode] = useState<'note' | 'ask'>('note');
  const asking = Boolean(ask) && mode === 'ask';
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
    if (busy) return;
    // An empty question asks the AI to explain the passage.
    if (asking) { if (!ask?.disabled) ask?.onAsk(note); }
    else onSave(note, color);
  };
  const virtual = useMemo(() => ({
    getBoundingClientRect: () => DOMRect.fromRect({ x: anchor.left, y: anchor.top, width: anchor.right - anchor.left, height: anchor.bottom - anchor.top }),
  }), [anchor]);
  const form = (
    <form onSubmit={submit}>
      <label htmlFor={noteId} className="visually-hidden">{asking ? 'Question for the AI (optional)' : 'Note (optional)'}</label>
      <Textarea
        id={noteId}
        ref={mountField}
        rows={1}
        className="vn-pop-input"
        value={draft}
        maxLength={MAX_NOTE_LENGTH}
        placeholder={ask ? 'Ask AI a question, or save a note.' : 'Add a note (optional)'}
        aria-describedby={error ? errorId : undefined}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !sheet) submit(event); }}
      />
      {error && <p id={errorId} className="vn-pop-error">{error}</p>}
      <div className="vn-pop-bar">
        {ask && (
          <Tabs value={mode} onValueChange={(next) => { setMode(next === 'ask' ? 'ask' : 'note'); field.current?.focus(); }} className="vn-pop-modes">
            <TabsList variant="pill" aria-label="Note or question">
              <TabsTrigger value="ask" className="vn-pop-mode">Ask AI</TabsTrigger>
              <TabsTrigger value="note" className="vn-pop-mode">Note</TabsTrigger>
            </TabsList>
          </Tabs>
        )}
        <div className="vn-pop-actions">
        {/* The day's AI uses, beside the button that spends one. */}
        {asking && ask?.price && (
          <span className="rd-tag rd-tag--ai rd-uses" title={ask.title}>
            <Sparkle size={12} aria-hidden="true" />
            {ask.price}
          </span>
        )}
        {!asking && (
        <fieldset className="vn-swatches">
          <legend className="visually-hidden">Highlight colour</legend>
          {HIGHLIGHT_COLORS.map(option => (
            <label key={option} className="vn-swatch" data-color={option} title={COLOR_NAMES[option]}>
              <input type="radio" name={`${noteId}-color`} value={option} checked={color === option} onChange={() => setColor(option)} />
              <span className="visually-hidden">{COLOR_NAMES[option]}</span>
            </label>
          ))}
        </fieldset>
        )}
        {asking
          ? (
            <Button type="submit" size="icon-sm" className="vn-pop-send" disabled={busy || ask?.disabled} focusableWhenDisabled aria-label={note ? 'Ask AI' : 'Explain this passage'} title={ask?.title ?? (note ? 'Ask (Enter)' : 'Explain (Enter)')}>
              <ChatCircleDots size={16} aria-hidden="true" />
            </Button>
          )
          : sheet
            ? <Button type="submit" disabled={busy}>{note ? 'Save note' : 'Highlight'}</Button>
            : (
              <Button type="submit" size="icon-sm" className="vn-pop-send" disabled={busy} aria-label={note ? 'Save highlight with note' : 'Save highlight'} title="Save (Enter)">
                <Highlighter size={16} aria-hidden="true" />
              </Button>
            )}
        </div>
      </div>
    </form>
  );
  if (sheet) {
    return (
      <Drawer open onOpenChange={(next) => { if (!next) onCancel(); }}>
        <DrawerContent className="vn-sheet" overlayClassName="vn-sheet-backdrop" forceOverlay viewportClassName="vn-sheet-viewport" finalFocus={() => returnFocus ?? true}>
          <DrawerHandle />
          <DrawerTitle render={<h2 />} className="visually-hidden">Highlight this passage</DrawerTitle>
          <DrawerDescription render={<blockquote />} className="vn-quote vn-sheet-quote" data-color={color}>{quote}</DrawerDescription>
          {form}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    // A press on a passage handle adjusts the passage; it is not a press outside the editor.
    <Popover open onOpenChange={(next, details) => { if (!next && !(details.event?.target instanceof Element && details.event.target.closest('.vn-handle'))) onCancel(); }}>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner anchor={virtual} side="bottom" align="start" sideOffset={8} collisionPadding={10} className="vn-pop-positioner">
          <PopoverPrimitive.Popup className="vn-pop" data-ask={ask ? '' : undefined} aria-label="Highlight this passage" initialFocus={field} finalFocus={() => returnFocus ?? true}>
            <PopoverPrimitive.Description className="visually-hidden">{quote}</PopoverPrimitive.Description>
            {form}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}

export function NotesSidebar({ id, open, passages, active = null, withAi = false, thinking = null, onGoTo, onRemove, onClose }: {
  id: string;
  open: boolean;
  passages: PassageAnnotation[];
  active?: string | null;
  withAi?: boolean;
  thinking?: { at: number; label: string } | null;
  onGoTo?: (passage: PassageAnnotation) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const list = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<'all' | 'ai'>('all');
  const aiOnly = withAi && view === 'ai';
  const shown = aiOnly ? passages.filter(passage => passage.kind === 'ai') : passages;
  const aiCount = withAi ? passages.filter(passage => passage.kind === 'ai').length : 0;
  // Focus moves to the next entry's delete, else the previous, else the title. Found by id:
  // an entry still playing its exit is in the DOM, so a count of rows would land on it.
  const remove = (index: number) => {
    const next = shown[index + 1] ?? shown[index - 1];
    (next
      ? list.current?.querySelector<HTMLElement>(`[data-passage-id="${CSS.escape(next.id)}"] .vn-delete`)
      : list.current?.querySelector<HTMLElement>('.vn-side-title'))?.focus();
    onRemove(shown[index].id);
  };
  const reduceMotion = useReducedMotion();
  // An entry opens and closes its height, so the list never jumps. Overflow is clipped only
  // while it moves, so a focus ring at the edge of a settled entry is not cut off.
  const row = {
    initial: { height: 0, opacity: 0, overflow: 'hidden' },
    animate: { height: 'auto', opacity: 1, transitionEnd: { overflow: 'visible' } },
    exit: { height: 0, opacity: 0, overflow: 'hidden', pointerEvents: 'none' },
    transition: reduceMotion ? { duration: 0 } : { duration: MOTION_BASE_S, ease: EASE_OUT },
  };
  useEffect(() => {
    if (open && active) list.current?.querySelector(`[data-passage-id="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);
  const waiting = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (thinking) waiting.current?.scrollIntoView({ block: 'nearest' });
  }, [thinking]);
  const items = shown.map((passage, index) => (
    <motion.li key={passage.id} data-passage-id={passage.id} aria-current={passage.id === active || undefined} {...row}>
      <div className="vn-item" data-active={passage.id === active ? '' : undefined}>
        <div className="vn-entry">
          <blockquote className="vn-quote" data-color={highlightColor(passage)} lang={passage.language}>
            {onGoTo
              ? <button type="button" className="vn-goto" title="Go to the passage" onClick={() => onGoTo(passage)}><ScientificText>{passageQuote(passage)}</ScientificText></button>
              : <ScientificText>{passageQuote(passage)}</ScientificText>}
          </blockquote>
          <Button variant="ghost" size="icon-sm" className="vn-delete" aria-label={`Delete highlight “${passage.quote}”`} title="Delete" onClick={() => remove(index)}>
            <Trash size={15} aria-hidden="true" />
          </Button>
        </div>
        {passage.note && (
          <p className="vn-note" lang={passage.kind === 'ai' ? passage.language : undefined}>
            {passage.kind === 'ai' && <span className="visually-hidden">AI: </span>}
            {passage.note}
          </p>
        )}
      </div>
    </motion.li>
  ));
  if (thinking) {
    const at = aiOnly ? passages.slice(0, thinking.at).filter(passage => passage.kind === 'ai').length : thinking.at;
    items.splice(Math.max(0, Math.min(at, items.length)), 0, (
      <li key="thinking" ref={waiting} className="vn-item vn-thinking" role="status">
        <ThinkingDots />
        {thinking.label}
      </li>
    ));
  }
  const close = (
    <Button variant="ghost" size="icon-sm" aria-label="Close notes" title="Close" onClick={onClose}>
      <X size={16} aria-hidden="true" />
    </Button>
  );
  // The list stays mounted even when empty, so the first entry still animates in and the last out.
  const body = (
    <>
      <ul className="vn-list"><AnimatePresence initial={false}>{items}</AnimatePresence></ul>
      {items.length === 0 && !aiOnly && <p className="vn-empty">Select text in the paper to highlight it or add a note.</p>}
    </>
  );
  return (
    <aside id={id} className="vn-side" data-hidden={open ? undefined : ''} inert={!open} aria-labelledby={`${id}-title`} ref={list}>
      {withAi ? (
        <Tabs value={view} onValueChange={next => setView(next === 'ai' ? 'ai' : 'all')} className="vn-tabs">
          <div className="vn-side-head">
            <h2 id={`${id}-title`} className="vn-side-title visually-hidden" tabIndex={-1}>Notes</h2>
            <TabsList variant="pill" className="vn-views" aria-label="Note views">
              <TabsTrigger value="all" className="vn-view">Notes <span className="vn-count">{passages.length}</span></TabsTrigger>
              <TabsTrigger value="ai" className="vn-view"><Sparkle size={13} aria-hidden="true" />AI <span className="vn-count">{aiCount}</span></TabsTrigger>
            </TabsList>
            {close}
          </div>
          <TabsContent value="all">{body}</TabsContent>
          <TabsContent value="ai">{body}</TabsContent>
        </Tabs>
      ) : (
        <>
          <div className="vn-side-head">
            <h2 id={`${id}-title`} className="vn-side-title" tabIndex={-1}>Notes <span className="vn-count">{passages.length}</span></h2>
            {close}
          </div>
          {body}
        </>
      )}
    </aside>
  );
}
