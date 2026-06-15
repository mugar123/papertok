import { useState, useEffect, useRef } from 'react';
import { Search, FileText, Users, Loader2, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { searchPapers } from '../../services/arxivService';
import { searchAuthors } from '../../services/openAlexService';
import { useAuth } from '../../context/AuthContext';
import AuthorPanel from '../Feed/AuthorPanel';
import PDFViewer from '../PDF/PDFViewer';
import './SearchPage.css';

export default function SearchPage() {
  const navigate = useNavigate();
  const { followedAuthors, toggleFollowAuthor } = useAuth();
  
  const [query, setQuery] = useState('');
  const [activeTab, setActiveTab] = useState('papers'); // 'papers' or 'authors'
  const [isSearching, setIsSearching] = useState(false);
  
  const [paperResults, setPaperResults] = useState([]);
  const [authorResults, setAuthorResults] = useState([]);
  
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (!query.trim()) {
      setPaperResults([]);
      setAuthorResults([]);
      return;
    }

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      performSearch(query);
    }, 600); // Debounce
    
    return () => clearTimeout(timeoutRef.current);
  }, [query, activeTab]);

  const performSearch = async (searchTerm) => {
    setIsSearching(true);
    try {
      if (activeTab === 'papers') {
        const results = await searchPapers(searchTerm, 0, 20);
        setPaperResults(results);
      } else {
        const results = await searchAuthors(searchTerm);
        setAuthorResults(results);
      }
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
            placeholder={activeTab === 'papers' ? "Buscar papers, temas, IDs..." : "Buscar investigadores..."}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="search-tabs">
        <button 
          className={`search-tab ${activeTab === 'papers' ? 'active' : ''}`}
          onClick={() => setActiveTab('papers')}
        >
          <FileText size={18} /> Papers
        </button>
        <button 
          className={`search-tab ${activeTab === 'authors' ? 'active' : ''}`}
          onClick={() => setActiveTab('authors')}
        >
          <Users size={18} /> Autores
        </button>
      </div>

      {/* Results */}
      <div className="search-results custom-scrollbar">
        {isSearching && (
          <div className="search-loading">
            <Loader2 className="spinning" size={32} />
            <p>Buscando...</p>
          </div>
        )}

        {!isSearching && query && activeTab === 'papers' && paperResults.length === 0 && (
          <div className="search-empty">No se encontraron papers para "{query}"</div>
        )}
        
        {!isSearching && query && activeTab === 'authors' && authorResults.length === 0 && (
          <div className="search-empty">No se encontraron autores para "{query}"</div>
        )}

        {!isSearching && activeTab === 'papers' && paperResults.map(paper => (
          <div key={paper.id} className="search-result-card" onClick={() => setSelectedPaper(paper)}>
            <h3 className="src-title">{paper.title}</h3>
            <p className="src-authors">{paper.authors.join(', ')}</p>
            <div className="src-meta">
              <span className="src-cat">{paper.primaryCategory}</span>
              <span className="src-date">{new Date(paper.published).toLocaleDateString()}</span>
            </div>
          </div>
        ))}

        {!isSearching && activeTab === 'authors' && authorResults.map(author => {
          const isFollowing = followedAuthors.includes(author.display_name);
          return (
            <div key={author.id} className="search-result-author" onClick={() => setSelectedAuthor(author.display_name)}>
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
