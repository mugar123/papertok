import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Download, FileText, Info, X } from 'lucide-react';
import { Checkbox } from '../ui/checkbox.jsx';
import { Label } from '../ui/label.jsx';
import { PopoverClose, PopoverContent } from '../ui/popover.jsx';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group.jsx';

/**
 * What leaves the reader, and what goes with it.
 *
 * Grows out of the panel it was opened from rather than arriving as a second
 * modal over the first: the reader is already a dialog, and a scrim on top of a
 * scrim reads as being two steps away from the paper instead of one. It is the
 * content half of a Base UI Popover whose root and trigger live in
 * `PaperReader.jsx` (the download button is the trigger, in the dock or in the
 * phone's bar): the primitive anchors it above that button, closes it on an
 * outside press or Escape, and hands focus back to the button after.
 *
 * The preview is a real page drawn small — the same marks, the same rule, the
 * same footnote block — because the whole question the reader is answering is
 * "what will the file look like", and an icon of a page cannot answer it.
 */

const OPTIONS = [
  { id: 'marks', countKey: 'marks' },
  { id: 'mine', countKey: 'mine' },
  { id: 'ai', countKey: 'ai' },
];

// Format names, not copy: "PDF" and "LaTeX" are the same words in both
// languages, and the filename line below already shows the extension.
const FORMATS = [
  { id: 'pdf', label: 'PDF' },
  { id: 'tex', label: 'LaTeX' },
];

const EASE_OUT = [0.16, 1, 0.3, 1];

export default function ExportCard({
  copy,
  counts,
  include,
  onToggle,
  onDownload,
  fileNames,
  stamp,
  busy = false,
}) {
  const [justSaved, setJustSaved] = useState(false);
  const prefersReducedMotion = useReducedMotion();
  // PDF first: it opens everywhere, and the .tex stays one tap away for
  // whoever has a TeX toolchain and wants the compilable source.
  const [format, setFormat] = useState('pdf');

  // A download the browser handles silently gives the reader nothing to see, so
  // the button says so itself for a moment. The card stays open: the usual next
  // thing is to change a switch and take it again. The PDF takes a moment to
  // rasterize, so the confirmation waits for it — and a failed generation
  // (offline, chunk missing) re-enables the button instead of lying "saved".
  const handleDownload = async () => {
    try {
      await onDownload(format);
      setJustSaved(true);
    } catch {
      /* The button coming back enabled is the whole message. */
    }
  };
  useEffect(() => {
    if (!justSaved) return undefined;
    const timer = setTimeout(() => setJustSaved(false), 2_200);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const anyNotes = (include.mine && counts.mine > 0) || (include.ai && counts.ai > 0);
  /* What the button is saying right now, as one value: it is both the label and
     the key `AnimatePresence` watches, and deriving them separately is how the
     two drift apart. */
  const phase = busy ? 'busy' : justSaved ? 'saved' : 'idle';

  return (
    <PopoverContent
      className="rd-export"
      aria-label={copy.download}
      side="top"
      align="center"
      sideOffset={10}
    >
      <div className="rd-export-head">
        <span className="rd-export-title">{copy.download}</span>
        <span className="rd-export-stamp">{stamp}</span>
        <PopoverClose className="rd-export-close" aria-label={copy.cancel}>
          <X size={15} />
        </PopoverClose>
      </div>

      <div className="rd-export-body">
        <div className="rd-export-choices">
          <span className="rd-export-label">{copy.whatGoes}</span>
          {OPTIONS.map(option => {
            const id = `rd-export-include-${option.id}`;
            const none = counts[option.countKey] === 0;
            return (
              /* The whole row is the label, so the whole row is the target;
                 the box inside it is the control that actually carries the
                 checked state to assistive technology. */
              <Label
                key={option.id}
                htmlFor={id}
                className="rd-export-option"
                data-disabled={none ? '' : undefined}
              >
                <Checkbox
                  id={id}
                  className="rd-export-box"
                  checked={Boolean(include[option.id])}
                  onCheckedChange={() => onToggle(option.id)}
                  disabled={none}
                />
                <span>
                  <span className="rd-export-option-label">{copy.options[option.id]}</span>
                  <span className="rd-export-option-note">
                    {none
                      ? copy.noneOfThese
                      : copy.optionCount(option.id, counts[option.countKey])}
                  </span>
                </span>
              </Label>
            );
          })}

          <div className="rd-export-format">
            <span className="rd-export-label" id="rd-export-format-label">{copy.format}</span>
            <RadioGroup
              className="rd-export-format-chips"
              value={format}
              onValueChange={(next) => { if (next) setFormat(next); }}
              aria-labelledby="rd-export-format-label"
            >
              {FORMATS.map(option => (
                <RadioGroupItem
                  key={option.id}
                  value={option.id}
                  nativeButton
                  render={<button type="button" className="rd-export-format-chip" />}
                >
                  {option.label}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </div>

          {/* Not a switch. A derivative of someone else's paper carries where it
              came from, or it does not leave. */}
          <p className="rd-export-always">
            <Info size={14} />
            {copy.alwaysIncluded}
          </p>
        </div>

        <div className="rd-export-preview">
          <div className="rd-export-sheet" aria-hidden="true">
            <p className="rd-export-sheet-mast">{copy.previewMasthead}</p>
            <span className="rd-export-sheet-mastrule" />
            <p className="rd-export-sheet-title">{copy.previewTitle}</p>
            <p className="rd-export-sheet-byline">{copy.previewByline}</p>
            <span className="rd-export-sheet-rule" />
            <div className="rd-export-sheet-notice">
              <b>{copy.previewNotice}</b>
              <span className="rd-export-sheet-notice-lines">
                <i /><i style={{ width: '76%' }} />
              </span>
            </div>
            <span className="rd-export-sheet-rule" />
            <p className="rd-export-sheet-section">1&nbsp;&nbsp;{copy.previewSection}</p>
            <p className="rd-export-sheet-origin">{copy.previewOrigin}</p>
            <div className="rd-export-sheet-lines">
              <i />
              <span className="rd-export-sheet-marked">
                <i data-on={include.marks && counts.marks > 0 ? '' : undefined} />
                {include.mine && counts.mine > 0 && <b />}
              </span>
              <i style={{ width: '72%' }} />
              <span style={{ height: 5 }} />
              <i />
              <span className="rd-export-sheet-marked">
                <i data-ai={include.ai && counts.ai > 0 ? '' : undefined} />
                {include.ai && counts.ai > 0 && <b />}
              </span>
              <i style={{ width: '61%' }} />
            </div>
            <span className="rd-export-sheet-gap" />
            {anyNotes && (
              <div className="rd-export-sheet-notes">
                <span className="rd-export-sheet-fnrule" />
                <i style={{ width: '94%' }} /><i style={{ width: '68%' }} />
              </div>
            )}
          </div>
          <p className="rd-export-preview-note">{copy.previewNote(format)}</p>
        </div>
      </div>

      <div className="rd-export-foot">
        <span className="rd-export-file"><FileText size={13} /> {fileNames[format]}</span>
        <PopoverClose className="rd-export-cancel">{copy.cancel}</PopoverClose>
        {/* Three states, handed over rather than cut between: the label that is
            leaving goes up and out before the next one arrives from below, so
            "Download PDF" → "Generating…" → "Downloaded" reads as one button
            working rather than as three that flicker in the same place.

            The three labels are three widths — 157px, 143px and 137px, measured
            — and a button that resizes under its own label drags the whole foot
            with it twice per download. So the button is sized by all three at
            once: the gauge below holds them stacked and invisible in the same
            grid cell the face animates in, which makes the box the width of the
            longest and leaves nothing to animate. (Motion's `layout` was the
            first answer here and it did not animate the width at all — three
            distinct widths across the whole run, measured the same way.) */}
        <button
          type="button"
          className="rd-export-go"
          onClick={handleDownload}
          disabled={busy}
        >
          <span className="rd-export-go-gauge" aria-hidden="true">
            {[format === 'pdf' ? copy.downloadPdf : copy.downloadTex, copy.generating, copy.downloaded]
              .map(label => (
                <span key={label} className="rd-export-go-face">
                  <Download size={14} />
                  {label}
                </span>
              ))}
          </span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={phase}
              className="rd-export-go-face"
              initial={prefersReducedMotion
                ? { opacity: 0 }
                : { opacity: 0, transform: 'translateY(4px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              exit={prefersReducedMotion
                ? { opacity: 0, transition: { duration: 0.1 } }
                : { opacity: 0, transform: 'translateY(-4px)', transition: { duration: 0.12, ease: EASE_OUT } }}
              transition={{ duration: prefersReducedMotion ? 0.1 : 0.16, ease: EASE_OUT }}
            >
              {phase === 'saved'
                ? (
                  /* The one moment worth an accent: the file exists now. A short
                     spring, because a check that fades in says nothing happened. */
                  <motion.span
                    className="rd-export-go-icon"
                    initial={prefersReducedMotion ? false : { transform: 'scale(0.6)' }}
                    animate={{ transform: 'scale(1)' }}
                    transition={{ type: 'spring', duration: 0.4, bounce: 0.25 }}
                  >
                    <Check size={14} />
                  </motion.span>
                )
                : <Download size={14} />}
              {phase === 'busy'
                ? copy.generating
                : phase === 'saved'
                  ? copy.downloaded
                  : format === 'pdf' ? copy.downloadPdf : copy.downloadTex}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
    </PopoverContent>
  );
}
