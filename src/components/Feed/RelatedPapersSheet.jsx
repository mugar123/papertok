import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, GitBranch, Loader2, Network, Sparkles, X } from 'lucide-react';
import { getCitationGraph, getCitationGraphDoi } from '../../services/citationGraphService';
import { getRelatedPapers } from '../../services/relatedPapersService';
import ScientificText from '../ScientificText';

const INITIAL_GRAPH = {
  references: [],
  citations: [],
  counts: { references: 0, citations: 0 },
  source: '',
  partial: false,
};

function formatCompactCount(value) {
  const count = Math.max(0, Number(value) || 0);
  return new Intl.NumberFormat('es-ES', { notation: count >= 1000 ? 'compact' : 'standard' }).format(count);
}

function LoadingState({ label }) {
  return (
    <div className="related-state related-loading">
      <div className="related-loading-label"><Loader2 className="spinning" size={20} />{label}</div>
      <div className="related-skeletons" aria-hidden="true">
        {[0, 1].map(index => <span className="related-skeleton" key={index} style={{ '--skeleton-index': index }} />)}
      </div>
    </div>
  );
}

export default function RelatedPapersSheet({ paper, onClose, onSelectPaper }) {
  const hasGraphIdentifier = Boolean(getCitationGraphDoi(paper));
  const [mode, setMode] = useState(hasGraphIdentifier ? 'graph' : 'similar');
  const [graphSide, setGraphSide] = useState('references');
  const [graph, setGraph] = useState(INITIAL_GRAPH);
  const [graphStatus, setGraphStatus] = useState(hasGraphIdentifier ? 'loading' : 'unavailable');
  const [papers, setPapers] = useState([]);
  const [relatedStatus, setRelatedStatus] = useState(hasGraphIdentifier ? 'idle' : 'loading');
  const [isClosing, setIsClosing] = useState(false);
  const [selectedPaperId, setSelectedPaperId] = useState(null);
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);
  const relatedRequestedRef = useRef(!hasGraphIdentifier);

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
    if (!hasGraphIdentifier) return undefined;
    let cancelled = false;
    getCitationGraph(paper).then(result => {
      if (cancelled) return;
      const nextGraph = result || INITIAL_GRAPH;
      setGraph(nextGraph);
      if (!nextGraph.references.length && nextGraph.citations.length) setGraphSide('citations');
      setGraphStatus(nextGraph.references.length || nextGraph.citations.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudo cargar el grafo de citas', error);
      setGraphStatus('error');
    });
    return () => { cancelled = true; };
  }, [hasGraphIdentifier, paper]);

  useEffect(() => {
    if (mode !== 'similar' || relatedRequestedRef.current) return undefined;
    relatedRequestedRef.current = true;
    let cancelled = false;
    setRelatedStatus('loading');
    getRelatedPapers(paper).then(results => {
      if (cancelled) return;
      setPapers(results);
      setRelatedStatus(results.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setRelatedStatus('error');
    });
    return () => { cancelled = true; };
  }, [mode, paper]);

  useEffect(() => {
    if (hasGraphIdentifier) return undefined;
    let cancelled = false;
    getRelatedPapers(paper).then(results => {
      if (cancelled) return;
      setPapers(results);
      setRelatedStatus(results.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setRelatedStatus('error');
    });
    return () => { cancelled = true; };
  }, [hasGraphIdentifier, paper]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [requestClose]);

  const graphPapers = graph[graphSide] || [];
  const graphEmptyLabel = graphSide === 'references'
    ? 'No se encontraron referencias enlazadas para este paper.'
    : 'Todavía no se encontraron trabajos posteriores enlazados.';
  const visiblePapers = mode === 'graph' ? graphPapers : papers;
  const visibleStatus = mode === 'graph' ? graphStatus : relatedStatus;
  const sourceLabel = graph.source === 'opencitations'
    ? 'OpenCitations'
    : 'OpenCitations + OpenAlex';

  const currentPaperLabel = useMemo(() => {
    const title = String(paper?.title || 'Paper actual').trim();
    return title.length > 38 ? `${title.slice(0, 38).trim()}…` : title;
  }, [paper?.title]);

  return (
    <div
      className={`related-overlay ${isClosing ? 'is-closing' : ''} ${selectedPaperId ? 'is-selecting-paper' : ''}`}
      onClick={requestClose}
      role="presentation"
    >
      <section
        className={`related-sheet related-sheet--graph ${selectedPaperId ? 'is-selecting-paper' : ''}`}
        onClick={event => event.stopPropagation()}
        aria-label="Conexiones del paper"
        aria-modal="true"
        aria-busy={visibleStatus === 'loading'}
        role="dialog"
      >
        <div className="related-grabber" aria-hidden="true" />
        <header className="related-header">
          <div><Network size={18} /><h3>Conexiones del paper</h3></div>
          <button onClick={requestClose} aria-label="Cerrar" title="Cerrar" autoFocus><X size={20} /></button>
        </header>

        <div className="related-mode-tabs" role="tablist" aria-label="Tipo de conexión">
          <button
            className={mode === 'graph' ? 'is-active' : ''}
            onClick={() => setMode('graph')}
            disabled={!hasGraphIdentifier}
            role="tab"
            aria-selected={mode === 'graph'}
          >
            <GitBranch size={16} />Grafo
          </button>
          <button
            className={mode === 'similar' ? 'is-active' : ''}
            onClick={() => setMode('similar')}
            role="tab"
            aria-selected={mode === 'similar'}
          >
            <Sparkles size={16} />Similares
          </button>
        </div>

        {mode === 'graph' && (
          <div className="knowledge-path" aria-label="Linaje bibliográfico">
            <button
              className={graphSide === 'references' ? 'is-active' : ''}
              onClick={() => setGraphSide('references')}
              aria-pressed={graphSide === 'references'}
            >
              <BookOpen size={17} />
              <span><strong>{formatCompactCount(graph.counts.references)}</strong><small>Referencias</small></span>
            </button>
            <span className="knowledge-path-line" aria-hidden="true" />
            <div className="knowledge-path-current" title={paper?.title}>
              <Network size={18} />
              <span><strong>Paper actual</strong><small>{currentPaperLabel}</small></span>
            </div>
            <span className="knowledge-path-line" aria-hidden="true" />
            <button
              className={graphSide === 'citations' ? 'is-active' : ''}
              onClick={() => setGraphSide('citations')}
              aria-pressed={graphSide === 'citations'}
            >
              <GitBranch size={17} />
              <span><strong>{formatCompactCount(graph.counts.citations)}</strong><small>Posteriores</small></span>
            </button>
          </div>
        )}

        {visibleStatus === 'loading' && (
          <LoadingState label={mode === 'graph' ? 'Trazando el linaje...' : 'Buscando conexiones...'} />
        )}
        {visibleStatus === 'unavailable' && (
          <div className="related-state">El grafo bibliográfico necesita un DOI válido.</div>
        )}
        {visibleStatus === 'empty' && (
          <div className="related-state">{mode === 'graph' ? graphEmptyLabel : 'No hay recomendaciones disponibles para este paper.'}</div>
        )}
        {visibleStatus === 'error' && (
          <div className="related-state">No se pudieron cargar estas conexiones ahora. El resto de PaperTok seguirá funcionando con normalidad.</div>
        )}

        {visibleStatus === 'ready' && (
          <div className="related-list" key={`${mode}-${graphSide}`}>
            {visiblePapers.length ? visiblePapers.map((related, index) => (
              <button
                key={related.id}
                className={`related-item ${selectedPaperId === related.id ? 'is-selected' : ''}`}
                style={{ '--related-index': index }}
                onClick={() => requestPaper(related)}
                disabled={Boolean(selectedPaperId)}
              >
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>
                    {related.authors.slice(0, 2).map(author => author.name || author).join(', ')}
                    {related.year ? ` · ${related.year}` : ''}
                    {related.citationCountKnown ? ` · ${related.citationCount} citas` : ''}
                  </small>
                </span>
                <ChevronRight size={18} />
              </button>
            )) : <div className="related-state">{graphEmptyLabel}</div>}
          </div>
        )}

        {mode === 'graph' && graphStatus === 'ready' && (
          <div className="knowledge-source">
            <span>{sourceLabel}</span>
          </div>
        )}
      </section>
    </div>
  );
}
