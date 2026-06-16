import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2 } from 'lucide-react';
import { getEntityById, getWorksByEntity, getArxivIdsForOpenAlexWorks } from '../../services/openAlexService';
import { fetchPapersByIds } from '../../services/arxivService';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import './EntityExplorer.css';

export default function EntityExplorer() {
  const { type, id } = useParams();
  const navigate = useNavigate();

  const [entity, setEntity] = useState(null);
  const [papers, setPapers] = useState([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(true);
  const [isLoadingPapers, setIsLoadingPapers] = useState(false);
  const [sortBy, setSortBy] = useState('cited_by_count:desc'); // 'cited_by_count:desc' or 'publication_date:desc'
  
  const [selectedPaper, setSelectedPaper] = useState(null);

  useEffect(() => {
    async function loadEntity() {
      setIsLoadingEntity(true);
      const data = await getEntityById(type, id);
      setEntity(data);
      setIsLoadingEntity(false);
    }
    loadEntity();
  }, [type, id]);

  useEffect(() => {
    async function loadPapers() {
      if (!entity) return;
      setIsLoadingPapers(true);
      
      try {
        const arxivIds = await getWorksByEntity(type, id, sortBy);
        if (arxivIds.length > 0) {
          const fetchedPapers = await fetchPapersByIds(arxivIds);
          setPapers(fetchedPapers);
        } else {
          setPapers([]);
        }
      } catch (err) {
        console.error("Failed to load papers for entity", err);
        setPapers([]);
      }
      setIsLoadingPapers(false);
    }
    loadPapers();
  }, [type, id, entity, sortBy]);

  if (isLoadingEntity) {
    return (
      <div className="explorer-loading">
        <Loader2 className="spinning" size={40} />
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="explorer-error">
        <button className="explorer-back-btn" onClick={() => navigate(-1)}>
          <ArrowLeft size={24} />
        </button>
        <h2>Entidad no encontrada</h2>
      </div>
    );
  }

  const renderIcon = () => {
    if (type === 'institution') return <Building2 size={48} />;
    if (type === 'concept') return <Lightbulb size={48} />;
    return <Users size={48} />;
  };

  const entityTypeLabel = type === 'institution' ? 'Universidad / Institución' : type === 'concept' ? 'Área de Interés' : 'Autor';

  return (
    <div className="explorer-container">
      {/* Header / Hero */}
      <div className="explorer-hero glass-panel">
        <button className="explorer-back-btn" onClick={() => navigate(-1)}>
          <ArrowLeft size={24} />
        </button>
        <div className="explorer-hero-content">
          <div className="ehc-icon">{renderIcon()}</div>
          <div className="ehc-info">
            <span className="ehc-type">{entityTypeLabel}</span>
            <h1 className="ehc-name">{entity.display_name}</h1>
            
            {/* Conditional Metadata based on type */}
            {type === 'institution' && (
              <p className="ehc-meta">
                {entity.geo?.city}, {entity.geo?.country} • {entity.works_count?.toLocaleString()} Obras globales
              </p>
            )}
            {type === 'concept' && (
              <p className="ehc-meta">
                Nivel {entity.level} • {entity.works_count?.toLocaleString()} Obras globales
                {entity.description && <span className="ehc-desc"><br/>{entity.description}</span>}
              </p>
            )}
            {type === 'author' && (
              <p className="ehc-meta">
                {entity.last_known_institutions?.[0]?.display_name || 'Institución desconocida'} • H-Index: {entity.summary_stats?.h_index}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="explorer-filters">
        <h3>Papers asociados ({papers.length})</h3>
        <div className="explorer-sort-toggle">
          <button 
            className={`sort-btn ${sortBy === 'cited_by_count:desc' ? 'active' : ''}`}
            onClick={() => setSortBy('cited_by_count:desc')}
          >
            Destacados
          </button>
          <button 
            className={`sort-btn ${sortBy === 'publication_date:desc' ? 'active' : ''}`}
            onClick={() => setSortBy('publication_date:desc')}
          >
            Recientes
          </button>
        </div>
      </div>

      {/* Feed */}
      <div className="explorer-feed custom-scrollbar">
        {isLoadingPapers ? (
          <div className="explorer-feed-loading">
            <Loader2 className="spinning" size={32} />
            <p>Cargando papers de arXiv...</p>
          </div>
        ) : papers.length > 0 ? (
          papers.map((paper, index) => (
            <PaperCard 
              key={paper.id + '-' + index} 
              paper={paper} 
              onOpenPdf={() => setSelectedPaper(paper)} 
            />
          ))
        ) : (
          <div className="explorer-empty">
            <p>No se encontraron papers en arXiv para esta entidad.</p>
          </div>
        )}
      </div>

      {selectedPaper && (
        <div className="explorer-overlay">
          <PDFViewer pdfUrl={selectedPaper.pdfUrl} onClose={() => setSelectedPaper(null)} />
        </div>
      )}
    </div>
  );
}
