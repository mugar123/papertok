import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, FileText, Users, Loader2, ArrowLeft, Building2, Lightbulb, Briefcase } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { searchPapers } from '../../services/arxivService';
import { searchAuthors, searchInstitutions, searchConcepts, searchSources } from '../../services/openAlexService';
import { searchProjects } from '../../services/openAireService';
import { useAuth } from '../../context/AuthContext';
import { AnimatePresence } from 'framer-motion';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import AuthorPanel from '../Feed/AuthorPanel';
import './SearchPage.css';

export default function SearchPage() {
  const navigate = useNavigate();
  const { followedAuthors, toggleFollowAuthor } = useAuth();
  
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isDebouncing, setIsDebouncing] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  
  const [paperResults, setPaperResults] = useState([]);
  const [authorResults, setAuthorResults] = useState([]);
  const [institutionResults, setInstitutionResults] = useState([]);
  const [conceptResults, setConceptResults] = useState([]);
  const [sourceResults, setSourceResults] = useState([]);
  const [projectResults, setProjectResults] = useState([]);
  
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfPaper, setPdfPaper] = useState(null);
  const [activeAuthors, setActiveAuthors] = useState(null);
  
  const timeoutRef = useRef(null);

  const searchIdRef = useRef(0);

  useEffect(() => {
    if (!query.trim()) {
      setPaperResults([]);
      setAuthorResults([]);
      setInstitutionResults([]);
      setConceptResults([]);
      setSourceResults([]);
      setProjectResults([]);
      setIsDebouncing(false);
      setHasSearched(false);
      return;
    }

    setIsDebouncing(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      setIsDebouncing(false);
      performSearch(query);
    }, 600);
    
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  const performSearch = async (searchTerm) => {
    const searchId = ++searchIdRef.current;
    setIsSearching(true);
    setHasSearched(true);
    try {
      const [papers, authors, institutions, concepts, sources, projects] = await Promise.all([
        searchPapers(searchTerm, 0, 10).catch(() => []),
        searchAuthors(searchTerm).catch(() => []),
        searchInstitutions(searchTerm).catch(() => []),
        searchConcepts(searchTerm).catch(() => []),
        searchSources(searchTerm).catch(() => []),
        searchProjects(searchTerm).then(res => res.projects).catch(() => [])
      ]);
      
      if (searchId === searchIdRef.current) {
        setPaperResults(papers);
        setAuthorResults(authors);
        setInstitutionResults(institutions);
        setConceptResults(concepts);
        setSourceResults(sources);
        setProjectResults(projects);
        setIsSearching(false);
      }
    } catch (err) {
      console.error(err);
      if (searchId === searchIdRef.current) {
        setIsSearching(false);
      }
    }
  };

  const handleToggleFollow = async (e, authorName) => {
    e.stopPropagation();
    try {
      await toggleFollowAuthor(authorName);
    } catch (err) {
      console.error(err);
    }
  };

  // Handle author click from PaperCard overlay
  const handleAuthorClick = useCallback((authors, arxivId) => {
    setSelectedPaper(null);
    setPdfPaper(null);
    setActiveAuthors({ authors, arxivId });
  }, []);

  const hasResults = paperResults.length > 0 || authorResults.length > 0 || institutionResults.length > 0 || conceptResults.length > 0 || sourceResults.length > 0;

  return (
    <div className="search-page-container">
      {/* Header */}
      <div className="search-header">
        <button className="search-back-btn" onClick={() => navigate('/')}>
          <ArrowLeft size={22} />
        </button>
        <div className="search-input-wrapper">
          <Search className="search-icon" size={18} />
          <input 
            type="text" 
            className="search-input"
            placeholder="Buscar papers, autores, universidades..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {/* Results */}
      <div className="search-results custom-scrollbar">
        {isSearching || isDebouncing ? (
          <div className="search-loading">
            <Loader2 className="spinning" size={36} />
          </div>
        ) : (
          <div className="search-results-list animate-fade-in">
            {!hasResults && query && hasSearched && (
              <div className="search-empty">
                <Search size={40} className="search-empty-icon" />
                <p>No se encontraron resultados para "{query}"</p>
                <span>Intenta con otros términos o busca en inglés</span>
              </div>
            )}

            {/* Institutions */}
            {institutionResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Universidades e Instituciones</h3>
                {institutionResults.map(inst => (
                  <div key={inst.id} className="search-item" onClick={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)}>
                    <div className="search-item-icon"><Building2 size={22} /></div>
                    <div className="search-item-info">
                      <h4>{inst.display_name}</h4>
                      <p>{inst.geo?.city || 'Ciudad desconocida'}, {inst.geo?.country || 'País desconocido'} • {inst.works_count?.toLocaleString()} obras</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Projects */}
            {projectResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Proyectos de Investigación</h3>
                {projectResults.map(project => (
                  <div key={project.id} className="search-item" onClick={() => navigate(`/explorer/project/${project.id}?name=${encodeURIComponent(project.acronym || project.title)}&funder=${encodeURIComponent(project.funder)}`)}>
                    <div className="search-item-icon"><Briefcase size={22} /></div>
                    <div className="search-item-info">
                      <h4>{project.acronym ? `${project.acronym}: ${project.title}` : project.title}</h4>
                      <p>{project.funder}{project.budget > 0 ? ` • ${new Intl.NumberFormat('es-ES', { style: 'currency', currency: project.currency || 'EUR', maximumFractionDigits: 0 }).format(project.budget)}` : ''}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Concepts */}
            {conceptResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Temas y Áreas</h3>
                {conceptResults.map(concept => (
                  <div key={concept.id} className="search-item" onClick={() => navigate(`/explorer/concept/${concept.id.split('/').pop()}`)}>
                    <div className="search-item-icon"><Lightbulb size={22} /></div>
                    <div className="search-item-info">
                      <h4>{concept.display_name}</h4>
                      <p>Nivel {concept.level} • {concept.works_count?.toLocaleString()} obras relacionadas</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sources (Journals) */}
            {sourceResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Revistas y Publicaciones</h3>
                {sourceResults.map(source => (
                  <div key={source.id} className="search-item" onClick={() => navigate(`/explorer/source/${source.id.split('/').pop()}`)}>
                    <div className="search-item-icon"><FileText size={22} /></div>
                    <div className="search-item-info">
                      <h4>{source.display_name}</h4>
                      <p>{source.host_organization_name ? `${source.host_organization_name} • ` : ''}{source.works_count?.toLocaleString()} obras relacionadas</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Authors */}
            {authorResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Autores</h3>
                {authorResults.map(author => {
                  const isFollowing = followedAuthors.includes(author.display_name);
                  return (
                    <div key={author.id} className="search-item" onClick={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}>
                      <div className="search-item-avatar">
                        {author.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="search-item-info">
                        <h4>{author.display_name}</h4>
                        <p>{author.last_known_institutions?.[0]?.display_name || 'Institución desconocida'}</p>
                      </div>
                      <button 
                        className={`search-follow-btn ${isFollowing ? 'following' : ''}`}
                        onClick={(e) => handleToggleFollow(e, author.display_name)}
                      >
                        {isFollowing ? 'Siguiendo' : 'Seguir'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Papers */}
            {paperResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Papers Recientes</h3>
                {paperResults.map(paper => (
                  <div key={paper.id} className="search-item paper-item" onClick={() => setSelectedPaper(paper)}>
                    <div className="search-item-icon"><FileText size={22} /></div>
                    <div className="search-item-info">
                      <h4>{paper.title}</h4>
                      <p className="search-item-authors">{paper.authors.slice(0, 3).join(', ')}{paper.authors.length > 3 ? ` +${paper.authors.length - 3}` : ''}</p>
                      <span className="search-item-meta">{new Date(paper.published).toLocaleDateString()} • {paper.primaryCategory}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Paper Card Overlay */}
      {selectedPaper && !pdfPaper && (
        <div className="search-overlay">
          <button 
            className="search-back-btn" 
            onClick={() => setSelectedPaper(null)}
            style={{ position: 'absolute', top: 'max(16px, env(safe-area-inset-top))', left: '16px', zIndex: 1200, background: 'rgba(255,255,255,0.1)', width: '40px', height: '40px' }}
          >
            <ArrowLeft size={22} />
          </button>
          <div style={{ height: '100%', width: '100%', overflow: 'hidden' }}>
            <PaperCard 
              paper={selectedPaper} 
              onOpenPdf={(paper) => setPdfPaper(paper)}
              onOpenAuthors={(authors) => handleAuthorClick(authors, selectedPaper.arxivId)}
              trackViewTime={() => {}}
              trackSkip={() => {}}
            />
          </div>
        </div>
      )}

      {/* PDF Viewer */}
      {pdfPaper && (
        <div className="search-overlay" style={{ zIndex: 1200 }}>
          <PDFViewer paper={pdfPaper} onClose={() => setPdfPaper(null)} />
        </div>
      )}

      {/* Author Panel Overlay */}
      <AnimatePresence>
        {activeAuthors && (
          <AuthorPanel 
            authors={activeAuthors.authors} 
            sourceArxivId={activeAuthors.arxivId}
            onClose={() => setActiveAuthors(null)}
            onOpenPdf={(paper) => {
              setActiveAuthors(null);
              setPdfPaper(paper);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
