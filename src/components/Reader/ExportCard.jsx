import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, Download, FileText, Info, X } from 'lucide-react';

/**
 * What leaves the reader, and what goes with it.
 *
 * Grows out of the panel it was opened from rather than arriving as a second
 * modal over the first: the reader is already a dialog, and a scrim on top of a
 * scrim reads as being two steps away from the paper instead of one.
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
  onClose,
  fileNames,
  stamp,
  busy = false,
}) {
  const prefersReducedMotion = useReducedMotion();
  const rootRef = useRef(null);
  const [justSaved, setJustSaved] = useState(false);
  // PDF first: it opens everywhere, and the .tex stays one tap away for
  // whoever has a TeX toolchain and wants the compilable source.
  const [format, setFormat] = useState('pdf');

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const onPointer = (event) => {
      if (!rootRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onPointer, true);
    };
  }, [onClose]);

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
    <motion.div
      ref={rootRef}
      className="rd-export"
      role="dialog"
      aria-label={copy.download}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={prefersReducedMotion
        ? { opacity: 0, transition: { duration: 0.1 } }
        : { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.16, ease: 'easeIn' } }}
      transition={{ duration: prefersReducedMotion ? 0.12 : 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="rd-export-head">
        <span className="rd-export-title">{copy.download}</span>
        <span className="rd-export-stamp">{stamp}</span>
        <button type="button" className="rd-export-close" onClick={onClose} aria-label={copy.cancel}>
          <X size={15} />
        </button>
      </div>

      <div className="rd-export-body">
        <div className="rd-export-choices">
          <span className="rd-export-label">{copy.whatGoes}</span>
          {OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className="rd-export-option"
              onClick={() => onToggle(option.id)}
              aria-pressed={include[option.id]}
              disabled={counts[option.countKey] === 0}
            >
              <span className="rd-export-box" data-on={include[option.id] ? '' : undefined}>
                <Check size={9} strokeWidth={3.5} />
              </span>
              <span>
                <span className="rd-export-option-label">{copy.options[option.id]}</span>
                <span className="rd-export-option-note">
                  {counts[option.countKey] === 0
                    ? copy.noneOfThese
                    : copy.optionCount(option.id, counts[option.countKey])}
                </span>
              </span>
            </button>
          ))}

          <div className="rd-export-format" role="radiogroup" aria-label={copy.format}>
            <span className="rd-export-label">{copy.format}</span>
            <div className="rd-export-format-chips">
              {FORMATS.map(option => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={format === option.id}
                  className="rd-export-format-chip"
                  data-on={format === option.id ? '' : undefined}
                  onClick={() => setFormat(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
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
        <button type="button" className="rd-export-cancel" onClick={onClose}>{copy.cancel}</button>
        <button type="button" className="rd-export-go" onClick={handleDownload} disabled={busy}>
          {justSaved ? <Check size={14} /> : <Download size={14} />}
          {busy
            ? copy.generating
            : justSaved
              ? copy.downloaded
              : format === 'pdf' ? copy.downloadPdf : copy.downloadTex}
        </button>
      </div>
    </motion.div>
  );
}
