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
      return;
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      performSearch(query);
    }, 600); // Debounce
    
    return () => clearTimeout(timeoutRef.current);
  }, [query]);

  const performSearch = async (searchTerm) => {
    setIsSearching(true);
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
        {isSearching && (
          <div className="search-loading">
            <Loader2 className="spinning" size={32} />
            <p>Buscando...</p>
          </div>
        )}

        {!isSearching && query && !hasResults && (
          <div className="search-empty">No se encontraron resultados para "{query}"</div>
        )}

        {!isSearching && hasResults && (
          <div className="search-grouped-results">
            
            {/* Authors Section */}
            {authorResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title"><Users size={16}/> Autores</h3>
                {authorResults.slice(0, 3).map(author => {
                  const isFollowing = followedAuthors.includes(author.display_name);
                  return (
                    <div key={author.id} className="search-result-author" onClick={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}>
                      <div className="sra-info">
                        <h3 className="sra-name">{author.display_name}</h3>
                        <p className="sra-inst">{author.institution || 'Institución desconocida'}</p>
                        <div className="sra-stats">
                          <span>H-Index: {author.h_index}</span> • <span>{author.cited_by_count} Citas</span>
                        </div>
                      </div>
                      <button 
                        className={`sra-follow-btn ${isFollowing ? 'following' : ''}`}
                        onClick={(e) => handleToggleFollow(e, author.display_name)}
                      >
                        {isFollowing ? 'Siguiendo' : 'Seguir'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Institutions Section */}
            {institutionResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title"><Building2 size={16}/> Universidades e Instituciones</h3>
                {institutionResults.slice(0, 3).map(inst => (
                  <div key={inst.id} className="search-result-entity" onClick={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)} style={{ cursor: 'pointer' }}>
                    <div className="sre-info">
                      <h3 className="sre-name">{inst.display_name} {inst.country_code && `(${inst.country_code})`}</h3>
                      <p className="sre-desc">{inst.type ? inst.type.charAt(0).toUpperCase() + inst.type.slice(1) : 'Institución'}</p>
                      <div className="sre-stats">
                        <span>{inst.works_count.toLocaleString()} Obras</span> • <span>{inst.cited_by_count.toLocaleString()} Citas</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Concepts Section */}
            {conceptResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title"><Lightbulb size={16}/> Áreas de Interés</h3>
                {conceptResults.slice(0, 3).map(concept => (
                  <div key={concept.id} className="search-result-entity" onClick={() => navigate(`/explorer/concept/${concept.id.split('/').pop()}`)} style={{ cursor: 'pointer' }}>
                    <div className="sre-info">
                      <h3 className="sre-name">{concept.display_name}</h3>
                      {concept.description && <p className="sre-desc">{concept.description}</p>}
                      <div className="sre-stats">
                        <span>Nivel {concept.level}</span> • <span>{concept.works_count.toLocaleString()} Obras referenciadas</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Papers Section */}
            {paperResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title"><FileText size={16}/> Papers</h3>
                {paperResults.map(paper => (
                  <div key={paper.id} className="search-result-card" onClick={() => setSelectedPaper(paper)}>
                    <h3 className="src-title">{paper.title}</h3>
                    <p className="src-authors">{paper.authors.join(', ')}</p>
                    <div className="src-meta">
                      <span className="src-cat">{paper.primaryCategory}</span>
                      <span className="src-date">{new Date(paper.published).toLocaleDateString()}</span>
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

