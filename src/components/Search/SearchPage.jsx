import { useState, useEffect, useRef } from 'react';
import { Search, FileText, Users, Loader2, ArrowLeft, Building2, Lightbulb } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { searchPapers } from '../../services/arxivService';
import { searchAuthors, searchInstitutions, searchConcepts } from '../../services/openAlexService';
import { useAuth } from '../../context/AuthContext';
import AuthorPanel from '../Feed/AuthorPanel';
import PDFViewer from '../PDF/PDFViewer';
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
  
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) {
      setPaperResults([]);
      setAuthorResults([]);
      setInstitutionResults([]);
      setConceptResults([]);
      setIsDebouncing(false);
      setHasSearched(false);
      return;
    }

    setIsDebouncing(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      setIsDebouncing(false);
      performSearch(query);
    }, 600); // Debounce
    
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  const performSearch = async (searchTerm) => {
    setIsSearching(true);
    setHasSearched(true);
    try {
      const [papers, authors, institutions, concepts] = await Promise.all([
        searchPapers(searchTerm, 0, 10).catch(() => []),
        searchAuthors(searchTerm).catch(() => []),
        searchInstitutions(searchTerm).catch(() => []),
        searchConcepts(searchTerm).catch(() => [])
      ]);
      
      setPaperResults(papers);
      setAuthorResults(authors);
      setInstitutionResults(institutions);
      setConceptResults(concepts);
    } catch (err) {
      console.error(err);
    }
    setIsSearching(false);
  };

  const handleToggleFollow = async (e, authorName) => {
    e.stopPropagation();
    try {
      await toggleFollowAuthor(authorName);
    } catch (err) {
      console.error(err);
    }
  };

  const hasResults = paperResults.length > 0 || authorResults.length > 0 || institutionResults.length > 0 || conceptResults.length > 0;

  return (
    <div className="search-page-container">
      {/* Header */}
      <div className="search-header glass-panel">
        <button className="search-back-btn" onClick={() => navigate('/')}>
          <ArrowLeft size={24} />
        </button>
        <div className="search-input-wrapper">
          <Search className="search-icon" size={20} />
          <input 
            type="text" 
            className="search-input"
            placeholder="Buscar papers, autores, universidades, temas..."
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
            <Loader2 className="spinning" size={40} />
            <p>{isDebouncing ? 'Escribiendo...' : 'Buscando...'}</p>
          </div>
        ) : (
          <div className="search-results-list animate-fade-in">
            {!hasResults && query && hasSearched && (
              <div className="search-empty">
                <Search size={48} className="search-empty-icon" />
                <p>No se encontraron resultados para "{query}"</p>
                <span>Intenta con otros términos o busca en inglés</span>
              </div>
            )}

            {/* Institutions */}
            {institutionResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Universidades e Instituciones</h3>
                {institutionResults.map(inst => (
                  <div key={inst.id} className="search-item" onClick={() => navigate(`/explore/institution/${inst.id}`)}>
                    <div className="search-item-icon"><Building2 size={24} /></div>
                    <div className="search-item-info">
                      <h4>{inst.display_name}</h4>
                      <p>{inst.geo?.city || 'Ciudad desconocida'}, {inst.geo?.country || 'País desconocido'} • {inst.works_count?.toLocaleString()} obras</p>
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
                  <div key={concept.id} className="search-item" onClick={() => navigate(`/explore/concept/${concept.id}`)}>
                    <div className="search-item-icon"><Lightbulb size={24} /></div>
                    <div className="search-item-info">
                      <h4>{concept.display_name}</h4>
                      <p>Nivel {concept.level} • {concept.works_count?.toLocaleString()} obras relacionadas</p>
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
                    <div key={author.id} className="search-item" onClick={() => navigate(`/explore/author/${encodeURIComponent(author.display_name)}`)}>
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
                    <div className="search-item-icon"><FileText size={24} /></div>
                    <div className="search-item-info">
                      <h4>{paper.title}</h4>
                      <p className="search-item-authors">{paper.authors.join(', ')}</p>
                      <span className="search-item-meta">{new Date(paper.published).toLocaleDateString()} • {paper.primaryCategory}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}


          </div>
        )}
      </div>

      {/* Overlays */}
      {selectedPaper && (
        <div className="search-overlay">
          <PDFViewer 
            pdfUrl={selectedPaper.pdfUrl} 
            onClose={() => setSelectedPaper(null)} 
          />
        </div>
      )}
      
      {selectedAuthor && (
        <AuthorPanel 
          authors={[selectedAuthor]} 
          onClose={() => setSelectedAuthor(null)}
          onOpenPdf={(paper) => setSelectedPaper(paper)}
        />
      )}
    </div>
  );
}

