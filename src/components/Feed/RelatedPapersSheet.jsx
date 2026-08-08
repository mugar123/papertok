import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, GitBranch, Loader2, Network, Sparkles, X } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import { getCitationGraph, getCitationGraphDoi } from '../../services/citationGraphService';
import { getRelatedPapers } from '../../services/relatedPapersService';
import {
  buildRelatedPaperEntries,
  getRelatedTransitionAction,
  getRelatedTransitionDuration,
  RELATED_PAPER_HANDOFF_MS,
  RELATED_SHEET_CLOSE_MS,
} from '../../utils/relatedPaperTransition.js';
import ScientificText from '../ScientificText';
import { useLanguage } from '../../context/LanguageContext';

const INITIAL_GRAPH = {
  references: [],
  citations: [],
  counts: { references: 0, citations: 0 },
  source: '',
  partial: false,
};

function formatCompactCount(value, locale = 'es-ES') {
  const count = Math.max(0, Number(value) || 0);
  return new Intl.NumberFormat(locale, { notation: count >= 1000 ? 'compact' : 'standard' }).format(count);
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
  const { isEnglish, locale } = useLanguage();
  const hasGraphIdentifier = Boolean(getCitationGraphDoi(paper));
  const [mode, setMode] = useState(hasGraphIdentifier ? 'graph' : 'similar');
  const [graphSide, setGraphSide] = useState('references');
  const [graph, setGraph] = useState(INITIAL_GRAPH);
  const [graphStatus, setGraphStatus] = useState(hasGraphIdentifier ? 'loading' : 'unavailable');
  const [papers, setPapers] = useState([]);
  const [relatedStatus, setRelatedStatus] = useState(hasGraphIdentifier ? 'idle' : 'loading');
  const [isClosing, setIsClosing] = useState(false);
  const [selectedPaperKey, setSelectedPaperKey] = useState(null);
  const closingRef = useRef(false);
  const mountedRef = useRef(false);
  const pendingSelectionRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const onSelectPaperRef = useRef(onSelectPaper);
  const relatedRequestedRef = useRef(!hasGraphIdentifier);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    onSelectPaperRef.current = onSelectPaper;
  }, [onSelectPaper]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingSelectionRef.current = null;
    };
  }, []);

  const finishClose = useCallback(() => {
    if (!mountedRef.current || !closingRef.current) return;
    closingRef.current = false;
    onCloseRef.current();
  }, []);

  const finishSelection = useCallback(() => {
    if (!mountedRef.current) return;
    const pendingSelection = pendingSelectionRef.current;
    if (!pendingSelection) return;
    pendingSelectionRef.current = null;
    closingRef.current = false;
    onSelectPaperRef.current(pendingSelection.paper);
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingSelectionRef.current = null;
    setIsClosing(true);
    if (getRelatedTransitionDuration(RELATED_SHEET_CLOSE_MS, prefersReducedMotion) === 0) finishClose();
  }, [finishClose, prefersReducedMotion]);

  const requestPaper = useCallback((relatedPaper, paperKey) => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingSelectionRef.current = { paper: relatedPaper, key: paperKey };
    setSelectedPaperKey(paperKey);
    setIsClosing(true);
    if (getRelatedTransitionDuration(RELATED_PAPER_HANDOFF_MS, prefersReducedMotion) === 0) finishSelection();
  }, [finishSelection, prefersReducedMotion]);

  const handleSheetAnimationEnd = useCallback((event) => {
    if (event.target !== event.currentTarget) return;
    const action = getRelatedTransitionAction(event.animationName);
    if (action === 'close') finishClose();
    if (action === 'select') finishSelection();
  }, [finishClose, finishSelection]);

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
    };
  }, [requestClose]);

  const graphPapers = graph[graphSide] || [];
  const graphEmptyLabel = graphSide === 'references'
    ? (isEnglish ? 'No linked references were found for this paper.' : 'No se encontraron referencias enlazadas para este paper.')
    : (isEnglish ? 'No linked later works have been found yet.' : 'Todavía no se encontraron trabajos posteriores enlazados.');
  const visiblePapers = mode === 'graph' ? graphPapers : papers;
  const visibleEntries = useMemo(() => buildRelatedPaperEntries(visiblePapers), [visiblePapers]);
  const visibleStatus = mode === 'graph' ? graphStatus : relatedStatus;
  const sourceLabel = graph.source === 'opencitations'
    ? 'OpenCitations'
    : 'OpenCitations + OpenAlex';

  const currentPaperLabel = useMemo(() => {
    const title = String(paper?.title || (isEnglish ? 'Current paper' : 'Paper actual')).trim();
    return title.length > 38 ? `${title.slice(0, 38).trim()}…` : title;
  }, [isEnglish, paper?.title]);

  return (
    <div
      className={`related-overlay ${isClosing ? 'is-closing' : ''} ${selectedPaperKey ? 'is-selecting-paper' : ''}`}
      onClick={requestClose}
      role="presentation"
    >
      <section
        className={`related-sheet related-sheet--graph ${selectedPaperKey ? 'is-selecting-paper' : ''}`}
        onClick={event => event.stopPropagation()}
        onAnimationEnd={handleSheetAnimationEnd}
        onAnimationCancel={handleSheetAnimationEnd}
        aria-label={isEnglish ? 'Paper connections' : 'Conexiones del paper'}
        aria-modal="true"
        aria-busy={visibleStatus === 'loading'}
        role="dialog"
      >
        <div className="related-grabber" aria-hidden="true" />
        <header className="related-header">
          <div><Network size={18} /><h3>{isEnglish ? 'Paper connections' : 'Conexiones del paper'}</h3></div>
          <button onClick={requestClose} aria-label={isEnglish ? 'Close' : 'Cerrar'} title={isEnglish ? 'Close' : 'Cerrar'} autoFocus><X size={20} /></button>
        </header>

        <div className="related-mode-tabs" role="tablist" aria-label={isEnglish ? 'Connection type' : 'Tipo de conexión'}>
          <button
            className={mode === 'graph' ? 'is-active' : ''}
            onClick={() => setMode('graph')}
            disabled={!hasGraphIdentifier}
            role="tab"
            aria-selected={mode === 'graph'}
          >
            <GitBranch size={16} />{isEnglish ? 'Graph' : 'Grafo'}
          </button>
          <button
            className={mode === 'similar' ? 'is-active' : ''}
            onClick={() => setMode('similar')}
            role="tab"
            aria-selected={mode === 'similar'}
          >
            <Sparkles size={16} />{isEnglish ? 'Similar' : 'Similares'}
          </button>
        </div>

        {mode === 'graph' && (
          <div className="knowledge-path" aria-label={isEnglish ? 'Bibliographic lineage' : 'Linaje bibliográfico'}>
            <button
              className={graphSide === 'references' ? 'is-active' : ''}
              onClick={() => setGraphSide('references')}
              aria-pressed={graphSide === 'references'}
            >
              <BookOpen size={17} />
              <span><strong>{formatCompactCount(graph.counts.references, locale)}</strong><small>{isEnglish ? 'References' : 'Referencias'}</small></span>
            </button>
            <span className="knowledge-path-line" aria-hidden="true" />
            <div className="knowledge-path-current" title={paper?.title}>
              <Network size={18} />
              <span><strong>{isEnglish ? 'Current paper' : 'Paper actual'}</strong><small>{currentPaperLabel}</small></span>
            </div>
            <span className="knowledge-path-line" aria-hidden="true" />
            <button
              className={graphSide === 'citations' ? 'is-active' : ''}
              onClick={() => setGraphSide('citations')}
              aria-pressed={graphSide === 'citations'}
            >
              <GitBranch size={17} />
              <span><strong>{formatCompactCount(graph.counts.citations, locale)}</strong><small>{isEnglish ? 'Later works' : 'Posteriores'}</small></span>
            </button>
          </div>
        )}

        {visibleStatus === 'loading' && (
          <LoadingState label={mode === 'graph'
            ? (isEnglish ? 'Tracing the lineage...' : 'Trazando el linaje...')
            : (isEnglish ? 'Finding connections...' : 'Buscando conexiones...')} />
        )}
        {visibleStatus === 'unavailable' && (
          <div className="related-state">
            {isEnglish ? 'The bibliographic graph needs a valid DOI.' : 'El grafo bibliográfico necesita un DOI válido.'}
          </div>
        )}
        {visibleStatus === 'empty' && (
          <div className="related-state">
            {mode === 'graph'
              ? graphEmptyLabel
              : (isEnglish ? 'No recommendations are available for this paper.' : 'No hay recomendaciones disponibles para este paper.')}
          </div>
        )}
        {visibleStatus === 'error' && (
          <div className="related-state">
            {isEnglish
              ? 'These connections could not be loaded right now. The rest of PaperTok will continue to work normally.'
              : 'No se pudieron cargar estas conexiones ahora. El resto de PaperTok seguirá funcionando con normalidad.'}
          </div>
        )}

        {visibleStatus === 'ready' && (
          <div className="related-list" key={`${mode}-${graphSide}`}>
            {visibleEntries.length ? visibleEntries.map(({ paper: related, key }, index) => (
              <button
                key={key}
                className={`related-item ${selectedPaperKey === key ? 'is-selected' : ''}`}
                style={{ '--related-index': index }}
                onClick={() => requestPaper(related, key)}
                disabled={Boolean(selectedPaperKey)}
              >
                <span className="related-item-copy">
                  <strong><ScientificText>{related.title}</ScientificText></strong>
                  <small>
                    {related.authors.slice(0, 2).map(author => author.name || author).join(', ')}
                    {related.year ? ` · ${related.year}` : ''}
                    {related.citationCountKnown ? ` · ${related.citationCount} ${isEnglish ? 'citations' : 'citas'}` : ''}
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
