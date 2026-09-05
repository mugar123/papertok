import { useEffect, useState } from 'react';
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
            <p className="rd-export-sheet-title">{copy.previewTitle}</p>
            <p className="rd-export-sheet-byline">{copy.previewByline}</p>
            <div className="rd-export-sheet-abstract">
              <i /><i style={{ width: '84%' }} />
            </div>
            <span className="rd-export-sheet-rule" />
            <p className="rd-export-sheet-section">1&nbsp;&nbsp;{copy.previewSection}</p>
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
        <button type="button" className="rd-export-go" onClick={handleDownload} disabled={busy}>
          {justSaved ? <Check size={14} /> : <Download size={14} />}
          {busy
            ? copy.generating
            : justSaved
              ? copy.downloaded
              : format === 'pdf' ? copy.downloadPdf : copy.downloadTex}
        </button>
      </div>
    </PopoverContent>
  );
}
