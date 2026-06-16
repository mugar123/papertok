import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, FileText } from 'lucide-react';
import { getEntityById, getWorksByEntity } from '../../services/openAlexService';
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
  const [sortBy, setSortBy] = useState('cited_by_count:desc');
  
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfUrlToView, setPdfUrlToView] = useState(null);

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

  const uniqueCategories = useMemo(() => {
    const cats = new Set();
    papers.forEach(p => {
      if (p.primaryCategory) cats.add(p.primaryCategory);
    });
    return Array.from(cats).sort();
  }, [papers]);

  const filteredPapers = useMemo(() => {
    return papers.filter(p => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = p.title.toLowerCase().includes(q) || 
                            p.authors.some(a => a.toLowerCase().includes(q));
      const matchesCat = selectedCategory === 'All' || p.primaryCategory === selectedCategory;
      return matchesSearch && matchesCat;
    });
  }, [papers, searchQuery, selectedCategory]);

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

      {/* Toolbar (Search & Sort) */}
      <div className="explorer-toolbar">
        <div className="explorer-search-box">
          <Search size={18} className="es-icon" />
          <input 
            type="text" 
            placeholder="Buscar papers en esta entidad..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
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

      {/* Category Filters */}
      {uniqueCategories.length > 0 && (
        <div className="explorer-categories">
          <button 
            className={`ec-pill ${selectedCategory === 'All' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('All')}
          >
            Todos
          </button>
          {uniqueCategories.map(cat => (
            <button 
              key={cat}
              className={`ec-pill ${selectedCategory === cat ? 'active' : ''}`}
              onClick={() => setSelectedCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Feed (List View) */}
      <div className="explorer-list custom-scrollbar">
        {isLoadingPapers ? (
          <div className="explorer-feed-loading">
            <Loader2 className="spinning" size={32} />
            <p>Cargando papers de arXiv...</p>
          </div>
        ) : filteredPapers.length > 0 ? (
          <div className="explorer-grid">
            {filteredPapers.map((paper, index) => (
              <div 
                key={paper.id + '-' + index} 
                className="explorer-list-item"
                onClick={() => setSelectedPaper(paper)}
              >
                <div className="eli-header">
                  <span className="eli-cat">{paper.primaryCategory}</span>
                  <span className="eli-date">{new Date(paper.published).toLocaleDateString()}</span>
                </div>
                <h3 className="eli-title">{paper.title}</h3>
                <p className="eli-authors">{paper.authors.join(', ')}</p>
                <p className="eli-summary">{paper.summary.length > 200 ? paper.summary.substring(0, 200) + '...' : paper.summary}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="explorer-empty">
            <p>No se encontraron papers con estos filtros.</p>
          </div>
        )}
      </div>

      {/* Paper Card Overlay */}
      {selectedPaper && !pdfUrlToView && (
        <div className="explorer-overlay">
          <button 
            className="explorer-overlay-close" 
            onClick={() => setSelectedPaper(null)}
            style={{ position: 'absolute', top: 'max(20px, env(safe-area-inset-top))', left: '20px', zIndex: 1000, background: 'rgba(0,0,0,0.5)', border: 'none', borderRadius: '50%', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', cursor: 'pointer', backdropFilter: 'blur(10px)' }}
          >
            <ArrowLeft size={24} />
          </button>
          <div style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
            <PaperCard 
              paper={selectedPaper} 
              onOpenPdf={(paper) => setPdfUrlToView(paper.pdfUrl)} 
            />
          </div>
        </div>
      )}

      {/* PDF Viewer Overlay */}
      {pdfUrlToView && (
        <div className="explorer-overlay" style={{ zIndex: 1001 }}>
          <PDFViewer pdfUrl={pdfUrlToView} onClose={() => setPdfUrlToView(null)} />
        </div>
      )}
    </div>
  );
}
