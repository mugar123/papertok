import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, Highlighter, Loader2, PenLine, Settings2, Sparkles, X } from 'lucide-react';
import { MAX_NOTE_LENGTH } from '../../services/userHighlightService.js';
import { measureKeyboardGap } from '../../utils/keyboardGap.js';
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
  tappedMark, onRemoveMark, onDismissMark,
  annotationCount, onOpenList, onOpenSettings,
  streaming, asking, askError, visible,
}) {
  const prefersReducedMotion = useReducedMotion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [keyboardGap, setKeyboardGap] = useState(0);

  // A live selection outranks a previously tapped mark: whatever the reader
  // just selected is the newer intention, and `PaperReader` clears the tap
  // on scroll the same way it dismisses a selection.
  const state = composing ? 'composing' : pending ? 'selection' : tappedMark ? 'mark' : 'rest';

  // `.rd-bar` is `position: fixed`, which anchors against the *layout*
  // viewport — and on iOS Safari a bottom-anchored fixed element does not
  // move when the on-screen keyboard opens, so it sits right where the
  // keyboard now covers it. The composer's textarea below is `autoFocus`, so
  // this is not a rare case: the very first frame of `composing` already
  // raises the keyboard.
  //
  // `visualViewport` is the layer that actually knows the keyboard is there;
  // `measureKeyboardGap` (a pure function, tested on its own in
  // `keyboardGap.test.js`) turns its numbers into how far to lift the bar.
  // Read on `resize` (the keyboard opening or closing) and `scroll` (iOS pans
  // the visual viewport, e.g. to keep the focused field above the keyboard,
  // independently of a resize).
  //
  // Scoped to `composing`, not the component's whole lifetime: nothing else
  // on this bar focuses an input, so outside `composing` there is no keyboard
  // to correct for — and a live measurement there would only pick up
  // unrelated visual-viewport noise (the mobile browser's own address-bar
  // hide/show on scroll being the concrete case) as a false, confusing shift.
  // Gating this way also fixes a real bug rather than just narrowing where it
  // could show: saving a note clears `pending` before iOS gets around to
  // firing the one, late `resize` event for the keyboard closing, so without
  // this the bar would collapse to its 56px rest row *before* the keyboard
  // had visually finished closing — the tall gap still applied, hanging the
  // short row in the middle of the screen until that late event finally
  // zeroed it. Leaving `composing` now tears this effect down immediately:
  // the cleanup below removes the listeners *and* zeroes the gap in the same
  // pass, so the bar returns to its resting position the instant the state
  // does, not whenever iOS separately says the keyboard animation is done.
  //
  // No `visualViewport`, no correction: a bar covered by the keyboard on an
  // old browser is a known, boring failure; a bar guessed into place by a
  // heuristic without the real signal would be a new, worse one.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || state !== 'composing') return undefined;

    const measure = () => {
      setKeyboardGap(measureKeyboardGap({
        innerHeight: window.innerHeight,
        viewportHeight: viewport.height,
        viewportOffsetTop: viewport.offsetTop,
      }));
    };

    measure();
    viewport.addEventListener('resize', measure);
    viewport.addEventListener('scroll', measure);
    // The reset lives in the cleanup, not as a separate branch above that
    // fires `setKeyboardGap(0)` on every non-composing render: that shape is
    // the "derived state written back in an effect" anti-pattern (and the
    // lint rule for it agrees). Here it is a real teardown instead — when
    // `composing` ends, this cleanup runs before the next effect body does,
    // zeroing the gap in the same pass rather than waiting for whatever the
    // platform's own keyboard-closing event happens to report last.
    return () => {
      viewport.removeEventListener('resize', measure);
      viewport.removeEventListener('scroll', measure);
      setKeyboardGap(0);
    };
  }, [state]);

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
        // Escape leaves whatever the bar is currently about: a tapped mark
        // has its own way out, everything else discards the selection.
        if (state === 'mark') onDismissMark();
        else onClose();
      }
    };
    // Capture, matching `SelectionMenu`: the two never coexist (one pointer
    // type routes to one or the other), but capturing keeps the same
    // Escape-handling shape in both places rather than one bubbling and one
    // not for no reason tied to this bar itself.
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, onClose, onDismissMark]);

  const submit = (event) => {
    event.preventDefault();
    const note = draft.trim();
    if (note) onSaveNote(note);
  };

  return (
    <motion.div
      className="rd-bar"
      data-state={state}
      // A custom property, not a second `animate` field: framer already owns
      // `y` for the rest/shown slide, as a transform. `bottom` is a plain
      // style the browser recomputes on every `visualViewport` tick without
      // fighting that transform — the two compose (slide, then lift) instead
      // of one clobbering the other's timeline.
      //
      // That composition has one hazard for whoever wires scroll auto-hide
      // next: `y: '110%'` below hides the bar by translating it by its own
      // height — a distance measured off wherever `bottom` currently puts it,
      // not off the screen edge. That is exactly why `110%` and not a fixed
      // pixel figure clears the bar today at any `--rd-bar-h`. But it also
      // means `110%` only clears the *screen* while `bottom` sits at its
      // normal small offset (`--space-3` plus insets): a nonzero
      // `--rd-bar-keyboard-gap` at hide time would park a "hidden" bar that
      // many pixels up, in view. Harmless right now only because the gap is
      // scoped to `composing` below and nothing currently hides the bar while
      // composing — a future auto-hide that can fire during `composing` needs
      // to either force the gap to 0 first or hide by a taller distance.
      //
      // Scroll auto-hide (`visible`, driven by `useBarScrollVisibility` in
      // `PaperReader.jsx`) landed without touching either side of that
      // trade, but not because anything upstream keeps `visible` correct
      // during `'selection'`/`'composing'` — it does not. `PaperReader.jsx`
      // freezes the scroll listener while `annotations.pending` is truthy,
      // but freezing only stops `visible` from *changing*; it does not force
      // it back to `true`. Scroll down until `visible` is `false`, then
      // start a selection: `visible` is still `false` at that instant, and
      // the bar is on screen for exactly one reason — the `state !== 'rest'`
      // term right below overrides it. That term is the *sole* structural
      // guarantee that the bar cannot render hidden outside `'rest'`, and
      // therefore also the sole reason the keyboard-gap hazard above stays
      // hypothetical (composing has a nonzero gap, and composing is
      // `state !== 'rest'`, so hiding is unreachable there regardless of
      // `visible` or of anything the freeze does or doesn't do). Do not
      // delete this term on the theory that the freeze already covers it —
      // it does not, and this is the line that would have to reappear.
      // The freeze upstream serves a real but different purpose: it is not
      // about the bar's on-screen state (that is entirely `state !== 'rest'`
      // above), it is about not letting `visible` itself drift while nobody
      // is watching. `useBarScrollVisibility` in `PaperReader.jsx` always
      // tracks scroll *position* (`previousTop`) unconditionally, freeze or
      // not — what the freeze actually gates is the call into
      // `nextBarVisibility`, which also reads the *current* `visible` as an
      // input (the tremor-holding branch: "no strong signal, keep whatever
      // it already was"). Without the freeze, a scroll that happens to occur
      // while `state` isn't `'rest'` (e.g. the touch route's own
      // scroll-dismisses-the-selection behaviour — see `onScroll` in
      // `PaperReader.jsx`) could flip `visible` to `false` for reasons that
      // have nothing to do with the reader's own downward-scroll intent, and
      // that wrong value would then seed every tremor-holding decision after
      // the freeze lifts. Freezing keeps `visible` an honest record of
      // genuine reading-scroll direction; it does not, on its own, keep the
      // bar *visible* right now — `state !== 'rest'` above is what does that.
      style={{ '--rd-bar-keyboard-gap': `${keyboardGap}px` }}
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

          {/* The one slot that earns permanent visibility: a level rewrite
              streaming, or "Que me lo explique" working, or having failed, are
              the things worth knowing about from behind the settings button.
              On touch the sheet holding `AnnotationRail` sits fully off-screen
              with no peek (unlike the desktop rail), so this is the only place
              left that could show them at all — without it, asking gives no
              sign of working, and a failure lands in a surface nobody is
              looking at, then gets silently wiped by the next scroll's
              `dismiss()`.

              Priority order matters because, unlike `asking` and `askError`
              (never simultaneously true — `ask()` resets `busy` to idle before
              it ever sets `error`), `streaming` and `askError` genuinely can
              overlap: asking can fail, then the reader can separately start a
              level rewrite while that stale error is still on screen. The
              rewrite — the document you are currently reading changing under
              you — wins that case; a leftover error about a passed action
              would otherwise hide it. */}
          {streaming ? (
            <span className="rd-bar-streaming">
              <ThinkingDots />
              {copy.writing}
            </span>
          ) : askError ? (
            <span className="rd-bar-error" role="alert">
              <AlertCircle size={14} />
              {askError}
            </span>
          ) : asking && (
            <span className="rd-bar-streaming">
              <ThinkingDots />
              {copy.reading}
            </span>
          )}

          {/* `onOpenSettings` is always provided today — every device that
              reaches this bar also gets a sheet with a settings tab to open
              (`railIsSheet` in `PaperReader.jsx`). Still guarded rather than
              called unconditionally: absent, not disabled, is the honest
              version of "nowhere for it to lead" for whatever future route
              might not have one — a button with no `onClick` is a dead end. */}
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

      {state === 'mark' && (
        <div className="rd-bar-row" data-row="mark">
          <button type="button" className="rd-bar-action" onClick={onRemoveMark}>
            <Highlighter size={16} />
            {/* Honest about scope: a mark that carries a note loses the note
                with it, and the label says so before the tap, not after. */}
            <span>{tappedMark?.note ? copy.removeHighlightNote : copy.removeHighlight}</span>
          </button>
          <button
            type="button"
            className="rd-bar-dismiss"
            onClick={onDismissMark}
            aria-label={copy.dismissSelection}
            title={copy.dismissSelection}
          >
            <X size={16} />
          </button>
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
