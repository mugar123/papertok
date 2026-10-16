import { useEffect, useRef, useState } from 'react';
// The legacy build, on purpose: the modern one calls `Map.getOrInsertComputed`
// and `Math.sumPrecise`, which the iPhones this viewer exists for do not have.
// The legacy build carries its own polyfills for about 60 KB more.
import { GlobalWorkerOptions, getDocument, TextLayer } from 'pdfjs-dist/legacy/build/pdf.min.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import './PdfPages.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Canvases cost memory in proportion to their pixels, and iOS Safari kills a
 * page that holds too many (a few hundred MB in total). A 3x phone drawing a
 * page at its full ratio spends 7 MB per page, so the ratio is capped at 2 and
 * only the pages near the viewport keep a drawing: the rest go back to an
 * empty box of the right size.
 */
const MAX_PIXEL_RATIO = 2;
const RENDER_MARGIN = '150% 0px';

/**
 * The paper's pages, drawn by pdf.js, one under another at the container's
 * width. This is the touch-screen route of PDFViewer: a framed PDF there shows
 * one page (iOS) or none (Android), so the pages are drawn here instead.
 *
 * `onUnavailable` is called once when the document cannot be read at all —
 * the relay refused it, it is not a PDF, it is too large — so the viewer can
 * offer the browser's own viewer instead of a blank sheet.
 */
export default function PdfPages({ src, title, onUnavailable }) {
  const [doc, setDoc] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [firstPageRatio, setFirstPageRatio] = useState(Math.SQRT2);
  // The observers' root. Left to the viewport, the margin below would reach
  // nothing: the pages live inside this scroller, which clips them, so only
  // the ones on screen ever counted as near (measured 2026-10-09: 2 of 15).
  const [scroller, setScroller] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const task = getDocument({
      url: src,
      // Nothing in a paper needs script evaluation, and the app's CSP should
      // not have to allow it.
      isEvalSupported: false,
      enableXfa: false,
    });
    task.promise.then(async (loaded) => {
      const first = await loaded.getPage(1);
      if (cancelled) return;
      const { width, height } = first.getViewport({ scale: 1 });
      setFirstPageRatio(height / width);
      setPageCount(loaded.numPages);
      setDoc(loaded);
    }).catch(() => {
      if (!cancelled) onUnavailable?.();
    });
    return () => {
      cancelled = true;
      task.destroy();
    };
    // `onUnavailable` is a stable callback in PDFViewer; were it not, a new
    // one would reload the document, never miss a failure.
  }, [src, onUnavailable]);

  const pages = [];
  for (let number = 1; number <= pageCount; number += 1) {
    pages.push(
      <PdfPage
        key={number}
        doc={doc}
        root={scroller}
        number={number}
        count={pageCount}
        placeholderRatio={firstPageRatio}
      />,
    );
  }

  return (
    <div ref={setScroller} className="pdf-pages" tabIndex={0} role="document" aria-label={`PDF: ${title}`} aria-busy={!doc}>
      {!doc && (
        <div className="pdf-loading">
          <div className="pdf-loading-spinner" />
          <p>{'Loading PDF...'}</p>
        </div>
      )}
      {pages}
      <p className="visually-hidden" role="status">
        {doc ? `PDF loaded, ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.` : ''}
      </p>
    </div>
  );
}

function PdfPage({ doc, root, number, count, placeholderRatio }) {
  const pageRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const [ratio, setRatio] = useState(placeholderRatio);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const node = pageRef.current;
    if (!doc || !root || !node) return undefined;
    let renderTask = null;
    let textLayer = null;
    let generation = 0;

    const release = () => {
      generation += 1;
      renderTask?.cancel();
      textLayer?.cancel();
      renderTask = null;
      textLayer = null;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      textRef.current?.replaceChildren();
      setDrawn(false);
    };

    const draw = async () => {
      const mine = ++generation;
      try {
        const page = await doc.getPage(number);
        if (mine !== generation) return;
        const base = page.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const cssWidth = node.clientWidth || base.width;
        const viewport = page.getViewport({ scale: cssWidth / base.width });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        renderTask = page.render({
          canvas,
          viewport,
          transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (mine !== generation) return;
        setDrawn(true);
        node.style.setProperty('--total-scale-factor', String(viewport.scale));
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent(),
          container: textRef.current,
          viewport,
        });
        await textLayer.render();
      } catch {
        // A cancelled render (the page scrolled away) and a page that cannot
        // be drawn both leave the empty box: the other pages still read.
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) draw();
      else release();
    }, { root, rootMargin: RENDER_MARGIN });
    observer.observe(node);
    return () => {
      observer.disconnect();
      release();
    };
  }, [doc, root, number]);

  return (
    <section
      ref={pageRef}
      className="pdf-page"
      aria-label={`Page ${number} of ${count}`}
      style={{ aspectRatio: `1 / ${ratio}` }}
    >
      <canvas ref={canvasRef} className={`pdf-page-canvas${drawn ? ' is-drawn' : ''}`} aria-hidden="true" />
      <div ref={textRef} className="textLayer" />
    </section>
  );
}
