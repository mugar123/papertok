import { useEffect, useImperativeHandle, useMemo, useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/FeedContext';
import { ArrowSquareOut, X } from '@phosphor-icons/react';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.jsx';
import './PDFViewer.css';
import { safeDoiUrl } from '../../utils/externalUrl.js';
import { pdfLinksForPaper } from '../../utils/paperOpenTargets.js';

/**
 * A full-screen Base UI Dialog (ui/dialog.jsx). App.jsx mounts the viewer and
 * unmounts it on `onClose`, so the viewer owns its open state: closing flips
 * it, the primitive plays the exit in PDFViewer.css, and the parent is told
 * from `onOpenChangeComplete(false)` once that has finished. The primitive
 * also owns what the old overlay did by hand — the focus trap, Escape, the
 * scroll lock and the restore to the button that opened it.
 */
export default function PDFViewer({ paper, onClose, closeRef = null }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [open, setOpen] = useState(true);

  // Que exista un PDF y que se pueda enmarcar son dos preguntas distintas, y
  // fundirlas hacía que el visor negara un PDF que tenía delante. `fullTextUrl`
  // es el que hay; `pdfUrl`, el que además admite el iframe.
  const { fullTextUrl, embedUrl: pdfUrl } = pdfLinksForPaper(paper);

  // The embedded route is a desktop privilege. Framed PDFs are crippled on
  // every touch platform: iOS Safari paints only the FIRST page of a PDF
  // inside an iframe and refuses to scroll it (reported from a real iPhone,
  // 2026-08-29), and Android Chrome does not render framed PDFs at all. On a
  // coarse pointer the viewer hands off to the browser's own full viewer in
  // a new tab, where paging actually works, instead of pretending.
  const coarsePointer = useMemo(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }, []);
  const canEmbed = Boolean(pdfUrl) && !coarsePointer;

  const { trackPdfBounce } = useFeed();
  const startTimeRef = useRef(null);

  // Every way out — the X, Escape — lands here, so the bounce is counted
  // once, whichever it was.
  const handleClose = useCallback(() => {
    if (!open) return;
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    if (elapsed < 5) {
      trackPdfBounce(paper);
    }
    setOpen(false);
  }, [open, paper, trackPdfBounce]);

  useEffect(() => {
    startTimeRef.current = Date.now();
  }, []);

  /**
   * The same way out, published for the browser's Back button: the owner arms
   * `useOverlayHistory` with whatever this ref holds, so Back counts the
   * bounce and plays the leave exactly as the X does, instead of unmounting
   * this node with `open` still true (useOverlayHistory.js).
   */
  useImperativeHandle(closeRef, () => handleClose, [handleClose]);

  // Apunta a lo que el lector está viendo cuando hay iframe, y al PDF que no
  // cabe en él cuando no lo hay.
  const externalUrl = pdfUrl
    || fullTextUrl
    || safeDoiUrl(paper.doi)
    || (/^[A-Z]\d+$/i.test(String(paper.id || '')) ? `https://openalex.org/${paper.id}` : '');
  const shouldShowFallback = !pdfUrl || showFallback;

  // The machine voice under the title: the same honest identity the cards and
  // the comments ledger print. Nothing is invented — a paper with neither an
  // arXiv id nor a DOI simply has no identity line.
  const paperIdentity = paper.arxivId
    ? `arxiv:${paper.arxivId}`
    : paper.doi ? `doi:${paper.doi}` : '';
  const identityLine = paperIdentity
    ? `${paperIdentity}${pdfUrl ? ' · PDF' : ''}`
    : '';

  // Fallback timeout
  useEffect(() => {
    if (!pdfUrl) return undefined;
    const fallbackTimer = setTimeout(() => {
      if (!iframeLoaded) setShowFallback(true);
    }, 8000);

    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [iframeLoaded, pdfUrl]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) handleClose(); }}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onClose(); }}
    >
      <DialogContent
        className="pdf-overlay"
        overlayClassName="pdf-scrim"
        showClose={false}
        closeLabel={'Close PDF'}
        aria-label={'PDF viewer'}
      >
        <div className="pdf-viewer">
          {/* Top bar */}
          <div className="pdf-topbar glass-strong">
            <DialogClose className="pdf-close-btn" aria-label={'Close PDF'} title={'Close'}>
              <X size={20} aria-hidden="true" />
            </DialogClose>

            <div className="pdf-heading">
              <h3 className="pdf-title">{paper.title}</h3>
              {identityLine && <span className="pdf-identity">{identityLine}</span>}
            </div>

            {externalUrl && <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="pdf-external-btn"
            >
              <ArrowSquareOut size={16} aria-hidden="true" />
              <span>{'New tab'}</span>
            </a>}
          </div>

          {/* Loading indicator */}
          {canEmbed && !iframeLoaded && !showFallback && (
            <div className="pdf-loading">
              <div className="pdf-loading-spinner" />
              <p>{'Loading PDF...'}</p>
            </div>
          )}

          {/* Touch hand-off: the full PDF, in the one viewer that can page it */}
          {pdfUrl && coarsePointer && (
            <div className="pdf-fallback pdf-handoff">
              <p>{'On a phone, the embedded viewer can only show the first page — the full PDF opens in its own tab.'}</p>
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                {'Open the full PDF →'}
              </a>
            </div>
          )}

          {/* Fallback message. On touch it still owns the no-PDF case — the
              hand-off card above only ever replaces it when there IS a PDF to
              hand off. */}
          {shouldShowFallback && !(coarsePointer && pdfUrl) && !iframeLoaded && (
            <div className="pdf-fallback">
              <p>{!fullTextUrl
                ? ('No open-access PDF is available.')
                : !pdfUrl
                  ? ('This PDF is hosted somewhere that refuses to be embedded — it opens in its own tab.')
                  : ('The PDF could not be loaded in the app.')}</p>
              {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                {fullTextUrl
                  ? ('Open the full PDF →')
                  : ('Open original source in a new tab →')}
              </a>}
            </div>
          )}

          {/* PDF iframe */}
          {canEmbed && <iframe
            src={pdfUrl}
            className={`pdf-iframe ${iframeLoaded ? 'pdf-iframe--loaded' : ''}`}
            title={`PDF: ${paper.title}`}
            referrerPolicy="no-referrer"
            onLoad={() => setIframeLoaded(true)}
          />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
