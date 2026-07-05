import { useEffect, useState, useRef, useCallback } from 'react';
import { useFeed } from '../../context/FeedContext';
import './PDFViewer.css';

export default function PDFViewer({ paper, onClose }) {
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const pdfUrl = `https://arxiv.org/pdf/${paper.arxivId}`;

  const { trackPdfBounce } = useFeed();
  const startTimeRef = useRef(null);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    const elapsed = (Date.now() - startTimeRef.current) / 1000;
    if (elapsed < 5) {
      trackPdfBounce(paper);
    }
    setTimeout(() => {
      onClose();
    }, 300); // Wait for the animation to finish
  }, [onClose, paper, trackPdfBounce]);

  // Close on Escape key
  useEffect(() => {
    startTimeRef.current = Date.now();
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleClose]);

  // Lock body scroll on mount, unlock on unmount
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Fallback timeout
  useEffect(() => {
    const fallbackTimer = setTimeout(() => {
      if (!iframeLoaded) setShowFallback(true);
    }, 8000);

    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [iframeLoaded]); // removed onClose from deps to prevent stale closures if not needed, or we can just use the outer onClose

  return (
    <div className={`pdf-overlay ${isClosing ? 'is-closing' : ''}`} onClick={handleClose}>
      <div className={`pdf-viewer ${isClosing ? 'is-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Top bar */}
        <div className="pdf-topbar glass-strong">
          <button className="pdf-close-btn" onClick={handleClose} title="Cerrar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <h3 className="pdf-title">{paper.title}</h3>

          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pdf-external-btn"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            <span>Nueva pestaña</span>
          </a>
        </div>

        {/* Loading indicator */}
        {!iframeLoaded && !showFallback && (
          <div className="pdf-loading">
            <div className="pdf-loading-spinner" />
            <p>Cargando PDF...</p>
          </div>
        )}

        {/* Fallback message */}
        {showFallback && !iframeLoaded && (
          <div className="pdf-fallback">
            <p>El PDF no pudo cargarse en la app.</p>
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className="pdf-fallback-link">
              Abrir PDF en nueva pestaña →
            </a>
          </div>
        )}

        {/* PDF iframe */}
        <iframe
          src={pdfUrl}
          className={`pdf-iframe ${iframeLoaded ? 'pdf-iframe--loaded' : ''}`}
          title={`PDF: ${paper.title}`}
          onLoad={() => setIframeLoaded(true)}
        />
      </div>
    </div>
  );
}
