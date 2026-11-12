import type { Ref } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import { lazy, Suspense, useEffect, useEffectEvent, useImperativeHandle, useMemo, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { useFeed } from '../../context/feed-context.tsx';
import { ArrowSquareOut, Eye, EyeSlash, FilePdf, TextAlignLeft, X } from '@phosphor-icons/react';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { Toggle } from '../ui/toggle.ts';
import './pdf-viewer.css';
import { safeDoiUrl, safeExternalUrl } from '../../utils/external-url.ts';
import { pdfLinksForPaper, pdfRelayUrl } from '../../utils/paper-open-targets.ts';
import { getFullText } from '../../services/full-text-service.ts';
import type { FullText } from '../../utils/full-text.ts';
import FullTextArticle from './full-text-article.tsx';
import { OutlineList, OutlineRail } from './full-text-outline.tsx';
import { useOutline } from './use-outline.ts';
import { PaperDock } from './paper-info.tsx';
import ViewerLoading from './viewer-loading.tsx';
import { NewTabHint } from './new-tab-hint.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { useAuth } from '../../context/auth-context.tsx';
import { analyticsSessionContext } from '../../services/analytics-session.ts';
import { documentVisibility, startViewerTracking, viewerOutcome } from './viewer-outcome.ts';

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
export default function PDFViewer({ paper, menu, onClose, closeRef = null }: { paper: Paper; menu: ReaderMenu; onClose: () => void; closeRef?: Ref<() => void> | null }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [open, setOpen] = useState(true);
  const [fullText, setFullText] = useState<FullText | null | undefined>(undefined);
  // The text could not be asked for, which is not the same as there being none.
  const [textFailed, setTextFailed] = useState(false);
  const [textAttempt, setTextAttempt] = useState(0);
  const [view, setView] = useState<'text' | 'pdf'>('text');
  const showsText = Boolean(fullText) && view === 'text';
  const [textScroll, setTextScroll] = useState<HTMLDivElement | null>(null);
  const [abstractShown, setAbstractShown] = useState(false);
  const outline = useOutline(fullText, textScroll, abstractShown);
  const [titleInText, setTitleInText] = useState(true);
  const textScrollRef = useCallback((element: HTMLDivElement | null) => {
    setTextScroll(element);
    if (!element) setTitleInText(true);
  }, []);
  useEffect(() => {
    const title = textScroll?.querySelector('.ft-title');
    if (!textScroll || !title) return;
    // Handed over as soon as the title starts to slide under the bar, not once it has gone.
    const observer = new IntersectionObserver(([entry]) => setTitleInText(entry.intersectionRatio >= 0.99), { root: textScroll, threshold: [0, 0.99] });
    observer.observe(title);
    return () => observer.disconnect();
  }, [textScroll]);
  const tucked = showsText && titleInText;
  const showsPdf = fullText === null || view === 'pdf';

  useEffect(() => {
    const controller = new AbortController();
    void getFullText(paper, controller.signal).then(({ doc, failed }) => {
      if (controller.signal.aborted) return;
      setFullText(doc);
      setTextFailed(failed);
    });
    return () => controller.abort();
  }, [paper, textAttempt]);
  const retryText = () => {
    setFullText(undefined);
    setTextFailed(false);
    setTextAttempt(attempt => attempt + 1);
  };

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
  // The relay delivered a PDF, but this device could draw no page of it.
  const [drawFailed, setDrawFailed] = useState(false);
  const drawsPages = Boolean(relayUrl) && !relayFailed && !drawFailed;
  const handleRelayUnavailable = useCallback(() => setRelayFailed(true), []);
  const handlePagesUndrawable = useCallback(() => setDrawFailed(true), []);
  const [pagesDrawn, setPagesDrawn] = useState(false);
  const handlePagesDrawn = useCallback(() => setPagesDrawn(true), []);
  const showPdf = () => {
    setIframeLoaded(false);
    setShowFallback(false);
    setView('pdf');
  };

  const { trackPdfBounce } = useFeed();
  const startTimeRef = useRef<number | null>(null);

  // The X and Escape land here, so the bounce is counted once, whichever it was.
  const handleClose = useCallback(() => {
    if (!open) return;
    const elapsed = (Date.now() - startTimeRef.current!) / 1000;
    if (elapsed < 5) {
      void trackPdfBounce(paper);
    }
    setOpen(false);
  }, [open, paper, trackPdfBounce]);
  const afterClose = useRef<(() => void) | null>(null);
  const leaveThen = useCallback((then: () => void) => {
    if (!open) return;
    afterClose.current = then;
    setOpen(false);
  }, [open]);

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
  const dockUrl = (showsText && safeExternalUrl(fullText?.sourceUrl)) || externalUrl;
  const shouldShowFallback = showsPdf && (!pdfUrl || showFallback);

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

  // viewer_open on mount, viewer_content on the first outcome, viewer_time on unmount.
  // A change of consent or account while open drops the session (viewer-outcome.ts):
  // `consent` and `uid` drop it at once, and `analyticsSessionContext` checks again at each send.
  const { trackEvent, consent } = useAnalyticsConsent();
  const uid = useAuth().user?.uid ?? '';
  const sendViewerEvent = useEffectEvent((name: Parameters<typeof trackEvent>[0], params: Record<string, unknown>, stillValid: () => boolean) => {
    void trackEvent(name, params, stillValid);
  });
  const trackerRef = useRef<ReturnType<typeof startViewerTracking> | null>(null);
  useEffect(() => {
    trackerRef.current?.check();
  }, [consent, uid]);
  useEffect(() => {
    const tracker = startViewerTracking({ now: Date.now, visibility: documentVisibility, context: analyticsSessionContext, send: sendViewerEvent });
    trackerRef.current = tracker;
    return () => {
      tracker.stop();
      trackerRef.current = null;
    };
  }, [paper.id]);
  useEffect(() => {
    trackerRef.current?.showText(showsText);
  }, [showsText]);
  const outcome = viewerOutcome({
    textSource: fullText === undefined ? undefined : fullText?.source ?? null,
    textFailed,
    coarsePointer,
    hasPdf: Boolean(fullTextUrl),
    embeddable: Boolean(pdfUrl),
    relayable: Boolean(pdfRelayUrl(relaySourceUrl, PAPER_API_BASE_URL)),
    iframeLoaded,
    embedTimedOut: showFallback,
    pagesDrawn,
    relayFailed,
    drawFailed,
    hasLink: Boolean(externalUrl),
  });
  useEffect(() => {
    if (outcome) trackerRef.current?.settle(outcome);
  }, [outcome]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => { if (!nextOpen) handleClose(); }}
      onOpenChangeComplete={(nextOpen) => {
        if (nextOpen) return;
        onClose();
        afterClose.current?.();
      }}
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

            {/* The bar names the paper once the article's own title has scrolled
                away, rising in from below; it leaves the way it came. */}
            <AnimatePresence initial={false}>
              {!tucked && (
                <motion.h3
                  key="title"
                  className="pdf-title"
                  initial={{ opacity: 0, transform: 'translateY(40%)' }}
                  animate={{ opacity: 1, transform: 'translateY(0%)' }}
                  exit={{ opacity: 0, transform: 'translateY(40%)' }}
                  transition={{ duration: MOTION_BASE_S, ease: EASE_OUT }}
                >
                  {paper.title}
                </motion.h3>
              )}
            </AnimatePresence>
          </div>

          <div className="pdf-stage">
            {textFailed && (
              <div className="pdf-text-failed" role="status">
                <p>The text of this paper could not be loaded right now.</p>
                <Button variant="outline" size="sm" onClick={retryText}>Try again</Button>
              </div>
            )}
            {fullText === undefined && (
              <ViewerLoading label={'Loading paper...'} />
            )}

            {fullText && showsText && (
              <div className="ft-scroll" tabIndex={0} role="region" aria-label="Paper text" ref={textScrollRef}>
                <FullTextArticle doc={fullText} paper={paper} showAbstract={abstractShown} />
              </div>
            )}
            {fullText && showsText && <OutlineRail {...outline} />}

            {/* The tools are the loaded paper's: none of them shows while it is asked for. */}
            {fullText !== undefined && (
            <PaperDock paper={paper} doc={fullText} scroll={showsText ? textScroll : null} fromCard={menu} onLeave={leaveThen} contents={showsText && outline.items.length > 0 ? close => <OutlineList {...outline} onPick={close} /> : null}>
                {showsText && (fullText?.abstract.length ?? 0) > 0 && (
                  <Toggle className="pdf-dock-toggle" pressed={abstractShown} onPressedChange={setAbstractShown} aria-label="Abstract" title={abstractShown ? 'Hide the abstract' : 'Show the abstract'}>
                    {abstractShown ? <Eye size={18} aria-hidden="true" /> : <EyeSlash size={18} aria-hidden="true" />}
                    Abstract
                  </Toggle>
                )}
                {fullText && (
                  <Button variant="ghost" size="icon" aria-label={showsText ? 'Show PDF' : 'Show text'} title={showsText ? 'Show PDF' : 'Show text'} onClick={showsText ? showPdf : () => setView('text')}>
                    {showsText ? <FilePdf size={18} aria-hidden="true" /> : <TextAlignLeft size={18} aria-hidden="true" />}
                  </Button>
                )}
                {dockUrl && (
                  <Button variant="ghost" size="icon" aria-label={'Open in a new tab'} title={'Open in a new tab'} render={<a href={dockUrl} target="_blank" rel="noopener noreferrer" />}>
                    <ArrowSquareOut size={18} aria-hidden="true" />
                  </Button>
                )}
            </PaperDock>
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
                <PdfPages src={relayUrl} title={paper.title} onUnavailable={handleRelayUnavailable} onUndrawable={handlePagesUndrawable} onDrawn={handlePagesDrawn} />
              </Suspense>
            )}

            {/* Touch hand-off: a PDF exists but cannot be drawn here, so the
                browser's own viewer, the one that can page it, gets it. */}
            {coarsePointer && showsPdf && !drawsPages && fullTextUrl && (
              <div className="pdf-fallback pdf-handoff" role="status">
                <p>{relayFailed || drawFailed
                  ? 'The PDF could not be loaded in the app.'
                  : 'This PDF is hosted somewhere PaperTok cannot display it on a phone.'}</p>
                <a href={fullTextUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
                  {'Open the full PDF →'}
                  <NewTabHint />
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
