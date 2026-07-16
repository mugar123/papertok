import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Network, X } from 'lucide-react';
import { getRelatedPapers } from '../../services/relatedPapersService';
import ScientificText from '../ScientificText';

export default function RelatedPapersSheet({ paper, onClose, onOpenPdf }) {
  const [papers, setPapers] = useState([]);
  const [status, setStatus] = useState('loading');

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

  const openPaper = (related) => {
    if (related.arxivId || related.pdfUrl) onOpenPdf(related);
    else window.open(related.landingPageUrl || (related.doi ? `https://doi.org/${related.doi}` : ''), '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="related-overlay" onClick={onClose} role="presentation">
      <section className="related-sheet" onClick={(event) => event.stopPropagation()} aria-label="Papers relacionados">
        <header className="related-header">
          <div><Network size={18} /><h3>Papers relacionados</h3></div>
          <button onClick={onClose} aria-label="Cerrar" title="Cerrar"><X size={20} /></button>
        </header>

        {status === 'loading' && <div className="related-state"><Loader2 className="spinning" size={28} />Buscando conexiones...</div>}
        {status === 'empty' && <div className="related-state">No hay recomendaciones disponibles para este paper.</div>}
        {status === 'error' && <div className="related-state">No se pudieron cargar ahora. El feed seguirá funcionando con normalidad.</div>}

        {status === 'ready' && (
          <div className="related-list">
            {papers.map((related) => (
              <button key={related.id} className="related-item" onClick={() => openPaper(related)}>
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>{related.authors.slice(0, 2).map(author => author.name || author).join(', ')}{related.year ? ` · ${related.year}` : ''}</small>
                </span>
                <ExternalLink size={17} />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
