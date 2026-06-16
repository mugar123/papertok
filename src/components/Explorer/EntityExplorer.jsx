import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, FileText, TrendingUp, Clock, X } from 'lucide-react';
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
  const [pdfPaperToView, setPdfPaperToView] = useState(null);
  const [wikiInfo, setWikiInfo] = useState(null);
  const [isLoadingWiki, setIsLoadingWiki] = useState(false);

  useEffect(() => {
    async function loadEntity() {
      setIsLoadingEntity(true);
      setEntity(null);
      setPapers([]);
      setSearchQuery('');
      setSelectedCategory('All');
      setWikiInfo(null);
      
      const data = await getEntityById(type, id);
      setEntity(data);
      setIsLoadingEntity(false);

      if (data && data.display_name) {
        if (type === 'institution' || type === 'concept') {
          setIsLoadingWiki(true);
          try {
            const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(data.display_name)}`);
            if (res.ok) {
              const wikiData = await res.json();
              if (wikiData.extract) {
                setWikiInfo({
                  extract: wikiData.extract,
                  thumbnail: wikiData.thumbnail?.source || null,
                  url: wikiData.content_urls?.desktop?.page || ''
                });
              }
            } else {
              const resEn = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(data.display_name)}`);
              if (resEn.ok) {
                const wikiDataEn = await resEn.json();
                if (wikiDataEn.extract) {
                  setWikiInfo({
                    extract: wikiDataEn.extract,
                    thumbnail: wikiDataEn.thumbnail?.source || null,
                    url: wikiDataEn.content_urls?.desktop?.page || ''
                  });
                }
              }
            }
          } catch (e) {
            console.error("Failed to fetch Wikipedia info", e);
          } finally {
            setIsLoadingWiki(false);
          }
        }
      }
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
      const q = searchQuery.toLowerCase().trim();
      if (!q) return selectedCategory === 'All' || p.primaryCategory === selectedCategory;
      const matchesSearch = p.title.toLowerCase().includes(q) || 
                            p.authors.some(a => a.toLowerCase().includes(q)) ||
                            (p.summary && p.summary.toLowerCase().includes(q));
      const matchesCat = selectedCategory === 'All' || p.primaryCategory === selectedCategory;
      return matchesSearch && matchesCat;
    });
  }, [papers, searchQuery, selectedCategory]);

  // Handle author click from within overlay — close overlay first, then navigate
  const handleAuthorClick = useCallback((authors) => {
    setSelectedPaper(null);
    setPdfPaperToView(null);
    // Use setTimeout to allow overlay to close before navigating
    setTimeout(() => {
      navigate(`/explorer/author/${encodeURIComponent(authors[0])}`);
    }, 50);
  }, [navigate]);

  const sortLabel = sortBy === 'cited_by_count:desc' ? 'Más citados' : 'Más recientes';

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
    if (type === 'institution') return <Building2 size={36} />;
    if (type === 'concept') return <Lightbulb size={36} />;
    return <Users size={36} />;
  };

  const entityTypeLabel = type === 'institution' ? 'Universidad / Institución' : type === 'concept' ? 'Área de Interés' : 'Autor';

  return (
    <div className="explorer-container">
      {/* Compact Header */}
      <div className="explorer-hero">
        <div className="explorer-hero-top">
          <button className="explorer-back-btn" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <span className="ehc-type">{entityTypeLabel}</span>
        </div>
        
        <div className="explorer-hero-content">
          <div className="ehc-main">
            {wikiInfo?.thumbnail ? (
              <div className="ehc-wiki-image">
                <img src={wikiInfo.thumbnail} alt={entity.display_name} />
              </div>
            ) : (
              <div className="ehc-icon">{renderIcon()}</div>
            )}
            <div className="ehc-info">
              <h1 className="ehc-name">{entity.display_name}</h1>
              {type === 'institution' && (
                <p className="ehc-meta">
                  {entity.geo?.city}, {entity.geo?.country} • {entity.works_count?.toLocaleString()} obras
                </p>
              )}
              {type === 'concept' && (
                <p className="ehc-meta">
                  Nivel {entity.level} • {entity.works_count?.toLocaleString()} obras
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
          
          {wikiInfo && (
            <div className="ehc-wiki">
              <p>{wikiInfo.extract}</p>
              <a href={wikiInfo.url} target="_blank" rel="noopener noreferrer">Wikipedia →</a>
            </div>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="explorer-toolbar">
        <div className="explorer-search-box">
          <Search size={16} className="es-icon" />
          <input 
            type="text" 
            placeholder="Filtrar por título, autor o resumen..." 
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="es-clear" onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="explorer-sort-toggle">
          <button 
            className={`sort-btn ${sortBy === 'cited_by_count:desc' ? 'active' : ''}`}
            onClick={() => setSortBy('cited_by_count:desc')}
            title="Ordenar por número de citas"
          >
            <TrendingUp size={16} />
            <span>Citados</span>
          </button>
          <button 
            className={`sort-btn ${sortBy === 'publication_date:desc' ? 'active' : ''}`}
            onClick={() => setSortBy('publication_date:desc')}
            title="Ordenar por fecha de publicación"
          >
            <Clock size={16} />
            <span>Recientes</span>
          </button>
        </div>
      </div>

      {/* Category Filters */}
      {uniqueCategories.length > 1 && (
        <div className="explorer-categories">
          <button 
            className={`ec-pill ${selectedCategory === 'All' ? 'active' : ''}`}
            onClick={() => setSelectedCategory('All')}
          >
            Todos ({papers.length})
          </button>
          {uniqueCategories.map(cat => {
            const count = papers.filter(p => p.primaryCategory === cat).length;
            return (
              <button 
                key={cat}
                className={`ec-pill ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Papers List */}
      <div className="explorer-list custom-scrollbar">
        {isLoadingPapers ? (
          <div className="explorer-feed-loading">
            <Loader2 className="spinning" size={28} />
            <p>Cargando papers ({sortLabel})...</p>
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
                <p className="eli-authors">{paper.authors.slice(0, 4).join(', ')}{paper.authors.length > 4 ? ` +${paper.authors.length - 4}` : ''}</p>
                <p className="eli-summary">{paper.summary.length > 180 ? paper.summary.substring(0, 180) + '...' : paper.summary}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="explorer-empty">
            {searchQuery ? (
              <>
                <Search size={36} style={{ opacity: 0.4 }} />
                <p>No se encontraron papers con "{searchQuery}"</p>
                <button className="explorer-clear-btn" onClick={() => { setSearchQuery(''); setSelectedCategory('All'); }}>
                  Limpiar filtros
                </button>
              </>
            ) : (
              <p>No se encontraron papers disponibles en arXiv.</p>
            )}
          </div>
        )}
      </div>

      {/* Paper Card Overlay */}
      {selectedPaper && !pdfPaperToView && (
        <div className="explorer-overlay">
          <button 
            className="explorer-overlay-close" 
            onClick={() => setSelectedPaper(null)}
          >
            <ArrowLeft size={22} />
          </button>
          <div className="explorer-overlay-content">
            <PaperCard 
              paper={selectedPaper} 
              onOpenPdf={(paper) => setPdfPaperToView(paper)}
              onOpenAuthors={(authors) => handleAuthorClick(authors)} 
              trackViewTime={() => {}}
              trackSkip={() => {}}
            />
          </div>
        </div>
      )}

      {/* PDF Viewer Overlay */}
      {pdfPaperToView && (
        <div className="explorer-overlay" style={{ zIndex: 1001 }}>
          <PDFViewer paper={pdfPaperToView} onClose={() => setPdfPaperToView(null)} />
        </div>
      )}
    </div>
  );
}
