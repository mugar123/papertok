import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, X, Share2, ExternalLink, Filter, SlidersHorizontal, ChevronRight, ChevronDown, ChevronUp, BadgeCheck, FileText, Briefcase, Globe, MapPin, BookOpen, Download, Eye, Award, Tag } from 'lucide-react';
import { getEntityById, getWorksByEntity, getAuthorsByEntity, enrichPapersBatch, fetchPapersByDois, getAuthorProfileExact, findInstitution } from '../../services/openAlexService';
import { fetchPapersByIds, getAuthorPapers } from '../../services/arxivService';
import { getPapersByProject, getProjectDetails } from '../../services/openAireService';
import { getOrcidRecord } from '../../services/orcidService';
import { AnimatePresence, motion } from 'framer-motion';
import { CATEGORIES } from '../../data/categories';
import { useAuth } from '../../context/AuthContext';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import './EntityExplorer.css';

export default function EntityExplorer() {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { followedAuthors, toggleFollowAuthor } = useAuth();

  const [entity, setEntity] = useState(null);
  const [papers, setPapers] = useState([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(true);
  const [isLoadingPapers, setIsLoadingPapers] = useState(false);
  const [sortBy, setSortBy] = useState('cited_by_count:desc');
  
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfPaperToView, setPdfPaperToView] = useState(null);
  const [wikiInfo, setWikiInfo] = useState(null);
  const [orcidInfo, setOrcidInfo] = useState(null);
  const [isLoadingOrcid, setIsLoadingOrcid] = useState(false);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const observerRef = useRef(null);

  const [activeTab, setActiveTab] = useState('papers');
  const [expandedSummary, setExpandedSummary] = useState(false);
  
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    category: '',
    peerReviewed: false,
    dateRange: ''
  });

  const [entityAuthors, setEntityAuthors] = useState([]);
  const [isLoadingAuthors, setIsLoadingAuthors] = useState(false);
  const [isFetchingMoreAuthors, setIsFetchingMoreAuthors] = useState(false);
  const [authorsPage, setAuthorsPage] = useState(1);
  const [hasMoreAuthors, setHasMoreAuthors] = useState(false);
  const observerAuthorsRef = useRef(null);

  // Reset overlays when navigating to a different entity
  useEffect(() => {
    setTimeout(() => {
      setSelectedPaper(null);
      setPdfPaperToView(null);
      setOrcidInfo(null);
      setActiveTab('papers');
    }, 0);
  }, [type, id]);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
      setAuthorsPage(1);
    }, 600);
    return () => clearTimeout(handler);
  }, [searchQuery]);

  useEffect(() => {
    setTimeout(() => {
      setPage(1);
      setAuthorsPage(1);
    }, 0);
  }, [type, id, sortBy, filters]);

  useEffect(() => {
    async function loadEntity() {
      setIsLoadingEntity(true);
      if (type === 'project') {
        const urlParams = new URLSearchParams(window.location.search);
        let name = urlParams.get('name') || id;
        let funder = urlParams.get('funder') || '';
        
        // Optimistic display
        setEntity({ display_name: name, type: 'project', funder });
        
        // Fetch detailed info
        const details = await getProjectDetails(id);
        if (details) {
           const displayName = details.acronym 
             ? `${details.acronym}: ${details.title}` 
             : details.title;
           setEntity({
             display_name: displayName,
             type: 'project',
             funder: details.funder,
             fundingStream: details.fundingStream,
             summary: details.summary,
             startDate: details.startDate,
             endDate: details.endDate,
             budget: details.budget,
             fundedAmount: details.fundedAmount,
             currency: details.currency,
             callIdentifier: details.callIdentifier,
             contractType: details.contractType,
             subjects: details.subjects,
             participants: details.participants,
             measures: details.measures,
             openAccess: details.openAccess,
           });
        }
        setIsLoadingEntity(false);
        return;
      }
      setEntity(null);
      setPapers([]);
      setSearchQuery('');
      setWikiInfo(null);
      
      let data;
      const isOpenAlexId = /^A\d+$/.test(id) || id.startsWith('http');
      
      if (type === 'author' && !isOpenAlexId) {
        const arxivId = searchParams.get('arxivId');
        data = await getAuthorProfileExact(id, arxivId);
      } else {
        data = await getEntityById(type, id);
      }
      
      setEntity(data);
      setIsLoadingEntity(false);

      if (data && data.display_name) {
        if (type === 'author' && data.orcid) {
          setIsLoadingOrcid(true);
          getOrcidRecord(data.orcid)
            .then(record => setOrcidInfo(record))
            .catch(e => console.error("Error loading ORCID", e))
            .finally(() => setIsLoadingOrcid(false));
        }

        if (type === 'institution' || type === 'concept' || type === 'source') {
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
          }
        }
      }
    }
    loadEntity();
  }, [type, id, searchParams]);

  useEffect(() => {
    async function loadPapers() {
      if (!entity || activeTab !== 'papers') return;
      if (page === 1) setIsLoadingPapers(true);
      else setIsFetchingMore(true);
      
      try {
        let arxivIds = [];
        let dois = [];
        let total = 0;
        let fetchedPapers = [];
        
        const resolvedId = entity.id || id;
        
        if (type === 'project') {
           const res = await getPapersByProject(resolvedId, page);
           arxivIds = res.arxivIds;
           dois = res.dois || [];
           total = res.total;
        } else if (type === 'author' && resolvedId.startsWith('stub-')) {
           const arxivPapers = await getAuthorPapers(entity.display_name, 30);
           fetchedPapers.push(...arxivPapers);
           total = arxivPapers.length;
        } else {
           const res = await getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters);
           arxivIds = res.arxivIds;
           total = res.total;
        }
        
        // 1. Fetch arXiv papers
        if (arxivIds.length > 0) {
          const rawPapers = await fetchPapersByIds(arxivIds);
          const enrichmentMap = await enrichPapersBatch(arxivIds);
          const enrichedArxiv = rawPapers.map(paper => {
            const enriched = enrichmentMap[paper.id];
            if (!enriched) return paper;
            return {
              ...paper,
              citationCount: enriched.cited_by_count,
              topics: enriched.concepts ? enriched.concepts.slice(0, 3) : [],
              isPeerReviewed: enriched.isPeerReviewed,
              _isOpenAlexEnriched: true
            };
          });
          fetchedPapers.push(...enrichedArxiv);
        }
        
        // 2. Fetch non-arXiv DOIs directly from OpenAlex
        if (dois.length > 0) {
          const doiPapers = await fetchPapersByDois(dois);
          fetchedPapers.push(...doiPapers);
        }        
        // 3. Guarantee source paper is ALWAYS first in the list
        if (page === 1) {
           const sourceArxivId = searchParams.get('arxivId');
           if (sourceArxivId) {
             const cleanSourceId = sourceArxivId.replace(/v\d+$/, '');
             const sourceIndex = fetchedPapers.findIndex(p => p.id && p.id.replace(/v\d+$/, '') === cleanSourceId);
             
             if (sourceIndex !== -1) {
               // Paper exists in the list, move it to the front
               const [sourcePaper] = fetchedPapers.splice(sourceIndex, 1);
               fetchedPapers.unshift(sourcePaper);
             } else {
               // Paper is missing, fetch it and put it in front
               try {
                 const sourcePaperReq = await fetchPapersByIds([cleanSourceId]);
                 if (sourcePaperReq && sourcePaperReq.length > 0) {
                   fetchedPapers.unshift(sourcePaperReq[0]);
                 }
               } catch (e) {
                 console.error("Failed to fetch source paper failsafe", e);
               }
             }
           }
        }

        if (page === 1) {
          setPapers(fetchedPapers);
        } else {
          setPapers(prev => {
             const existingIds = new Set(prev.map(p => p.id));
             const newPapers = fetchedPapers.filter(p => !existingIds.has(p.id));
             return [...prev, ...newPapers];
          });
        }
        setHasMore(page * 30 < total);
      } catch (err) {
        console.error("Failed to load papers for entity", err);
        if (page === 1) setPapers([]);
        setHasMore(false); // Stop infinite looping on errors
      }
      setIsLoadingPapers(false);
      setIsFetchingMore(false);
    }
    loadPapers();
  }, [type, id, entity, sortBy, page, debouncedSearch, filters, activeTab, searchParams]);

  useEffect(() => {
    async function loadAuthors() {
      if (!entity || type === 'author' || activeTab !== 'authors') return;
      if (authorsPage === 1) setIsLoadingAuthors(true);
      else setIsFetchingMoreAuthors(true);
      
      try {
        const resolvedId = entity.id || id;
        const { authors, total } = await getAuthorsByEntity(type, resolvedId, authorsPage, debouncedSearch);
        
        if (authorsPage === 1) {
          setEntityAuthors(authors);
        } else {
          setEntityAuthors(prev => {
            const existingIds = new Set(prev.map(a => a.id));
            const newAuthors = authors.filter(a => !existingIds.has(a.id));
            return [...prev, ...newAuthors];
          });
        }
        setHasMoreAuthors(authorsPage * 30 < total);
      } catch (err) {
        console.error("Failed to load authors for entity", err);
        setHasMoreAuthors(false); // Stop infinite looping on errors
      }
      setIsLoadingAuthors(false);
      setIsFetchingMoreAuthors(false);
    }
    loadAuthors();
  }, [type, id, entity, authorsPage, debouncedSearch, activeTab]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          if (activeTab === 'papers' && hasMore && !isLoadingPapers && !isFetchingMore) {
            setPage(p => p + 1);
          } else if (activeTab === 'authors' && hasMoreAuthors && !isLoadingAuthors && !isFetchingMoreAuthors) {
            setAuthorsPage(p => p + 1);
          }
        }
      },
      { threshold: 0.1 }
    );
    if (activeTab === 'papers' && observerRef.current) observer.observe(observerRef.current);
    if (activeTab === 'authors' && observerAuthorsRef.current) observer.observe(observerAuthorsRef.current);
    return () => observer.disconnect();
  }, [hasMore, isLoadingPapers, isFetchingMore, hasMoreAuthors, isLoadingAuthors, isFetchingMoreAuthors, activeTab]);

  const filteredPapers = useMemo(() => {
    return papers;
  }, [papers]);

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: entity?.display_name || 'PaperTok',
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href);
      alert('Enlace copiado al portapapeles');
    }
  };

  if (isLoadingEntity) return (
      <div className="explorer-container">
        <div className="explorer-hero">
          <div className="explorer-hero-top">
            <div className="eht-left">
              <button className="explorer-back-btn" onClick={() => navigate(-1)}>
                <ArrowLeft size={20} />
              </button>
              <div className="skeleton-item" style={{ width: '80px', height: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="explorer-action-btn skeleton-item" style={{ border: 'none', background: 'rgba(255,255,255,0.05)' }}></button>
            </div>
          </div>
          
          <div className="explorer-hero-content">
            <div className="ehc-main">
              <div className="ehc-icon skeleton-item" style={{ background: 'rgba(255,255,255,0.05)', borderColor: 'transparent' }}></div>
              <div className="ehc-info" style={{ width: '100%' }}>
                <div className="skeleton-item skeleton-title" style={{ width: '200px', maxWidth: '80%', height: '28px', margin: '0 0 12px 0' }}></div>
                <div className="skeleton-item skeleton-text medium"></div>
                <div className="skeleton-item skeleton-text short"></div>
              </div>
            </div>
            
            <div className="ehc-stats-grid">
              {[1, 2, 3].map(i => (
                <div key={i} className="ehc-stat-box skeleton-item" style={{ height: '60px', background: 'rgba(255,255,255,0.03)' }}></div>
              ))}
            </div>
          </div>
        </div>

        <div className="explorer-content">
          <div className="explorer-list">
            {[1, 2, 3].map(i => (
             <div key={i} className="explorer-list-item skeleton-item" style={{ height: '160px', marginBottom: '16px', borderRadius: '16px', background: 'rgba(255,255,255,0.02)' }}></div>
            ))}
          </div>
        </div>
      </div>
    );

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
    if (type === 'source') return <FileText size={36} />;
    if (type === 'project') return <Briefcase size={36} />;
    return <Users size={36} />;
  };

  const entityTypeLabel = type === 'author' ? 'Autor' : type === 'institution' ? 'Universidad / Institución' : type === 'source' ? 'Revista' : type === 'project' ? 'Proyecto de Investigación' : 'Tema';
  const topConcepts = entity.x_concepts ? entity.x_concepts.slice(0, 4) : [];

  return (
    <div className="explorer-container">
      {/* Immersive Hero */}
      <div className="explorer-hero">
        <AnimatePresence>
          {wikiInfo?.thumbnail && (
            <motion.div 
              key="bg-blur"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.0 }}
              className="ehc-bg-blur" 
              style={{ backgroundImage: `url(${wikiInfo.thumbnail})` }}
            ></motion.div>
          )}
        </AnimatePresence>
        
        <div className="explorer-hero-top">
          <div className="eht-left">
            <button className="explorer-back-btn" onClick={() => navigate(-1)}>
              <ArrowLeft size={20} />
            </button>
            <span className="ehc-type">{entityTypeLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="explorer-action-btn" onClick={handleShare} title="Compartir">
              <Share2 size={18} />
            </button>
          </div>
        </div>
        
        <div className="explorer-hero-content">
          <div className="ehc-main">
            <AnimatePresence mode="wait">
              {wikiInfo?.thumbnail ? (
                <motion.div 
                  key="wiki-image"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.6 }}
                  className="ehc-wiki-image"
                >
                  <img src={wikiInfo.thumbnail} alt={entity.display_name} />
                </motion.div>
              ) : (
                <motion.div 
                  key="icon"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                  className="ehc-icon"
                >
                  {renderIcon()}
                </motion.div>
              )}
            </AnimatePresence>
            <div className="ehc-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <h1 className="ehc-name" style={{ margin: 0 }}>{entity.display_name}</h1>
                {type === 'author' && entity?.display_name && (
                  <button 
                    className={`search-follow-btn ${followedAuthors.includes(entity.display_name) ? 'following' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleFollowAuthor(entity.display_name); }}
                    style={{ transform: 'scale(0.9)', transformOrigin: 'left center' }}
                  >
                    {followedAuthors.includes(entity.display_name) ? 'Siguiendo' : 'Seguir'}
                  </button>
                )}
              </div>
              {type === 'institution' && (
                <p className="ehc-meta">
                  {entity.geo?.city}, {entity.geo?.country}
                </p>
              )}
              {type === 'author' && (entity.institution || entity.last_known_institutions?.[0]?.display_name) && (
                <p className="ehc-meta" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Building2 size={14} /> 
                  {entity.last_known_institutions?.[0]?.id ? (
                    <span 
                      onClick={() => navigate(`/explorer/institution/${entity.last_known_institutions[0].id.split('/').pop()}`)}
                      style={{ cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      {entity.institution || entity.last_known_institutions[0].display_name}
                    </span>
                  ) : (
                    <span>{entity.institution || entity.last_known_institutions[0].display_name}</span>
                  )}
                </p>
              )}
              {type === 'project' && entity.funder && (
                <p className="ehc-meta">
                  {entity.funder}{entity.fundingStream ? ` — ${entity.fundingStream}` : ''}
                </p>
              )}
              {topConcepts.length > 0 && (
                <div className="ehc-tags">
                  {topConcepts.map((c, i) => (
                    <span key={i} className="ehc-tag">
                      <Lightbulb size={12} /> {c.display_name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Stats Grid */}
          <div className="ehc-stats-grid">
            {entity?.works_count != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.works_count.toLocaleString()}</span>
                <span className="ehc-stat-label">Publicaciones</span>
              </div>
            )}
            {entity?.cited_by_count != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.cited_by_count.toLocaleString()}</span>
                <span className="ehc-stat-label">Citas Totales</span>
              </div>
            )}
            {(entity?.summary_stats?.h_index != null || entity?.h_index != null) && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity?.summary_stats?.h_index ?? entity?.h_index}</span>
                <span className="ehc-stat-label">{type === 'source' ? 'Tipo' : 'H-Index'}</span>
              </div>
            )}
            {entity?.summary_stats?.['2yr_mean_citedness'] != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{Number(entity.summary_stats['2yr_mean_citedness']).toFixed(1)}</span>
                <span className="ehc-stat-label">Impacto Reciente</span>
              </div>
            )}
            {type === 'project' && entity.budget > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.budget); } catch { return `${entity.budget.toLocaleString('es-ES')} €`; } })()}
                </span>
                <span className="ehc-stat-label">Presupuesto Total</span>
              </div>
            )}
            {type === 'project' && entity.fundedAmount > 0 && entity.fundedAmount !== entity.budget && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.fundedAmount); } catch { return `${entity.fundedAmount.toLocaleString('es-ES')} €`; } })()}
                </span>
                <span className="ehc-stat-label">Financiación</span>
              </div>
            )}
            {type === 'project' && entity.startDate && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.startDate.split('-')[0]} - {entity.endDate?.split('-')[0] || '...'}</span>
                <span className="ehc-stat-label">Duración</span>
              </div>
            )}
            {type === 'project' && entity.participants?.length > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.participants.length}</span>
                <span className="ehc-stat-label">Participantes</span>
              </div>
            )}
            {type === 'project' && entity.measures?.citations > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.measures.citations.toLocaleString()}</span>
                <span className="ehc-stat-label">Citas</span>
              </div>
            )}
          </div>
          
          {/* Project metadata chips */}
          {type === 'project' && (entity.callIdentifier || entity.contractType || entity.openAccess) && (
            <div className="project-meta-chips">
              {entity.callIdentifier && (
                <span className="project-chip"><BookOpen size={13} /> {entity.callIdentifier}</span>
              )}
              {entity.contractType && (
                <span className="project-chip"><Award size={13} /> {entity.contractType}</span>
              )}
              {entity.openAccess && (
                <span className="project-chip project-chip--oa"><BookOpen size={13} /> Open Access</span>
              )}
              {entity.measures?.downloads > 0 && (
                <span className="project-chip"><Download size={13} /> {entity.measures.downloads.toLocaleString()} descargas</span>
              )}
              {entity.measures?.views > 0 && (
                <span className="project-chip"><Eye size={13} /> {entity.measures.views.toLocaleString()} vistas</span>
              )}
            </div>
          )}

          {/* Project Summary - expandable */}
          {type === 'project' && entity?.summary && (
            <div className="project-summary-box" onClick={() => setExpandedSummary(!expandedSummary)}>
              <p className={expandedSummary ? 'expanded' : 'collapsed'}>
                {entity.summary}
              </p>
              <button className="project-summary-toggle">
                {expandedSummary ? <><ChevronUp size={14} /> Mostrar menos</> : <><ChevronDown size={14} /> Leer más</>}
              </button>
            </div>
          )}

          {/* Project subjects */}
          {type === 'project' && entity.subjects?.length > 0 && (
            <div className="project-subjects">
              <h4 className="project-section-title"><Tag size={14} /> Temas del proyecto</h4>
              <div className="project-subjects-list">
                {entity.subjects.map((s, i) => (
                  <span key={i} className="ehc-tag">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Participating organizations */}
          {type === 'project' && entity.participants?.length > 0 && (
            <div className="project-participants">
              <h4 className="project-section-title"><Building2 size={14} /> Organizaciones participantes</h4>
              <div className="project-participants-grid">
                {entity.participants.slice(0, expandedSummary ? entity.participants.length : 6).map((p, i) => (
                  <div key={i} className="project-participant-card">
                    <span className="project-participant-name">{p.name}</span>
                    {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
                  </div>
                ))}
              </div>
              {entity.participants.length > 6 && !expandedSummary && (
                <button className="project-show-more" onClick={() => setExpandedSummary(true)}>
                  +{entity.participants.length - 6} organizaciones más
                </button>
              )}
            </div>
          )}
          
          {/* Wikipedia or external info */}
          <AnimatePresence>
            {(wikiInfo || entity?.homepage_url) && (
              <motion.div 
                className="ehc-wiki"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: "easeOut" }}
              >
                {wikiInfo && <p>{wikiInfo.extract}</p>}
                <div className="ehc-links">
                  {wikiInfo?.url && (
                    <a href={wikiInfo.url} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      Wikipedia <ExternalLink size={14} />
                    </a>
                  )}
                  {entity?.homepage_url && (
                    <a href={entity.homepage_url} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      Web Oficial <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ORCID Career Section */}
          {isLoadingOrcid && (
            <div className="orcid-skeleton">
              <div className="orcid-skeleton-header">
                <div className="skel skel-circle" />
                <div style={{ flex: 1 }}>
                  <div className="skel skel-line" style={{ width: '40%', marginBottom: '6px' }} />
                  <div className="skel skel-line" style={{ width: '25%' }} />
                </div>
              </div>
              <div className="skel skel-line" style={{ width: '60%', marginTop: '16px' }} />
              <div className="skel skel-line" style={{ width: '80%', marginTop: '8px' }} />
              <div className="skel skel-line" style={{ width: '70%', marginTop: '8px' }} />
            </div>
          )}
          {orcidInfo && !isLoadingOrcid && (
            <div className="orcid-career-section orcid-career-section--animate">

              {/* Header: Badge + link */}
              <div className="orcid-career-header">
                <div className="orcid-badge">
                  <div className="orcid-badge-icon">
                    <img src="https://info.orcid.org/wp-content/uploads/2019/11/orcid_16x16.png" alt="ORCID" />
                  </div>
                  <div className="orcid-badge-text">
                    <span className="orcid-badge-label">Perfil Verificado ORCID</span>
                    <span className="orcid-badge-id">{orcidInfo.orcid}</span>
                  </div>
                </div>
                <a href={`https://orcid.org/${orcidInfo.orcid}`} target="_blank" rel="noopener noreferrer" className="orcid-profile-link">
                  Ver perfil <ExternalLink size={12} />
                </a>
              </div>

              {/* Biography */}
              {orcidInfo.biography && (
                <div className="orcid-biography">
                  {orcidInfo.biography}
                </div>
              )}

              {/* External links */}
              {orcidInfo.researcherUrls?.length > 0 && (
                <div className="orcid-links-row">
                  {orcidInfo.researcherUrls.map((u, i) => (
                    <a key={i} href={u.url} target="_blank" rel="noopener noreferrer" className="orcid-ext-link">
                      <Globe size={12} />
                      {u.name || 'Enlace externo'}
                    </a>
                  ))}
                </div>
              )}

              {/* Work experience timeline */}
              {orcidInfo.employments?.length > 0 && (
                <div className="orcid-timeline-block">
                  <div className="orcid-timeline-title">
                    <span className="orcid-tl-icon orcid-tl-icon--work"><Briefcase size={12} /></span>
                    Experiencia profesional
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo.employments.map((emp, i) => (
                      <div key={i} className="orcid-timeline-item">
                        <div
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: emp.ror, name: emp.organization });
                            if (inst) navigate(`/explorer/institution/${inst.id}`);
                          }}
                          title={`Buscar y ver perfil de ${emp.organization}`}
                        >
                          {emp.organization}
                        </div>
                        {emp.role && <div className="orcid-item-role">{emp.role}</div>}
                        {emp.startDate && (
                          <div className="orcid-item-dates">
                            {emp.startDate}
                            <span className="dot-separator">→</span>
                            {emp.endDate || 'Presente'}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Education timeline */}
              {orcidInfo.educations?.length > 0 && (
                <div className="orcid-timeline-block">
                  <div className="orcid-timeline-title">
                    <span className="orcid-tl-icon orcid-tl-icon--edu"><BookOpen size={12} /></span>
                    Formación académica
                  </div>
                  <div className="orcid-timeline">
                    {orcidInfo.educations.map((edu, i) => (
                      <div key={i} className="orcid-timeline-item orcid-timeline-item--edu">
                        <div
                          className="orcid-item-org orcid-item-org--link"
                          onClick={async () => {
                            const inst = await findInstitution({ rorUrl: edu.ror, name: edu.organization });
                            if (inst) navigate(`/explorer/institution/${inst.id}`);
                          }}
                          title={`Buscar y ver perfil de ${edu.organization}`}
                        >
                          {edu.organization}
                        </div>
                        {edu.role && <div className="orcid-item-role">{edu.role}</div>}
                        {edu.startDate && (
                          <div className="orcid-item-dates">
                            {edu.startDate}
                            {edu.endDate && <><span className="dot-separator">→</span>{edu.endDate}</>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
        
        <div className="ee-tabs">
          <button className={`ee-tab ${activeTab === 'papers' ? 'active' : ''}`} onClick={() => setActiveTab('papers')}>
             Papers
          </button>
          {(type !== 'author' && type !== 'project') && (
             <button className={`ee-tab ${activeTab === 'authors' ? 'active' : ''}`} onClick={() => setActiveTab('authors')}>
               Autores
             </button>
          )}
        </div>
      </div>

      {/* Sticky Toolbar Wrapper */}
      <div className="explorer-toolbar-wrapper">
        <div className="explorer-toolbar">
          <div className="explorer-search-box">
            <Search size={16} className="es-icon" />
            <input 
              type="text" 
              placeholder={`Buscar ${activeTab === 'papers' ? 'papers' : 'autores'} de esta ${type === 'institution' ? 'universidad' : type === 'concept' ? 'área' : 'persona'}...`}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button className="es-clear" onClick={() => setSearchQuery('')}>
                <X size={14} />
              </button>
            )}
          </div>
          {activeTab === 'papers' && (
             <button 
                className={`filter-btn ${filters?.category || filters?.peerReviewed || filters?.dateRange ? 'active' : ''}`} 
                onClick={() => setShowFilters(true)}
              >
                <Filter size={16} />
              </button>
            )}
          </div>
        </div>

      <div className="explorer-content">
        {activeTab === 'papers' ? (
          <>

            
            <div className="explorer-grid">
              {(!isLoadingPapers || isFetchingMore) && filteredPapers.map((paper, idx) => (
                <div 
                  key={`${paper.id}-${idx}`} 
                  className="explorer-list-item"
                  onClick={() => setSelectedPaper(paper)}
                  style={{ '--i': idx }}
                >
                  <div className="eli-header">
                    <span className="eli-cat">{paper.categories && paper.categories.length > 0 ? paper.categories[0] : 'Paper'}</span>
                    <span className="eli-date">{paper.year}</span>
                  </div>
                  <h3 className="eli-title">
                    {paper.title}
                    {paper.isPeerReviewed && (
                      <span className="pc-tooltip" data-tooltip="Publicado en revista (Peer-reviewed)" style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: '6px' }}>
                        <BadgeCheck size={16} style={{ color: '#1da1f2' }} />
                      </span>
                    )}
                  </h3>
                  <p className="eli-authors">{(paper.authors || []).map(a => a.name || a).join(', ')}</p>
                  <p className="eli-summary">
                    {paper.abstract?.length > 200 ? paper.abstract.substring(0, 200) + '...' : paper.abstract}
                  </p>
                </div>
              ))}
              
              <AnimatePresence>
                {isLoadingPapers && !isFetchingMore && [1, 2, 3, 4, 5].map((n) => (
                  <motion.div 
                    key={`skeleton-${n}`} 
                    className="explorer-list-item skeleton-item"
                    exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.3 } }}
                  >
                    <div className="eli-header">
                      <div className="skeleton-pill"></div>
                      <div className="skeleton-text short"></div>
                    </div>
                    <div className="skeleton-title"></div>
                    <div className="skeleton-title short"></div>
                    <div className="skeleton-text"></div>
                    <div className="skeleton-text long"></div>
                    <div className="skeleton-text medium"></div>
                  </motion.div>
                ))}
              </AnimatePresence>

              {/* Infinite Scroll Sentinel */}
              {hasMore && (
                <div ref={observerRef} className="ehc-sentinel">
                  <Loader2 className="ehc-spinner" size={24} />
                  <span>Cargando más artículos...</span>
                </div>
              )}
            </div>
            
            {!isLoadingPapers && filteredPapers.length === 0 && (
              <div className="explorer-empty">
                <p>No se encontraron resultados que coincidan con tu búsqueda y filtros.</p>
              </div>
            )}
          </>
        ) : (
          <div className="ee-authors-grid">
            {(!isLoadingAuthors || isFetchingMoreAuthors) && entityAuthors.map((author, idx) => (
              <div 
                key={author.id} 
                className="ee-author-card staggerFadeUp" 
                style={{ '--i': idx }}
                onClick={() => navigate(`/explorer/author/${encodeURIComponent(author.id)}`)}
              >
                <div className="ee-author-icon"><Users size={24} /></div>
                <div className="ee-author-info">
                  <h4>{author.display_name}</h4>
                  <p className="ee-author-metrics">
                    H-Index: {author.h_index} • {author.cited_by_count.toLocaleString()} citas
                  </p>
                </div>
                <ChevronRight size={18} className="ee-author-arrow" />
              </div>
            ))}
            
            <AnimatePresence>
              {isLoadingAuthors && !isFetchingMoreAuthors && [1, 2, 3, 4, 5, 6].map(n => (
                <motion.div 
                  key={`skel-author-${n}`} 
                  className="ee-author-card skeleton-item"
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.3 } }}
                >
                  <div className="ee-author-icon skel skel-circle" style={{ width: '40px', height: '40px' }}></div>
                  <div className="ee-author-info">
                    <div className="skel skel-line" style={{ width: '70%', height: '18px', marginBottom: '8px' }}></div>
                    <div className="skel skel-line" style={{ width: '50%', height: '12px' }}></div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            
            {hasMoreAuthors && (
              <div ref={observerAuthorsRef} className="ehc-sentinel">
                <Loader2 className="ehc-spinner" size={24} />
                <span>Cargando más autores...</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filter Drawer */}
      <AnimatePresence>
        {showFilters && (
          <>
            <motion.div 
              className="ee-filter-backdrop" 
              onClick={() => setShowFilters(false)} 
              initial={{opacity:0}} 
              animate={{opacity:1}} 
              exit={{opacity:0}} 
            />
            <motion.div 
              className="ee-filter-drawer" 
              initial={{x:'100%'}} 
              animate={{x:0}} 
              exit={{x:'100%'}} 
              transition={{type:'spring', damping:25, stiffness:200}}
            >
              <div className="ee-filter-header">
                <h3><SlidersHorizontal size={18}/> Filtros Avanzados</h3>
                <button className="close-btn" onClick={() => setShowFilters(false)}><X size={20}/></button>
              </div>
              <div className="ee-filter-body">
                <div className="ee-filter-section">
                  <h4>Ordenar por</h4>
                  <div className="ee-filter-chips">
                    <button 
                      className={`ee-filter-chip ${sortBy === 'cited_by_count:desc' ? 'active' : ''}`}
                      onClick={() => setSortBy('cited_by_count:desc')}
                    >
                      Más Citados
                    </button>
                    <button 
                      className={`ee-filter-chip ${sortBy === 'publication_date:desc' ? 'active' : ''}`}
                      onClick={() => setSortBy('publication_date:desc')}
                    >
                      Más Recientes
                    </button>
                  </div>
                </div>
                <div className="ee-filter-section">
                  <h4>Categoría (Área)</h4>
                  <div className="ee-filter-chips">
                    <button 
                      className={`ee-filter-chip ${filters.category === '' ? 'active' : ''}`}
                      onClick={() => setFilters({...filters, category: ''})}
                    >
                      Todas
                    </button>
                    {Object.entries(CATEGORIES).map(([key, cat]) => (
                      <button 
                        key={key} 
                        className={`ee-filter-chip ${filters.category === key ? 'active' : ''}`}
                        onClick={() => setFilters({...filters, category: key})}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ee-filter-section">
                  <h4>Fecha de Publicación</h4>
                  <div className="ee-filter-chips">
                    {['', 'last_year', 'last_5_years'].map(val => (
                      <button 
                        key={val}
                        className={`ee-filter-chip ${filters.dateRange === val ? 'active' : ''}`}
                        onClick={() => setFilters({...filters, dateRange: val})}
                      >
                        {val === '' ? 'Cualquier fecha' : val === 'last_year' ? 'Último año' : 'Últimos 5 años'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ee-filter-section">
                  <label className="ee-toggle-label">
                    <input 
                      type="checkbox" 
                      checked={filters.peerReviewed} 
                      onChange={e => setFilters({...filters, peerReviewed: e.target.checked})} 
                    />
                    <div className="ee-toggle-switch"></div>
                    Solo revisados por pares
                  </label>
                </div>
              </div>
              <div className="ee-filter-footer">
                <button className="ee-filter-reset" onClick={() => { setFilters({category:'', peerReviewed:false, dateRange:''}); setShowFilters(false); }}>Restablecer</button>
                <button className="ee-filter-apply" onClick={() => setShowFilters(false)}>Aplicar Filtros</button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Paper Card Overlay */}
      <AnimatePresence>
        {selectedPaper && !pdfPaperToView && (
          <motion.div 
            className="explorer-overlay"
            initial={{ opacity: 0, y: '100vh' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100vh' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
          >
            <button 
              className="explorer-overlay-close" 
              onClick={() => setSelectedPaper(null)}
            >
              <ArrowLeft size={22} />
            </button>
            <div className="explorer-overlay-content hide-scroll-hint">
              <PaperCard 
                paper={selectedPaper} 
                onOpenPdf={(paper) => setPdfPaperToView(paper)}
                trackViewTime={() => {}}
                trackSkip={() => {}}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    {/* PDF Viewer Overlay */}
      <AnimatePresence>
        {pdfPaperToView && (
          <motion.div 
            className="explorer-overlay" 
            style={{ zIndex: 1001 }}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
          >
            <PDFViewer paper={pdfPaperToView} onClose={() => setPdfPaperToView(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
