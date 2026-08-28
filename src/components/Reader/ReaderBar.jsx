import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Highlighter, Loader2, PenLine, Settings2, Sparkles, X } from 'lucide-react';
import { MAX_NOTE_LENGTH } from '../../services/userHighlightService.js';
import ThinkingDots from './ThinkingDots.jsx';

/**
 * The island. One surface, three states, and it morphs in place rather than
 * letting a second surface rise: with the OS callout already on screen over the
 * passage, anything else sliding up is the pile-up this redesign exists to
 * remove. In rest it is the way into your annotations; with a live selection it
 * is what to do with it.
 *
 * Takes `pending` whole rather than an `anchor` rectangle: `SelectionMenu`
 * hangs a popover off the selection's own box, but a bar pinned to the bottom
 * edge positions against nothing — all it needs from a selection is whether one
 * is live, which is exactly what `pending` being non-null already says.
 */
export default function ReaderBar({
  pending, copy, usesLeft, unlimited, canAsk, busy,
  onHighlight, onSaveNote, onAsk, onClose,
  annotationCount, onOpenList, onOpenSettings,
  streaming, visible,
}) {
  const prefersReducedMotion = useReducedMotion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const state = composing ? 'composing' : pending ? 'selection' : 'rest';

  // Leaving the selection collapses the composer with it: a draft that outlives
  // the passage it was about has nothing left to attach to.
  if (!pending && composing) { setComposing(false); setDraft(''); }

  // `SelectionMenu` closes on Escape; this bar, its coarse-pointer
  // counterpart, did not — a gap on exactly the device this branch already
  // cares about, a coarse pointer with a keyboard attached (an iPad with a
  // case, a touchscreen laptop). Without this, `composing` had no key out.
  // Only wired while there is something to leave: in `rest` there is no
  // selection or draft for Escape to discard, and the bar itself is not a
  // dialog to dismiss.
  useEffect(() => {
    if (state === 'rest') return undefined;
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture, matching `SelectionMenu`: the two never coexist (one pointer
    // type routes to one or the other), but capturing keeps the same
    // Escape-handling shape in both places rather than one bubbling and one
    // not for no reason tied to this bar itself.
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, onClose]);

  const submit = (event) => {
    event.preventDefault();
    const note = draft.trim();
    if (note) onSaveNote(note);
  };

  return (
    <motion.div
      className="rd-bar"
      data-state={state}
      animate={{ y: visible || state !== 'rest' ? 0 : '110%' }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {state === 'rest' && (
        <div className="rd-bar-row" data-row="rest">
          <button
            type="button"
            className="rd-bar-icon-btn"
            onClick={onOpenList}
            aria-label={copy.toggleAnnotations}
            title={copy.toggleAnnotations}
          >
            <PenLine size={16} />
            <span className="rd-bar-count">{annotationCount}</span>
          </button>

          {/* The one control that earns permanent visibility: while a level
              rewrite is streaming, that is the single thing worth knowing about
              from behind the settings button. */}
          {streaming && (
            <span className="rd-bar-streaming">
              <ThinkingDots />
              {copy.writing}
            </span>
          )}

          {/* Absent, not disabled, where there is nowhere for it to lead: on a
              coarse pointer wide enough that the rail is a margin rather than a
              sheet, the dock already carries these controls and the rail has no
              settings tab to open (`PaperReader.jsx` only passes a handler where
              that tab exists). A button with no `onClick` is a dead end; not
              rendering it at all is the honest version of that. */}
          {onOpenSettings && (
            <button
              type="button"
              className="rd-bar-icon-btn"
              onClick={onOpenSettings}
              aria-label={copy.settings}
              title={copy.settings}
            >
              <Settings2 size={16} />
            </button>
          )}
        </div>
      )}

      {state === 'selection' && (
        <div className="rd-bar-row" data-row="selection">
          <button type="button" className="rd-bar-action" onClick={onHighlight}>
            <Highlighter size={16} />
            <span>{copy.justHighlight}</span>
          </button>
          <button type="button" className="rd-bar-action" onClick={() => setComposing(true)}>
            <PenLine size={16} />
            <span>{copy.writeNote}</span>
          </button>
          <button
            type="button"
            className="rd-bar-action"
            onClick={onAsk}
            disabled={!canAsk}
            title={canAsk ? undefined : copy.noUsesLeft}
          >
            <Sparkles size={16} />
            <span>{copy.explainThis}</span>
            {!unlimited && <small>{canAsk ? copy.oneUse : copy.noUsesLeftShort}</small>}
          </button>
          <button
            type="button"
            className="rd-bar-dismiss"
            onClick={onClose}
            aria-label={copy.dismissSelection}
            title={copy.dismissSelection}
          >
            <X size={16} />
          </button>
          {typeof usesLeft === 'number' && (
            <p className="rd-bar-foot">{copy.usesLeftLine(usesLeft)}</p>
          )}
        </div>
      )}

      {state === 'composing' && (
        <form className="rd-bar-compose" onSubmit={submit}>
          <span className="rd-bar-label">
            <PenLine size={12} />
            {copy.yourNote}
          </span>
          <textarea
            className="rd-bar-input"
            value={draft}
            maxLength={MAX_NOTE_LENGTH}
            placeholder={copy.notePlaceholder}
            onChange={(event) => setDraft(event.target.value)}
            autoFocus
          />
          <div className="rd-bar-actions">
            <button type="submit" className="rd-bar-save" disabled={!draft.trim() || busy}>
              {busy ? <Loader2 size={14} className="spinning" /> : null}
              {copy.save}
            </button>
            <button type="button" className="rd-bar-cancel" onClick={onClose}>{copy.cancel}</button>
          </div>
        </form>
      )}
    </motion.div>
  );
}
