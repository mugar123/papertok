import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
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
export default function PDFViewer({ paper, onClose }) {
  const { isEnglish } = useLanguage();
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
        closeLabel={isEnglish ? 'Close PDF' : 'Cerrar PDF'}
        aria-label={isEnglish ? 'PDF viewer' : 'Visor de PDF'}
      >
        <div className="pdf-viewer">
          {/* Top bar */}
          <div className="pdf-topbar glass-strong">
            <DialogClose className="pdf-close-btn" aria-label={isEnglish ? 'Close PDF' : 'Cerrar PDF'} title={isEnglish ? 'Close' : 'Cerrar'}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <span>{isEnglish ? 'New tab' : 'Nueva pestaña'}</span>
            </a>}
          </div>

          {/* Loading indicator */}
          {canEmbed && !iframeLoaded && !showFallback && (
            <div className="pdf-loading">
              <div className="pdf-loading-spinner" />
              <p>{isEnglish ? 'Loading PDF...' : 'Cargando PDF...'}</p>
            </div>
          )}

          {/* Touch hand-off: the full PDF, in the one viewer that can page it */}
          {pdfUrl && coarsePointer && (
            <div className="pdf-fallback pdf-handoff">
              <p>{isEnglish
                ? 'On a phone, the embedded viewer can only show the first page — the full PDF opens in its own tab.'
                : 'En el móvil, el visor embebido solo puede enseñar la primera página: el PDF completo se abre en su propia pestaña.'}</p>
              <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                {isEnglish ? 'Open the full PDF →' : 'Abrir el PDF completo →'}
              </a>
            </div>
          )}

          {/* Fallback message. On touch it still owns the no-PDF case — the
              hand-off card above only ever replaces it when there IS a PDF to
              hand off. */}
          {shouldShowFallback && !(coarsePointer && pdfUrl) && !iframeLoaded && (
            <div className="pdf-fallback">
              <p>{!fullTextUrl
                ? (isEnglish ? 'No open-access PDF is available.' : 'No hay PDF de acceso abierto disponible.')
                : !pdfUrl
                  ? (isEnglish
                    ? 'This PDF is hosted somewhere that refuses to be embedded — it opens in its own tab.'
                    : 'Este PDF está alojado donde no se deja enmarcar: se abre en su propia pestaña.')
                  : (isEnglish ? 'The PDF could not be loaded in the app.' : 'El PDF no pudo cargarse en la app.')}</p>
              {externalUrl && <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                {fullTextUrl
                  ? (isEnglish ? 'Open the full PDF →' : 'Abrir el PDF completo →')
                  : (isEnglish ? 'Open original source in a new tab →' : 'Abrir fuente original en nueva pestaña →')}
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
