import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, FileText, Users, Loader2, ArrowLeft, Building2, Lightbulb, Briefcase, Sparkles, Compass, TrendingUp, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { searchAuthors, searchInstitutions, searchConcepts, searchSources } from '../../services/openAlexService';
import { searchProjects } from '../../services/openAireService';
import { OpenAlexAdapter } from '../../services/adapters/OpenAlexAdapter';
import { PaperBuilder } from '../../services/PaperBuilder';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import { motion } from 'framer-motion';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';

import './SearchPage.css';

const paperSearchAdapter = new OpenAlexAdapter();

function withTimeout(promise, fallback = [], timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(value);
    };
    const timeoutId = setTimeout(() => finish(fallback), timeoutMs);
    Promise.resolve(promise).then(finish).catch(() => finish(fallback));
  });
}

function FollowButton({ entity, isFollowing, isPending, onToggle }) {
  const following = isFollowing(entity);
  const pending = isPending(entity);

  return (
    <button
      className={`search-follow-btn ${following ? 'following' : ''} ${pending ? 'is-pending' : ''}`}
      onClick={(event) => onToggle(event, entity)}
      disabled={pending}
      aria-pressed={following}
    >
      {pending && <Loader2 className="spinning" size={14} />}
      {!pending && following && <Check size={14} />}
      <span>{pending ? 'Guardando...' : following ? 'Siguiendo' : 'Seguir'}</span>
    </button>
  );
}

function formatPaperDate(paper) {
  const dateValue = paper.published || paper.publishedDate;
  if (dateValue) {
    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString('es-ES');
  }
  return paper.year ? String(paper.year) : 'Fecha desconocida';
}

export default function SearchPage({ onSaveToList = () => {} }) {
  const navigate = useNavigate();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();
  
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
  
  const timeoutRef = useRef(null);

  const searchIdRef = useRef(0);
  const getInteractionState = useCallback((paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);

  const performSearch = useCallback(async (searchTerm) => {
    const searchId = ++searchIdRef.current;
    setIsSearching(true);
    setHasSearched(true);
    setPaperResults([]);
    setAuthorResults([]);
    setInstitutionResults([]);
    setConceptResults([]);
    setSourceResults([]);
    setProjectResults([]);

    const publish = (setter) => (results) => {
      if (searchId === searchIdRef.current) setter(results);
      return results;
    };

    const tasks = [
      withTimeout(
        paperSearchAdapter.search(searchTerm, 1)
          .then(result => PaperBuilder.deduplicate(result.papers || []).slice(0, 10)),
      ).then(publish(setPaperResults)),
      withTimeout(searchAuthors(searchTerm)).then(publish(setAuthorResults)),
      withTimeout(searchInstitutions(searchTerm)).then(publish(setInstitutionResults)),
      withTimeout(searchConcepts(searchTerm)).then(publish(setConceptResults)),
      withTimeout(searchSources(searchTerm)).then(publish(setSourceResults)),
      withTimeout(searchProjects(searchTerm).then(result => result.projects || []))
        .then(publish(setProjectResults)),
    ];

    await Promise.allSettled(tasks);
    if (searchId === searchIdRef.current) {
      setIsSearching(false);
    }
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      searchIdRef.current += 1;
      setTimeout(() => {
        setPaperResults([]);
        setAuthorResults([]);
        setInstitutionResults([]);
        setConceptResults([]);
        setSourceResults([]);
        setProjectResults([]);
        setIsSearching(false);
        setIsDebouncing(false);
        setHasSearched(false);
      }, 0);
      return;
    }

    searchIdRef.current += 1;
    setTimeout(() => {
      setIsDebouncing(true);
      setIsSearching(false);
    }, 0);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      setIsDebouncing(false);
      performSearch(query.trim());
    }, 350);
    
    return () => clearTimeout(timeoutRef.current);
  }, [query, performSearch]);

  const handleToggleFollow = async (e, entity) => {
    e.stopPropagation();
    try {
      await toggleFollow(entity);
    } catch (err) {
      console.error(err);
    }
  };

  const orcidMatch = query.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i);
  const cleanOrcid = orcidMatch ? orcidMatch[1].toUpperCase() : null;

  const hasResults = paperResults.length > 0
    || authorResults.length > 0
    || institutionResults.length > 0
    || conceptResults.length > 0
    || sourceResults.length > 0
    || projectResults.length > 0
    || !!cleanOrcid;

  const suggestedQueries = [
    { label: 'MIT', icon: <Building2 size={14} />, query: 'Massachusetts Institute of Technology' },
    { label: 'DeepMind', icon: <Building2 size={14} />, query: 'DeepMind' },
    { label: 'CRISPR Cas9', icon: <FileText size={14} />, query: 'CRISPR' },
    { label: 'Proyectos Horizon', icon: <Briefcase size={14} />, query: 'Horizon' },
    { label: 'Geoffrey Hinton', icon: <Users size={14} />, query: 'Geoffrey Hinton' },
    { label: 'Computación Cuántica', icon: <TrendingUp size={14} />, query: 'Quantum Computing' },
  ];

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
        <div className="search-results-list animate-fade-in">
            {(isSearching || isDebouncing) && !hasResults && (
              <div className="search-loading" role="status">
                <Loader2 className="spinning" size={36} />
                <span>Buscando en PaperTok...</span>
              </div>
            )}

            {(isSearching || isDebouncing) && hasResults && (
              <div className="search-progress" role="status">
                <Loader2 className="spinning" size={15} />
                Actualizando resultados
              </div>
            )}

            {!query && !isSearching && (
              <div className="search-initial-state animate-fade-in">
                <div className="search-initial-hero">
                  <Compass size={48} className="search-initial-icon" />
                  <h2>Explora el conocimiento</h2>
                  <p>Busca entre millones de papers, investigadores, universidades y proyectos financiados a nivel global.</p>
                </div>
                
                <div className="search-suggestions">
                  <h3 className="search-suggestions-title"><Sparkles size={16} /> Búsquedas sugeridas</h3>
                  <div className="search-suggestions-grid">
                    {suggestedQueries.map((item, idx) => (
                      <motion.button 
                        key={item.label}
                        onClick={() => setQuery(item.query)} 
                        className="search-suggestion-chip"
                        initial={{ opacity: 0, scale: 0.9, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: 0.6, delay: 0.1 + (idx * 0.05), type: 'spring' }}
                      >
                        {item.icon} {item.label}
                      </motion.button>
                    ))}
                  </div>
                </div>

              </div>
            )}

            {!hasResults && query && hasSearched && !isSearching && !isDebouncing && (
              <div className="search-empty">
                <Search size={40} className="search-empty-icon" />
                <p>No se encontraron resultados para "{query}"</p>
                <span>Intenta con otros términos o busca en inglés</span>
              </div>
            )}

            {/* Direct ORCID */}
            {cleanOrcid && (
              <div className="search-section">
                <h3 className="search-section-title">Búsqueda Directa ORCID</h3>
                <div className="search-item" onClick={() => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`)}>
                  <div className="search-item-icon" style={{ background: '#a6ce39', color: 'white' }}>
                    <Users size={22} />
                  </div>
                  <div className="search-item-info">
                    <h4 style={{ color: '#a6ce39' }}>Ver perfil ORCID de {cleanOrcid}</h4>
                    <p>Explorar autor e historial mediante su identificador único verificado</p>
                  </div>
                </div>
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
                      <p>{inst.country_code || 'País desconocido'} • Institución académica</p>
                    </div>
                    <FollowButton
                      entity={{ type: 'institution', id: inst.id, displayName: inst.display_name, source: 'openalex', externalIds: { ror: inst.ror || inst.id } }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
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
                      <p>{project.funder}{project.budget > 0 ? (() => { try { return ` • ${new Intl.NumberFormat('es-ES', { style: 'currency', currency: project.currency, maximumFractionDigits: 0 }).format(project.budget)}`; } catch { return ` • ${project.budget.toLocaleString('es-ES')} €`; } })() : ''}</p>
                    </div>
                    <FollowButton
                      entity={{ type: 'project', id: project.id, displayName: project.acronym || project.title, source: 'openaire', metadata: { funder: project.funder } }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
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
                    <FollowButton
                      entity={{ type: 'topic', id: concept.id, displayName: concept.display_name, source: 'papertok', metadata: { categoryIds: concept.categoryIds } }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
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
                  const authorFollow = { type: 'author', id: author.id, displayName: author.display_name, source: 'openalex', externalIds: { orcid: author.orcid } };
                  return (
                    <div key={author.id} className="search-item" onClick={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}>
                      <div className="search-item-avatar">
                        {author.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="search-item-info">
                        <h4>{author.display_name}</h4>
                        <p>{author.institution || 'Institución desconocida'}</p>
                      </div>
                      <FollowButton
                        entity={authorFollow}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* Papers */}
            {paperResults.length > 0 && (
              <div className="search-section">
                <h3 className="search-section-title">Publicaciones</h3>
                {paperResults.map(paper => {
                  const authors = (paper.authors || []).map(author => author.name || author);
                  return (
                    <div key={paper.id} className="search-item paper-item" onClick={() => setSelectedPaper(paper)}>
                      <div className="search-item-icon"><FileText size={22} /></div>
                      <div className="search-item-info">
                        <h4><ScientificText>{paper.title}</ScientificText></h4>
                        <p className="search-item-authors">{authors.slice(0, 3).join(', ')}{authors.length > 3 ? ` +${authors.length - 3}` : ''}</p>
                        <span className="search-item-meta">{formatPaperDate(paper)} • {paper.primaryCategory || paper.journal || 'Paper'}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
              isLiked={likedPaperIds.has(selectedPaper.id)}
              isSaved={savedPaperIds.has(selectedPaper.id)}
              isRead={readPaperIds.has(selectedPaper.id)}
              onLike={toggleLike}
              onNotInterested={(paper) => { markNotInterested(paper); setSelectedPaper(null); }}
              onMarkAsRead={markAsRead}
              onOpenPdf={(paper) => setPdfPaper(paper)}
              onSaveToList={onSaveToList}
              getInteractionState={getInteractionState}
              trackViewTime={trackViewTime}
              trackSkip={trackSkip}
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
    </div>
  );
}
