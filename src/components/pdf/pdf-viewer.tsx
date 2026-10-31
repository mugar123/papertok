import type { Ref } from 'react';
import type { Paper } from '../../models/paper.ts';
import { lazy, Suspense, useEffect, useImperativeHandle, useMemo, useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/feed-context.tsx';
import { ArrowSquareOut, FilePdf, TextAlignLeft, X } from '@phosphor-icons/react';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import './pdf-viewer.css';
import { safeDoiUrl } from '../../utils/external-url.ts';
import { pdfLinksForPaper, pdfRelayUrl } from '../../utils/paper-open-targets.ts';
import { getFullText } from '../../services/full-text-service.ts';
import type { FullText } from '../../utils/full-text.ts';
import FullTextArticle from './full-text-article.tsx';
import ViewerLoading from './viewer-loading.tsx';

// pdf.js is about 1.8 MB with its worker, and only a touch screen draws pages
// itself: a desktop never downloads it.
const PdfPages = lazy(() => import('./pdf-pages.tsx'));
const PAPER_API_BASE_URL = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';

/**
 * A full-screen Base UI Dialog (ui/dialog.jsx). app.tsx mounts the viewer and
 * unmounts it on `onClose`, so the viewer owns its open state: closing flips
 * it, the primitive plays the exit in pdf-viewer.css, and the parent is told
 * from `onOpenChangeComplete(false)` once that has finished. The primitive
 * also owns what the old overlay did by hand — the focus trap, Escape, the
 * scroll lock and the restore to the button that opened it.
 */
export default function PDFViewer({ paper, onClose, closeRef = null }: { paper: Paper; onClose: () => void; closeRef?: Ref<() => void> | null }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [open, setOpen] = useState(true);
  // `undefined` while the Worker is asked for the paper's text, `null` when no
  // provider publishes it as text: then the viewer is the PDF viewer it was.
  const [fullText, setFullText] = useState<FullText | null | undefined>(undefined);
  const [view, setView] = useState<'text' | 'pdf'>('text');
  const showsText = Boolean(fullText) && view === 'text';
  const showsPdf = fullText === null || view === 'pdf';

  useEffect(() => {
    const controller = new AbortController();
    void getFullText(paper, controller.signal).then(doc => {
      if (!controller.signal.aborted) setFullText(doc);
    });
    return () => controller.abort();
  }, [paper]);

  // Que exista un PDF y que se pueda enmarcar son dos preguntas distintas, y
  // fundirlas hacía que el visor negara un PDF que tenía delante. `fullTextUrl`
  // es el que hay; `pdfUrl`, el que además admite el iframe.
  const { fullTextUrl, embedUrl: pdfUrl, relaySourceUrl } = pdfLinksForPaper(paper);

  // The embedded route is a desktop privilege. Framed PDFs are crippled on
  // every touch platform: iOS Safari paints only the FIRST page of a PDF
  // inside an iframe and refuses to scroll it (reported from a real iPhone,
  // 2026-08-29), and Android Chrome does not render framed PDFs at all. On a
  // coarse pointer the viewer draws the pages itself with pdf.js instead
  // (pdf-pages.tsx), from the Worker's relay — arXiv and Europe PMC send no
  // CORS headers — so a phone reads the paper inside PaperTok, as a desktop
  // does (2026-10-09). A PDF the relay does not take, or one it fails to
  // deliver, still gets the hand-off to the browser's own viewer.
  const coarsePointer = useMemo(() => {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
  }, []);
  const canEmbed = Boolean(pdfUrl) && !coarsePointer && showsPdf;
  const relayUrl = coarsePointer && showsPdf ? pdfRelayUrl(relaySourceUrl, PAPER_API_BASE_URL) : '';
  const [relayFailed, setRelayFailed] = useState(false);
  const drawsPages = Boolean(relayUrl) && !relayFailed;
  const handleRelayUnavailable = useCallback(() => setRelayFailed(true), []);
  // A PDF opened again starts loading again: the iframe is remounted.
  const showPdf = () => {
    setIframeLoaded(false);
    setShowFallback(false);
    setView('pdf');
  };

  const { trackPdfBounce } = useFeed();
  const startTimeRef = useRef<number | null>(null);

  // Every way out — the X, Escape — lands here, so the bounce is counted
  // once, whichever it was.
  const handleClose = useCallback(() => {
    if (!open) return;
    const elapsed = (Date.now() - startTimeRef.current!) / 1000;
    if (elapsed < 5) {
      void trackPdfBounce(paper);
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
   * this node with `open` still true (use-overlay-history.ts).
   */
  useImperativeHandle(closeRef, () => handleClose, [handleClose]);

  // Apunta a lo que el lector está viendo cuando hay iframe, y al PDF que no
  // cabe en él cuando no lo hay.
  const externalUrl = pdfUrl
    || fullTextUrl
    || safeDoiUrl(paper.doi)
    || (/^[A-Z]\d+$/i.test(String(paper.id || '')) ? `https://openalex.org/${paper.id}` : '');
  const shouldShowFallback = showsPdf && (!pdfUrl || showFallback);

  // The machine voice under the title: the same honest identity the cards
  // print. Nothing is invented — a paper with neither an
  // arXiv id nor a DOI simply has no identity line.
  const paperIdentity = paper.arxivId
    ? `arxiv:${paper.arxivId}`
    : paper.doi ? `doi:${paper.doi}` : '';
  const identityLine = paperIdentity
    ? `${paperIdentity}${showsText ? ' · Full text' : pdfUrl ? ' · PDF' : ''}`
    : '';

  // Fallback timeout
  useEffect(() => {
    if (!canEmbed) return undefined;
    const fallbackTimer = setTimeout(() => {
      if (!iframeLoaded) setShowFallback(true);
    }, 8000);

    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [iframeLoaded, canEmbed]);

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
        closeLabel={'Close paper'}
        aria-label={'Paper viewer'}
      >
        <div className="pdf-viewer">
          {/* Top bar */}
          <div className="pdf-topbar">
            <DialogClose render={<Button variant="ghost" size="icon-sm" />} aria-label={'Close paper'} title={'Close'}>
              <X size={18} aria-hidden="true" />
            </DialogClose>

            <div className="pdf-heading">
              <h3 className="pdf-title">{paper.title}</h3>
              {identityLine && <span className="pdf-identity">{identityLine}</span>}
            </div>

            {fullText && (
              <Button size="icon" aria-label={showsText ? 'Show PDF' : 'Show text'} title={showsText ? 'Show PDF' : 'Show text'} onClick={showsText ? showPdf : () => setView('text')}>
                {showsText ? <FilePdf size={18} aria-hidden="true" /> : <TextAlignLeft size={18} aria-hidden="true" />}
              </Button>
            )}

            {externalUrl && (
              <Button variant="outline" size="icon" aria-label={'Open in a new tab'} title={'Open in a new tab'} render={<a href={externalUrl} target="_blank" rel="noopener noreferrer" />}>
                <ArrowSquareOut size={18} aria-hidden="true" />
              </Button>
            )}
          </div>

          <div className="pdf-stage">
            {fullText === undefined && (
              <ViewerLoading label={'Loading paper...'} />
            )}

            {fullText && showsText && (
              <div className="ft-scroll" tabIndex={0} role="region" aria-label="Paper text">
                <FullTextArticle doc={fullText} />
              </div>
            )}

            {/* Over the iframe, which takes its place while it loads unseen. */}
            {canEmbed && !iframeLoaded && !showFallback && (
              <ViewerLoading label={'Loading PDF...'} />
            )}

            {/* Touch: the pages, drawn here */}
            {drawsPages && (
              <Suspense fallback={(
                <ViewerLoading label={'Loading PDF...'} />
              )}>
                <PdfPages src={relayUrl} title={paper.title} onUnavailable={handleRelayUnavailable} />
              </Suspense>
            )}

            {/* Touch hand-off: a PDF exists but cannot be drawn here, so the
                browser's own viewer, the one that can page it, gets it. */}
            {coarsePointer && showsPdf && !drawsPages && fullTextUrl && (
              <div className="pdf-fallback pdf-handoff" role="status">
                <p>{relayFailed
                  ? 'The PDF could not be loaded in the app.'
                  : 'This PDF is hosted somewhere PaperTok cannot display it on a phone.'}</p>
                <a href={fullTextUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                  {'Open the full PDF →'}
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </div>
            )}

            {/* Fallback message. On touch it still owns the no-PDF case — the
                hand-off card above only ever replaces it when there IS a PDF to
                hand off. */}
            {shouldShowFallback && !(coarsePointer && fullTextUrl) && !iframeLoaded && (
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
