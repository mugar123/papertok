import type { MouseEvent as ReactMouseEvent, Ref } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { ReaderMenu } from '../feed/paper-menu.tsx';
import { lazy, Suspense, useEffect, useEffectEvent, useImperativeHandle, useMemo, useState, useRef, useCallback, useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT, MOTION_BASE_S } from '../../utils/motion-curves.ts';
import { useFeed } from '../../context/feed-context.tsx';
import { Highlighter, TextAlignLeft, X } from '@phosphor-icons/react';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';
import { readShowAbstract, subscribeShowAbstract } from '../../utils/reader-preferences.ts';
import './pdf-viewer.css';
import '../reader/paper-reader.css';
import '../reader/annotations.css';
import { safeDoiUrl, safeExternalUrl } from '../../utils/external-url.ts';
import { pdfLinksForPaper, pdfRelayUrl } from '../../utils/paper-open-targets.ts';
import { getFullText } from '../../services/full-text-service.ts';
import type { FullText } from '../../utils/full-text.ts';
import FullTextArticle from './full-text-article.tsx';
import { OutlineList, OutlineRail } from './full-text-outline.tsx';
import { useOutline } from './use-outline.ts';
import { skipsCoveredView } from './covered-view.ts';
import { ReadingDock } from './reading-dock.tsx';
import ViewerLoading from './viewer-loading.tsx';
import { NewTabHint } from './new-tab-hint.tsx';
import { useAnalyticsConsent } from '../../context/privacy-context.tsx';
import { useAuth } from '../../context/auth-context.tsx';
import { analyticsSessionContext } from '../../services/analytics-session.ts';
import { documentVisibility, startViewerTracking, viewerOutcome } from './viewer-outcome.ts';
import { NotesSidebar, PassageEditor } from './viewer-notes.tsx';
import { PassageHandles } from './passage-handles.tsx';
import type { PassageSelection } from './passage-range.ts';
import { annotationRange, passageAt, passageFromRange } from './passage-range.ts';
import type { PassageAnnotation } from '../../hooks/use-passage-annotations.ts';
import UsesCount from '../reader/uses-count.tsx';
import { usePaintedPassages, useTouchSelection, useViewerNotes } from './use-viewer-notes.ts';
import { fullTextListen } from './read-aloud.ts';
import { ReadingTabs, type ReadingView } from './reading-tabs.tsx';
import { canRewritePaper } from '../../services/paper-rewrite-service.ts';
import { passageQuote } from '../../services/user-highlight-service.ts';
import { connectionIsFrugal, lazyWithPreload } from '../../utils/lazy-preload.ts';

const PaperReader = lazyWithPreload(() => import('../reader/paper-reader.tsx'));

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
/** The viewer's tabs in the bar's order, which sets the side a view arrives from. */
const VIEW_ORDER: readonly ReadingView[] = ['paper', 'listen', 'summary'];

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
  const abstractShown = useSyncExternalStore(subscribeShowAbstract, readShowAbstract);
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

  const { trackPdfBounce } = useFeed();
  const startTimeRef = useRef<number | null>(null);

  // The X and Escape land here, so the bounce is counted once, whichever it was.
  const handleClose = useCallback(() => {
    if (!open) return;
    if (startTimeRef.current !== null && Date.now() - startTimeRef.current < 5000) {
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
  const { user, readingPreferences } = useAuth();
  // The tab chosen, and the side the view it shows arrives from: a tab to the right comes in from
  // the right. The view left goes at once, so two texts never show through each other.
  const [tab, setTab] = useState<{ view: ReadingView; from: number; turn: number }>({ view: 'paper', from: 0, turn: 0 });
  const choose = (view: ReadingView) => setTab(current => (current.view === view ? current
    : { view, from: Math.sign(VIEW_ORDER.indexOf(view) - VIEW_ORDER.indexOf(current.view)), turn: current.turn + 1 }));
  const canSummarize = Boolean(user) && canRewritePaper(paper);
  const uid = user?.uid ?? '';
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

  const notesOn = Boolean(uid) && showsText;
  const notes = useViewerNotes(paper, uid, readingPreferences?.aiExplanationLevel ?? 'university');
  const touchPassage = useTouchSelection(notesOn && coarsePointer && !notes.pending ? textScroll : null);
  const [notesOpen, setNotesOpen] = useState(false);
  // The passage while its handles are dragged; it becomes the pending one when they are let go.
  const [dragged, setDragged] = useState<PassageSelection | null>(null);
  // The highlight under the mouse, painted a shade darker.
  const [hoveredPassage, setHoveredPassage] = useState<string | null>(null);
  // The bar the podcast's round button is placed in.
  const [topbar, setTopbar] = useState<HTMLDivElement | null>(null);
  usePaintedPassages(notesOn ? textScroll : null, notes.passages, dragged ?? notes.pending, notes.active, hoveredPassage);
  // A note in the panel goes to its passage and marks it, as in the reader; on a phone the
  // notes cover the text, so they close to show it.
  const goToNote = (passage: PassageAnnotation) => {
    const block = textScroll?.querySelector(`[data-passage="${CSS.escape(passage.sectionId)}"]`);
    if (!block) return;
    if (window.matchMedia('(max-width: 719px)').matches) setNotesOpen(false);
    block.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    notes.pickId(passage.id);
  };
  // Over a highlight, a click opens the notes at it, so the pointer says so. The marks are
  // painted ranges, not elements, so the stylesheet cannot reach them.
  const pointAtHighlight = (event: ReactMouseEvent<HTMLDivElement>) => {
    const pointed = passageAt(event.target, notes.passages, event.clientX, event.clientY);
    event.currentTarget.style.cursor = pointed ? 'pointer' : '';
    setHoveredPassage(pointed?.id ?? null);
  };
  // A click on a highlight marks it and opens the notes at its entry. The text narrows as
  // the notes open, so the passage is brought back into view; on a phone the notes cover
  // the text, so focus goes to them rather than staying on text that is now hidden.
  const openHighlightAt = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (window.getSelection()?.isCollapsed === false || !notes.pickAt(event.target, event.clientX, event.clientY)) return;
    setNotesOpen(true);
    const passage = (event.target as Element).closest('[data-passage]');
    requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 719px)').matches) document.querySelector<HTMLElement>('#viewer-notes .vn-side-title')?.focus();
      else passage?.scrollIntoView({ block: 'nearest' });
    });
  };

  // Read aloud: the paper's prose in PaperTok's voice, for a signed-in reader of an English text.
  const spoken = useMemo(() => (fullText ? fullTextListen(fullText, { withAbstract: abstractShown }) : null), [fullText, abstractShown]);
  // Listening needs the paper's English text, read as text, for a signed-in reader.
  const listenable = Boolean(uid) && showsText && Boolean(spoken?.queue.length) && /^en\b/i.test(fullText?.lang ?? '');
  // The same list while the same tabs apply: the tabs measure their layout when it changes.
  const tabs = useMemo(() => VIEW_ORDER.filter(item => item === 'paper' || (item === 'summary' ? canSummarize : listenable)), [canSummarize, listenable]);
  // A tab that is no longer offered (the text turned to the PDF, say) falls back to the paper.
  const shown = tabs.includes(tab.view) ? tab.view : 'paper';
  const summaryOpen = shown === 'summary';
  useEffect(() => {
    if (!canSummarize || fullText === undefined || connectionIsFrugal()) return;
    const prepare = () => { void PaperReader.preload().catch(() => undefined); };
    if ('requestIdleCallback' in window) {
      const idle = window.requestIdleCallback(prepare);
      return () => window.cancelIdleCallback(idle);
    }
    const timer = setTimeout(prepare, 1000);
    return () => clearTimeout(timer);
  }, [canSummarize, fullText]);
  // A tab no longer offered once the paper's text is in (the text turned to the PDF) is left for the paper.
  if (fullText !== undefined && shown !== tab.view) setTab({ view: 'paper', from: 0, turn: tab.turn });

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
          <div className="pdf-topbar" ref={setTopbar}>
            <DialogClose render={<Button variant="ghost" size="icon-sm" />} aria-label={'Close paper'} title={'Close'}>
              <X size={18} aria-hidden="true" />
            </DialogClose>

            {/* The bar names the paper once the article's own title has scrolled
                away, rising in from below; it leaves the way it came. Where the paper
                has other tabs (an AI summary, Listen), the bar holds them instead. */}
            {tabs.length > 1 ? <ReadingTabs current={shown} views={tabs} onChange={choose} /> : <AnimatePresence initial={false}>
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
            </AnimatePresence>}
          </div>

          {/* Under the AI summary tab the paper stays mounted, so its place waits, but out of reach. */}
          <div className="pdf-stage" data-notes-open={(notesOn && notesOpen) || undefined} data-arrive={(shown === 'paper' && tab.turn > 0) || undefined} data-covered={shown === 'paper' ? undefined : shown} inert={summaryOpen && !skipsCoveredView}>
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
              <div className="ft-scroll" tabIndex={shown === 'paper' ? 0 : -1} role="region" aria-label="Paper text" ref={textScrollRef} onMouseUp={notesOn && !coarsePointer ? () => notes.pick(textScroll) : undefined} onClick={notesOn ? openHighlightAt : undefined} onMouseMove={notesOn && !coarsePointer ? pointAtHighlight : undefined} onMouseLeave={() => setHoveredPassage(null)} onKeyUp={notesOn && !coarsePointer ? (event) => { if (event.key === 'Shift') notes.pick(textScroll); } : undefined} onKeyDown={notesOn ? (event) => {
                const block = event.target as HTMLElement;
                if (event.key !== 'Enter' || !block.matches('[data-passage]')) return;
                event.preventDefault();
                notes.pickBlock(block);
              } : undefined}>
                <FullTextArticle doc={fullText} paper={paper} showAbstract={abstractShown} passageHint={notesOn ? 'viewer-passage-hint' : undefined} />
              </div>
            )}
            {fullText && showsText && <OutlineRail {...outline} />}
            {notesOn && <NotesSidebar id="viewer-notes" open={notesOpen} passages={notes.passages} active={notes.active} withAi thinking={notes.busy === 'asking' ? { at: 0, label: 'Reading the passage…' } : null} onGoTo={goToNote} onRemove={(id) => { void notes.remove(id); }} onClose={() => setNotesOpen(false)} />}
            {notesOn && notes.pending?.anchor && (
              <PassageEditor
                sheet={coarsePointer}
                key={`${notes.pending.sectionId}:${notes.pending.quote}`}
                quote={passageQuote(notes.pending)}
                anchor={notes.pending.anchor}
                busy={notes.busy !== 'idle'}
                error={notes.failed !== null}
                initialNote={notes.failed ?? ''}
                returnFocus={notes.origin ?? textScroll}
                onSave={(note, color) => { void notes.save(note, color); }}
                ask={{
                  price: notes.quota?.unlimited ? null
                    : notes.quota?.dailyLimit
                      ? <UsesCount left={notes.quota.remainingUses} limit={notes.quota.dailyLimit} />
                      : notes.canAsk ? '1 use' : 'no uses',
                  disabled: !notes.canAsk,
                  title: notes.canAsk ? undefined : 'Today’s AI uses have run out.',
                  onAsk: (question) => {
                    setNotesOpen(true);
                    void notes.ask(question);
                  },
                }}
                onCancel={notes.dismiss}
              />
            )}
            {notesOn && !coarsePointer && textScroll && notes.pending && (
              <PassageHandles
                root={textScroll}
                range={() => {
                  const shown = dragged ?? notes.pending;
                  return shown ? annotationRange(textScroll, shown) : null;
                }}
                onMove={(range) => setDragged(passageFromRange(textScroll, range))}
                onEnd={(range) => {
                  setDragged(null);
                  const passage = range && passageFromRange(textScroll, range);
                  if (passage) notes.pickPassage(passage, notes.origin);
                }}
              />
            )}
            {touchPassage && (
              <Button
                className="vn-touch-highlight"
                onClick={() => {
                  notes.pickPassage(touchPassage, textScroll);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                <Highlighter size={18} aria-hidden="true" />
                Highlight
              </Button>
            )}
            {notesOn && <p className="visually-hidden" role="status">{notes.status}</p>}
            {notesOn && <p id="viewer-passage-hint" className="visually-hidden">Press Enter to highlight this paragraph or add a note to it.</p>}

            {/* The tools are the loaded paper's: none of them shows while it is asked for. */}
            {fullText !== undefined && (
            <ReadingDock
              title={paper.title} paper={paper} scroll={showsText ? textScroll : null}
              spoken={spoken} topbar={topbar} canListen={listenable} listening={shown === 'listen'} arrivalFrom={tab.from * 16}
              notes={notesOn ? { id: 'viewer-notes', open: notesOpen, count: notes.passages.length, onOpenChange: setNotesOpen } : null}
              originalUrl={dockUrl}
              menu={{ paper, doc: fullText, fromCard: menu, onLeave: leaveThen, viewActions: fullText && !showsText
                ? [{ id: 'view', label: 'Show text', hint: 'The paper as text you can annotate and listen to', Icon: TextAlignLeft, onSelect: () => setView('text') }]
                : [] }}
              contents={showsText && outline.items.length > 0 ? close => <OutlineList {...outline} onPick={close} /> : null}
            />
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
        {summaryOpen && (
          <div className="pdf-summary">
            <Suspense fallback={null}>
              <PaperReader embedded paper={paper} card={{ paper, menu }} onClose={onClose} onLeave={leaveThen} onPaperTab={() => choose('paper')} />
            </Suspense>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
