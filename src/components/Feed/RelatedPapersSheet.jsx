import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Loader2, Network, X } from 'lucide-react';
import { getRelatedPapers } from '../../services/relatedPapersService';
import ScientificText from '../ScientificText';

export default function RelatedPapersSheet({ paper, onClose, onSelectPaper }) {
  const [papers, setPapers] = useState([]);
  const [status, setStatus] = useState('loading');
  const [isClosing, setIsClosing] = useState(false);
  const [selectedPaperId, setSelectedPaperId] = useState(null);
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = setTimeout(onClose, 180);
  }, [onClose]);

  const requestPaper = useCallback((relatedPaper) => {
    if (closingRef.current) return;
    closingRef.current = true;
    setSelectedPaperId(relatedPaper.id);
    setIsClosing(true);
    closeTimerRef.current = setTimeout(() => onSelectPaper(relatedPaper), 210);
  }, [onSelectPaper]);

  useEffect(() => {
    let cancelled = false;
    getRelatedPapers(paper).then((results) => {
      if (cancelled) return;
      setPapers(results);
      setStatus(results.length ? 'ready' : 'empty');
    }).catch((error) => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setStatus('error');
    });
    return () => { cancelled = true; };
  }, [paper]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [requestClose]);

  return (
    <div
      className={`related-overlay ${isClosing ? 'is-closing' : ''} ${selectedPaperId ? 'is-selecting-paper' : ''}`}
      onClick={requestClose}
      role="presentation"
    >
      <section
        className={`related-sheet ${selectedPaperId ? 'is-selecting-paper' : ''}`}
        onClick={(event) => event.stopPropagation()}
        aria-label="Papers relacionados"
        aria-modal="true"
        aria-busy={status === 'loading'}
        role="dialog"
      >
        <div className="related-grabber" aria-hidden="true" />
        <header className="related-header">
          <div><Network size={18} /><h3>Papers relacionados</h3></div>
          <button onClick={requestClose} aria-label="Cerrar" title="Cerrar" autoFocus><X size={20} /></button>
        </header>

        {status === 'loading' && (
          <div className="related-state related-loading">
            <div className="related-loading-label"><Loader2 className="spinning" size={20} />Buscando conexiones...</div>
            <div className="related-skeletons" aria-hidden="true">
              {[0, 1, 2].map((index) => <span className="related-skeleton" key={index} style={{ '--skeleton-index': index }} />)}
            </div>
          </div>
        )}
        {status === 'empty' && <div className="related-state">No hay recomendaciones disponibles para este paper.</div>}
        {status === 'error' && <div className="related-state">No se pudieron cargar ahora. El feed seguirá funcionando con normalidad.</div>}

        {status === 'ready' && (
          <div className="related-list">
            {papers.map((related, index) => (
              <button
                key={related.id}
                className={`related-item ${selectedPaperId === related.id ? 'is-selected' : ''}`}
                style={{ '--related-index': index }}
                onClick={() => requestPaper(related)}
                disabled={Boolean(selectedPaperId)}
              >
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>{related.authors.slice(0, 2).map(author => author.name || author).join(', ')}{related.year ? ` · ${related.year}` : ''}</small>
                </span>
                <ChevronRight size={18} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
