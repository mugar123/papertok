import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, X, Share2, ExternalLink, Filter, SlidersHorizontal, ChevronRight, ChevronDown, BadgeCheck, Check, FileText, Briefcase, Globe, MapPin, BookOpen, Download, Eye, Award, Tag } from 'lucide-react';
import { getEntityById, getWorksByEntity, getAuthorsByEntity, enrichPapersBatch, fetchPapersByDois, getAuthorProfileExact, getAuthorProfileByOrcid, findInstitution, getInstitutionRecentImpact } from '../../services/openAlexService';
import { isOpenAlexRateLimitError } from '../../services/openAlexClient';
import { fetchPapers, fetchPapersByIds, getAuthorPapers } from '../../services/arxivService';
import { ElsevierAdapter, OpenAlexAdapter, PubmedAdapter } from '../../services/adapters';
import { getPapersByProject, getProjectDetails } from '../../services/openAireService';
import { PaperBuilder } from '../../services/PaperBuilder';
import { extractOrcid, getOrcidRecord } from '../../services/orcidService';
import { filterAndSortEntityPapers, pinSourcePaper } from '../../utils/entityExplorer';
import { AnimatePresence, motion } from 'framer-motion';
import { CATEGORIES } from '../../data/categories';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';
import { normalizeScientificMarkup } from '../../utils/latex';
import 'katex/dist/katex.min.css';
import './EntityExplorer.css';


const handleActivationKey = (event, action) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
};

export default function EntityExplorer({ onSaveToList = () => {} }) {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();

  const [entity, setEntity] = useState(null);
  const [entityError, setEntityError] = useState(null);
  const [entityReloadKey, setEntityReloadKey] = useState(0);
  const [papers, setPapers] = useState([]);
  const [isLoadingEntity, setIsLoadingEntity] = useState(true);
  const [isLoadingPapers, setIsLoadingPapers] = useState(false);
  const [papersError, setPapersError] = useState(null);
  const [papersReloadKey, setPapersReloadKey] = useState(0);
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
  const [isWikiDescriptionExpanded, setIsWikiDescriptionExpanded] = useState(false);
  const [isProjectLinksMenuOpen, setIsProjectLinksMenuOpen] = useState(false);
  const [projectSummaryExpandedHeight, setProjectSummaryExpandedHeight] = useState(0);
  const [wikiDescriptionExpandedHeight, setWikiDescriptionExpandedHeight] = useState(0);
  const [isProjectSummaryExpandable, setIsProjectSummaryExpandable] = useState(false);
  const [isWikiDescriptionExpandable, setIsWikiDescriptionExpandable] = useState(false);
  const [resolvingParticipant, setResolvingParticipant] = useState(null);
  const [participantNavigationError, setParticipantNavigationError] = useState('');
  const [recentImpact, setRecentImpact] = useState(null);
  const [isLoadingRecentImpact, setIsLoadingRecentImpact] = useState(false);
  const [recentImpactError, setRecentImpactError] = useState(null);
  
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    category: '',
    peerReviewed: false,
    dateRange: ''
  });

  const [entityAuthors, setEntityAuthors] = useState([]);
  const [isLoadingAuthors, setIsLoadingAuthors] = useState(false);
  const [authorsError, setAuthorsError] = useState(null);
  const [authorsReloadKey, setAuthorsReloadKey] = useState(0);
  const [isFetchingMoreAuthors, setIsFetchingMoreAuthors] = useState(false);
  const [authorsPage, setAuthorsPage] = useState(1);
  const [hasMoreAuthors, setHasMoreAuthors] = useState(false);
  const observerAuthorsRef = useRef(null);
  const projectLinksMenuRef = useRef(null);
  const projectSummaryTextRef = useRef(null);
  const wikiDescriptionTextRef = useRef(null);
  const getInteractionState = useCallback((paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);

  const measureExpandableDescriptions = useCallback(() => {
    const measure = (element, setHeight, setExpandable) => {
      if (!element) return;
      const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      const collapsedHeight = Number.isFinite(lineHeight) ? lineHeight * 3 : element.clientHeight;
      setHeight(element.scrollHeight);
      setExpandable(element.scrollHeight > collapsedHeight + 1);
    };

    measure(projectSummaryTextRef.current, setProjectSummaryExpandedHeight, setIsProjectSummaryExpandable);
    measure(wikiDescriptionTextRef.current, setWikiDescriptionExpandedHeight, setIsWikiDescriptionExpandable);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(measureExpandableDescriptions);
    window.addEventListener('resize', measureExpandableDescriptions);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', measureExpandableDescriptions);
    };
  }, [entity?.summary, measureExpandableDescriptions, wikiInfo?.extract]);

  useEffect(() => {
    if (!isProjectLinksMenuOpen) return undefined;

    const closeMenu = (event) => {
      if (!projectLinksMenuRef.current?.contains(event.target)) setIsProjectLinksMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setIsProjectLinksMenuOpen(false);
    };

    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isProjectLinksMenuOpen]);

  const followEntity = useMemo(() => {
    if (!entity || !['author', 'institution', 'project', 'concept', 'topic'].includes(type)) return null;
    const followType = type === 'concept' ? 'topic' : type;
    return {
      type: followType,
      id: entity.id || entity.code || id,
      displayName: entity.display_name,
      source: type === 'project' ? 'openaire' : type === 'concept' || type === 'topic' ? 'papertok' : 'openalex',
      externalIds: {
        orcid: entity.orcid,
        ror: entity.ror,
      },
      metadata: {
        funder: entity.funder,
        categoryIds: entity.categoryIds,
      },
    };
  }, [entity, id, type]);

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
    let isCancelled = false;

    async function loadEntity() {
      setIsLoadingEntity(true);
      setEntityError(null);
      setEntity(null);
      setPapers([]);
      setEntityAuthors([]);
      setSearchQuery('');
      setWikiInfo(null);
      setOrcidInfo(null);
      setIsLoadingOrcid(false);
      setExpandedSummary(false);
      setIsWikiDescriptionExpanded(false);
      setIsProjectLinksMenuOpen(false);
      setIsProjectSummaryExpandable(false);
      setIsWikiDescriptionExpandable(false);
      setResolvingParticipant(null);
      setParticipantNavigationError('');
      setRecentImpact(null);
      setIsLoadingRecentImpact(false);
      setRecentImpactError(null);
      setShowFilters(false);
      setPapersError(null);
      setAuthorsError(null);

      if (type === 'project') {
        const name = searchParams.get('name') || id;
        const funder = searchParams.get('funder') || '';
        
        // Optimistic display
        setEntity({ display_name: name, type: 'project', funder });
        
        // Fetch detailed info
        const details = await getProjectDetails(id);
        if (isCancelled) return;
        if (details) {
           const displayName = details.acronym 
             ? `${details.acronym}: ${details.title}` 
             : details.title;
           setEntity({
             id: details.id || id,
             code: details.id || id,
             openaireId: details.openaireId,
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
             websiteUrl: details.websiteUrl,
           });
        }
        if (!isCancelled) setIsLoadingEntity(false);
        return;
      }
      
      let data;
      let prefetchedOrcid = null;
      const orcidId = type === 'author' ? extractOrcid(id) : null;
      const isOpenAlexId = /^A\d+$/.test(id) || /openalex\.org\/A\d+/.test(id);
      
      if (orcidId) {
        data = await getAuthorProfileByOrcid(orcidId);
        if (!data) {
          prefetchedOrcid = await getOrcidRecord(orcidId);
          if (prefetchedOrcid?.displayName) {
            data = {
              id: `stub-${orcidId}`,
              display_name: prefetchedOrcid.displayName,
              orcid: `https://orcid.org/${orcidId}`,
              works_count: null,
              cited_by_count: null,
              summary_stats: null,
            };
          }
        }
      } else if (type === 'author' && !isOpenAlexId) {
        const arxivId = searchParams.get('arxivId');
        data = await getAuthorProfileExact(id, arxivId);
      } else {
        data = await getEntityById(type, id);
      }

      if (isCancelled) return;
      
      setEntity(data);
      setIsLoadingEntity(false);

      if (type === 'institution' && data?.id) {
        setIsLoadingRecentImpact(true);
        setRecentImpactError(null);
        try {
          const impact = await getInstitutionRecentImpact(data.id);
          if (!isCancelled) setRecentImpact(impact);
        } catch (error) {
          if (!isCancelled) {
            setRecentImpactError(
              isOpenAlexRateLimitError(error)
                ? 'rate_limited'
                : error?.code === 'timeout'
                  ? 'timeout'
                  : error?.code === 'network_error'
                    ? 'network_error'
                    : 'unavailable'
            );
            console.error('Failed to load recent institution impact', error);
          }
        } finally {
          if (!isCancelled) setIsLoadingRecentImpact(false);
        }
      }

      if (data && data.display_name) {
        if (type === 'author' && data.orcid) {
          setIsLoadingOrcid(true);
          try {
            const record = prefetchedOrcid || await getOrcidRecord(data.orcid);
            if (!isCancelled) setOrcidInfo(record);
          } catch (e) {
            if (!isCancelled) console.error("Error loading ORCID", e);
          } finally {
            if (!isCancelled) setIsLoadingOrcid(false);
          }
        }

        if (type === 'institution' || type === 'concept' || type === 'source') {
          try {
            const res = await fetch(`https://es.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(data.display_name)}`);
            if (isCancelled) return;
            if (res.ok) {
              const wikiData = await res.json();
              if (!isCancelled && wikiData.extract) {
                setWikiInfo({
                  extract: wikiData.extract,
                  thumbnail: wikiData.thumbnail?.source || null,
                  url: wikiData.content_urls?.desktop?.page || ''
                });
              }
            } else {
              const resEn = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(data.display_name)}`);
              if (isCancelled) return;
              if (resEn.ok) {
                const wikiDataEn = await resEn.json();
                if (!isCancelled && wikiDataEn.extract) {
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
    loadEntity().catch(error => {
      if (isCancelled) return;
      console.error('Failed to load entity', error);
      setEntity(null);
      setEntityError('No se pudo cargar esta entidad. Comprueba tu conexión e inténtalo de nuevo.');
      setIsLoadingEntity(false);
    });
    return () => {
      isCancelled = true;
    };
  }, [type, id, searchParams, entityReloadKey]);

  useEffect(() => {
    let isCancelled = false;
    async function loadPapers() {
      if (!entity || activeTab !== 'papers') return;
      if (page === 1) {
        setIsLoadingPapers(true);
        setPapersError(null);
      }
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
        } else if (type === 'author') {
            let papersFromOA = [];
            let arxPapersFromNative = [];
            let primaryError = null;
            
            try {
              if (!resolvedId.startsWith('stub-')) {
                const res = await getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters);
                papersFromOA = res.papers || [];
                total = res.total;
              } else {
                arxPapersFromNative = await getAuthorPapers(entity.display_name, 30);
              }
            } catch (error) {
              primaryError = error;
            }
            
            const elsevierAdapter = new ElsevierAdapter();
            const elsevierProm = elsevierAdapter.search(`"${entity.display_name}"`, page, { type: 'author' });
            
            const pubmedAdapter = new PubmedAdapter();
            const pubmedProm = pubmedAdapter.search(`"${entity.display_name}"`, page, { type: 'author' });
            
            const supplementalResults = await Promise.allSettled([elsevierProm, pubmedProm]);
            const [els, pub] = supplementalResults.map(result => result.status === 'fulfilled' ? result.value?.papers || [] : []);
            
            fetchedPapers.push(...papersFromOA, ...arxPapersFromNative, ...els, ...pub);

            const supplementalError = supplementalResults.find(result => result.status === 'rejected')?.reason;
            if (fetchedPapers.length === 0 && (primaryError || supplementalError)) {
              throw primaryError || supplementalError;
            }
            
            if (resolvedId.startsWith('stub-')) {
              total = fetchedPapers.length;
            }
         } else if ((type === 'concept' || type === 'topic') && entity._localTopic) {
            const topicCategories = entity.categoryIds || [resolvedId];
            const topicQuery = debouncedSearch || entity.labelEn || entity.display_name;
            const openAlexAdapter = new OpenAlexAdapter();
            const pubmedAdapter = new PubmedAdapter();
            const topicResults = await Promise.allSettled([
              fetchPapers(topicCategories.slice(0, 6), (page - 1) * 30, 30, sortBy.includes('publication_date') ? 'recent' : 'relevance'),
              openAlexAdapter.search(`"${topicQuery}"`, page, { internalCategories: topicCategories }),
              pubmedAdapter.search(`"${topicQuery}"`, page, { internalCategories: topicCategories.slice(0, 3) }),
            ]);
            fetchedPapers.push(...topicResults.flatMap(result => result.status === 'fulfilled'
              ? result.value?.papers || result.value || []
              : []));
            total = fetchedPapers.length < 30 ? (page - 1) * 30 + fetchedPapers.length : page * 30 + 1;
         } else {
            const res = await getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters);
            fetchedPapers.push(...(res.papers || []));
            total = res.total;
         }
        
        // 1. Fetch arXiv papers
        if (arxivIds.length > 0) {
          const rawPapers = await fetchPapersByIds(arxivIds);
          const enrichmentMap = await enrichPapersBatch(arxivIds);
          const enrichedArxiv = rawPapers.map(paper => {
            const enriched = enrichmentMap[paper.id];
            if (!enriched) return paper;
            const merged = PaperBuilder.merge(paper, enriched, 'openalex');
            merged._isOpenAlexEnriched = true;
            return merged;
          });
          fetchedPapers.push(...enrichedArxiv);
        }
        
        // 2. Fetch non-arXiv DOIs directly from OpenAlex
        if (dois.length > 0) {
          const doiPapers = await fetchPapersByDois(dois);
          fetchedPapers.push(...doiPapers);
        }
        
        fetchedPapers = PaperBuilder.deduplicate(fetchedPapers);
        // 3. Guarantee source paper is ALWAYS first in the list
        if (page === 1) {
           const sourceArxivId = searchParams.get('arxivId');
           if (sourceArxivId) {
             const cleanSourceId = sourceArxivId.replace(/v\d+$/, '');
             const sourceIndex = fetchedPapers.findIndex(p => {
               if (!p.id) return false;
               const pClean = p.id.startsWith('arxiv:') ? p.id.split(':')[1] : p.id;
               return pClean.replace(/v\d+$/, '') === cleanSourceId;
             });
             
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

        if (type === 'project') {
          fetchedPapers = filterAndSortEntityPapers(fetchedPapers, {
            searchQuery: debouncedSearch,
            filters,
            sortBy,
          });
          fetchedPapers = pinSourcePaper(fetchedPapers, searchParams.get('arxivId'));
        }

        if (isCancelled) return;

        if (page === 1) {
          setPapers(fetchedPapers);
        } else {
          setPapers(prev => {
             const combined = PaperBuilder.deduplicate([...prev, ...fetchedPapers]);
             if (type !== 'project') return combined;
             const filtered = filterAndSortEntityPapers(combined, { searchQuery: debouncedSearch, filters, sortBy });
             return pinSourcePaper(filtered, searchParams.get('arxivId'));
          });
        }
        setHasMore(page * 30 < total);
      } catch (err) {
        console.error("Failed to load papers for entity", err);
        if (isCancelled) return;
        if (page === 1) setPapers([]);
        setPapersError('No se pudieron cargar las publicaciones. Comprueba tu conexión e inténtalo de nuevo.');
        setHasMore(false); // Stop infinite looping on errors
      }
      if (isCancelled) return;
      setIsLoadingPapers(false);
      setIsFetchingMore(false);
    }
    loadPapers();
    return () => { isCancelled = true; };
  }, [type, id, entity, sortBy, page, debouncedSearch, filters, activeTab, searchParams, papersReloadKey]);

  useEffect(() => {
    let isCancelled = false;
    async function loadAuthors() {
      if (!entity || type === 'author' || entity._localTopic || activeTab !== 'authors') return;
      if (authorsPage === 1) {
        setIsLoadingAuthors(true);
        setAuthorsError(null);
      }
      else setIsFetchingMoreAuthors(true);
      
      try {
        const resolvedId = entity.id || id;
        const { authors, total } = await getAuthorsByEntity(type, resolvedId, authorsPage, debouncedSearch);
        
        if (isCancelled) return;
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
        if (isCancelled) return;
        if (authorsPage === 1) setEntityAuthors([]);
        setAuthorsError('No se pudieron cargar los autores. Comprueba tu conexión e inténtalo de nuevo.');
        setHasMoreAuthors(false); // Stop infinite looping on errors
      }
      if (isCancelled) return;
      setIsLoadingAuthors(false);
      setIsFetchingMoreAuthors(false);
    }
    loadAuthors();
    return () => { isCancelled = true; };
  }, [type, id, entity, authorsPage, debouncedSearch, activeTab, authorsReloadKey]);

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

  const retryPapers = () => {
    setPapersError(null);
    setPage(1);
    setPapersReloadKey(key => key + 1);
  };

  const retryEntity = () => {
    setEntityError(null);
    setEntityReloadKey(key => key + 1);
  };

  const retryAuthors = () => {
    setAuthorsError(null);
    setAuthorsPage(1);
    setAuthorsReloadKey(key => key + 1);
  };

  const openParticipantInstitution = async (participant) => {
    setResolvingParticipant(participant.name);
    setParticipantNavigationError('');
    try {
      const institution = await findInstitution({
        name: participant.searchName || participant.name,
        aliases: [participant.name],
      });
      if (institution) {
        navigate(`/explorer/institution/${institution.id}`);
      } else {
        setParticipantNavigationError(`No encontramos el perfil institucional de ${participant.name}.`);
      }
    } catch (error) {
      console.error('Failed to resolve project participant', error);
      setParticipantNavigationError(`No pudimos abrir ${participant.name}. Inténtalo de nuevo.`);
    } finally {
      setResolvingParticipant(null);
    }
  };

  if (isLoadingEntity) return (
      <div className="explorer-container">
        <div className="explorer-hero">
          <div className="explorer-hero-top">
            <div className="eht-left">
              <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label="Volver" title="Volver">
                <ArrowLeft size={20} />
              </button>
              <div className="skeleton-item" style={{ width: '80px', height: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px' }}></div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="explorer-action-btn skeleton-item" style={{ border: 'none', background: 'rgba(255,255,255,0.05)' }} aria-hidden="true" tabIndex={-1} disabled></button>
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
        <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label="Volver" title="Volver">
          <ArrowLeft size={24} />
        </button>
        <h2>{entityError ? 'No se pudo cargar la entidad' : 'Entidad no encontrada'}</h2>
        {entityError && (
          <>
            <p role="alert">{entityError}</p>
            <button className="explorer-clear-btn" onClick={retryEntity}>Reintentar</button>
          </>
        )}
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
            <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label="Volver" title="Volver">
              <ArrowLeft size={20} />
            </button>
            <span className="ehc-type">{entityTypeLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="explorer-action-btn" onClick={handleShare} aria-label="Compartir" title="Compartir">
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
                {followEntity && (
                  <button
                    className={`entity-follow-btn ${isFollowing(followEntity) ? 'following' : ''} ${isFollowPending(followEntity) ? 'is-pending' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleFollow(followEntity).catch(console.error); }}
                    disabled={isFollowPending(followEntity)}
                    aria-pressed={isFollowing(followEntity)}
                  >
                    {isFollowPending(followEntity)
                      ? <><Loader2 className="spinning" size={14} /> <span>Guardando...</span></>
                      : isFollowing(followEntity)
                        ? <><Check size={14} /> <span>Siguiendo</span></>
                        : <span>Seguir</span>}
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
                      onKeyDown={(event) => handleActivationKey(event, () => navigate(`/explorer/institution/${entity.last_known_institutions[0].id.split('/').pop()}`))}
                      role="link"
                      tabIndex={0}
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
              {type === 'project' && (entity.openaireId || entity.websiteUrl) && (
                <div className="project-links-menu" ref={projectLinksMenuRef}>
                  <button
                    type="button"
                    className={`project-links-trigger ${isProjectLinksMenuOpen ? 'is-open' : ''}`}
                    onClick={() => setIsProjectLinksMenuOpen(!isProjectLinksMenuOpen)}
                    aria-expanded={isProjectLinksMenuOpen}
                    aria-haspopup="menu"
                  >
                    <Globe size={15} />
                    <span>Ver proyecto</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                  <AnimatePresence>
                    {isProjectLinksMenuOpen && (
                      <motion.div
                        className="project-links-dropdown"
                        initial={{ opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.98 }}
                        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                        role="menu"
                      >
                        {entity.openaireId && (
                          <a
                            className="project-links-option"
                            href={`https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(entity.openaireId)}`}
                            target="_blank"
                            rel="noreferrer"
                            onClick={() => setIsProjectLinksMenuOpen(false)}
                            role="menuitem"
                          >
                            <span className="project-links-option-icon"><Building2 size={16} /></span>
                            <span><strong>Ficha en OpenAIRE</strong><small>Datos, publicaciones y participantes</small></span>
                            <ExternalLink size={14} />
                          </a>
                        )}
                        {entity.websiteUrl && (
                          <a
                            className="project-links-option"
                            href={entity.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setIsProjectLinksMenuOpen(false)}
                            role="menuitem"
                          >
                            <span className="project-links-option-icon"><Globe size={16} /></span>
                            <span><strong>Sitio oficial</strong><small>Web del propio proyecto</small></span>
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
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
            {type === 'institution' && (
              <div
                className={`ehc-stat-box ehc-stat-box--impact${recentImpact?.stale ? ' ehc-stat-box--stale' : ''}`}
                title={recentImpact?.available
                  ? `${recentImpact.stale ? 'Último cálculo guardado. ' : ''}Estimación PaperTok basada en ${recentImpact.sampleSize} publicaciones con FWCI. FWCI mediano: ${recentImpact.medianFwci}; ${Math.round(recentImpact.highImpactShare * 100)}% supera 2 veces el impacto esperado.`
                  : recentImpactError === 'rate_limited'
                    ? 'OpenAlex ha limitado temporalmente las consultas. La nota se recuperará cuando vuelva a estar disponible.'
                    : recentImpactError
                      ? 'No se pudo consultar el impacto reciente en OpenAlex.'
                      : 'La nota requiere al menos 50 publicaciones recientes con datos FWCI.'}
                aria-label={recentImpact?.available
                  ? `Impacto reciente ${recentImpact.score} sobre 10, ${recentImpact.level}`
                  : 'Impacto reciente no disponible'}
              >
                <span className="ehc-stat-value">
                  {isLoadingRecentImpact ? '…' : recentImpact?.available ? recentImpact.score.toFixed(1) : '—'}
                  <span className="ehc-stat-scale">/ 10</span>
                </span>
                <span className="ehc-stat-label">Impacto reciente</span>
                <span className="ehc-stat-detail">
                  {isLoadingRecentImpact
                    ? 'Calculando…'
                    : recentImpact?.available
                      ? recentImpact.stale
                        ? `Guardado · ${recentImpact.period.label}`
                        : `${recentImpact.level} · ${recentImpact.period.label}`
                      : recentImpactError === 'rate_limited'
                        ? 'Límite temporal'
                        : recentImpactError === 'timeout'
                          ? 'Sin respuesta'
                          : recentImpactError === 'network_error'
                            ? 'Sin conexión'
                            : recentImpactError
                              ? 'No disponible'
                              : 'Datos insuficientes'}
                </span>
              </div>
            )}
            {type !== 'institution' && entity?.summary_stats?.['2yr_mean_citedness'] != null && (
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
          {type === 'project' && (entity.callIdentifier || entity.contractType || entity.openAccess || entity.measures?.downloads > 0 || entity.measures?.views > 0) && (
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
            <motion.div
              layout
              className={`project-summary-box ${expandedSummary ? 'is-expanded' : ''} ${isProjectSummaryExpandable ? 'is-expandable' : ''}`}
              onClick={isProjectSummaryExpandable ? () => setExpandedSummary(!expandedSummary) : undefined}
              onKeyDown={isProjectSummaryExpandable ? (event) => handleActivationKey(event, () => setExpandedSummary(!expandedSummary)) : undefined}
              role={isProjectSummaryExpandable ? 'button' : undefined}
              tabIndex={isProjectSummaryExpandable ? 0 : undefined}
              aria-expanded={isProjectSummaryExpandable ? expandedSummary : undefined}
              aria-label={isProjectSummaryExpandable ? (expandedSummary ? 'Contraer resumen del proyecto' : 'Ampliar resumen del proyecto') : undefined}
              transition={{ layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] } }}
            >
              <p
                ref={projectSummaryTextRef}
                className={expandedSummary ? 'expanded' : 'collapsed'}
                style={projectSummaryExpandedHeight ? { '--project-summary-expanded-height': `${projectSummaryExpandedHeight}px` } : undefined}
              >
                {entity.summary}
              </p>
              {isProjectSummaryExpandable && (
                <span className="project-summary-toggle">
                  <ChevronDown size={14} /> {expandedSummary ? 'Mostrar menos' : 'Leer más'}
                </span>
              )}
            </motion.div>
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
                  <button
                    key={`${p.name}-${p.country || i}`}
                    type="button"
                    className="project-participant-card"
                    onClick={() => openParticipantInstitution(p)}
                    disabled={resolvingParticipant === p.name}
                    aria-label={`Abrir perfil institucional de ${p.name}`}
                  >
                    <span className="project-participant-info">
                      <span className="project-participant-name">{p.name}</span>
                      {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
                    </span>
                    {resolvingParticipant === p.name
                      ? <Loader2 size={15} className="ehc-spinner" aria-hidden="true" />
                      : <ChevronRight size={15} className="project-participant-arrow" aria-hidden="true" />}
                  </button>
                ))}
              </div>
              {participantNavigationError && (
                <p className="project-participant-error" role="alert">{participantNavigationError}</p>
              )}
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
                layout
                className={`ehc-wiki ${isWikiDescriptionExpanded ? 'is-expanded' : ''}`}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, ease: "easeOut", layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] } }}
              >
                {wikiInfo && (
                  <p
                    ref={wikiDescriptionTextRef}
                    className={isWikiDescriptionExpanded ? 'expanded' : 'collapsed'}
                    style={wikiDescriptionExpandedHeight ? { '--wiki-description-expanded-height': `${wikiDescriptionExpandedHeight}px` } : undefined}
                  >
                    {wikiInfo.extract}
                  </p>
                )}
                {isWikiDescriptionExpandable && (
                  <button
                    type="button"
                    className="ehc-wiki-toggle"
                    onClick={() => setIsWikiDescriptionExpanded(!isWikiDescriptionExpanded)}
                    aria-expanded={isWikiDescriptionExpanded}
                  >
                    <span>{isWikiDescriptionExpanded ? 'Mostrar menos' : 'Leer más'}</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                )}
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
                          onKeyDown={(event) => handleActivationKey(event, async () => {
                            const inst = await findInstitution({ rorUrl: emp.ror, name: emp.organization });
                            if (inst) navigate(`/explorer/institution/${inst.id}`);
                          })}
                          role="link"
                          tabIndex={0}
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
                          onKeyDown={(event) => handleActivationKey(event, async () => {
                            const inst = await findInstitution({ rorUrl: edu.ror, name: edu.organization });
                            if (inst) navigate(`/explorer/institution/${inst.id}`);
                          })}
                          role="link"
                          tabIndex={0}
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
          {(type !== 'author' && type !== 'project' && !entity._localTopic) && (
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
              placeholder={`Buscar ${activeTab === 'papers' ? 'papers' : 'autores'} de ${type === 'institution' ? 'esta universidad' : type === 'concept' ? 'esta área' : type === 'project' ? 'este proyecto' : 'esta persona'}...`}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              aria-label={`Buscar ${activeTab === 'papers' ? 'publicaciones' : 'autores'} en esta entidad`}
            />
            {searchQuery && (
              <button className="es-clear" onClick={() => setSearchQuery('')} aria-label="Limpiar búsqueda" title="Limpiar búsqueda">
                <X size={14} />
              </button>
            )}
          </div>
          {activeTab === 'papers' && (
             <button 
                className={`filter-btn ${filters?.category || filters?.peerReviewed || filters?.dateRange ? 'active' : ''}`} 
                onClick={() => setShowFilters(true)}
                aria-label="Abrir filtros"
                title="Filtros"
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
                  onKeyDown={(event) => handleActivationKey(event, () => setSelectedPaper(paper))}
                  role="button"
                  tabIndex={0}
                  aria-label={`Abrir publicación: ${normalizeScientificMarkup(paper.title) || 'Sin título'}`}
                  style={{ '--i': idx }}
                >
                  <div className="eli-header">
                    <span className="eli-cat">{paper.categories && paper.categories.length > 0 ? paper.categories[0] : 'Paper'}</span>
                    <span className="eli-date">{paper.year}</span>
                  </div>
                  <h3 className="eli-title">
                    <ScientificText>{paper.title}</ScientificText>
                    {paper.isPeerReviewed && (
                      <span className="pc-tooltip" data-tooltip="Publicado en revista (Peer-reviewed)" style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: '6px' }}>
                        <BadgeCheck size={16} style={{ color: '#1da1f2' }} />
                      </span>
                    )}
                  </h3>
                  <p className="eli-authors">{(paper.authors || []).map(a => a.name || a).join(', ')}</p>
                  <p className="eli-summary">
                    <ScientificText>{paper.abstract}</ScientificText>
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
                {papersError ? (
                  <>
                    <p role="alert">{papersError}</p>
                    <button className="explorer-clear-btn" onClick={retryPapers}>Reintentar</button>
                  </>
                ) : (
                  <p>No se encontraron resultados que coincidan con tu búsqueda y filtros.</p>
                )}
              </div>
            )}
            {!isLoadingPapers && papersError && filteredPapers.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{papersError}</span>
                <button onClick={retryPapers}>Reintentar</button>
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
                onKeyDown={(event) => handleActivationKey(event, () => navigate(`/explorer/author/${encodeURIComponent(author.id)}`))}
                role="link"
                tabIndex={0}
                aria-label={`Abrir perfil de ${author.display_name}`}
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
            {!isLoadingAuthors && entityAuthors.length === 0 && (
              <div className="explorer-empty">
                {authorsError ? (
                  <>
                    <p role="alert">{authorsError}</p>
                    <button className="explorer-clear-btn" onClick={retryAuthors}>Reintentar</button>
                  </>
                ) : (
                  <p>No se encontraron autores que coincidan con tu búsqueda.</p>
                )}
              </div>
            )}
            {!isLoadingAuthors && authorsError && entityAuthors.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{authorsError}</span>
                <button onClick={retryAuthors}>Reintentar</button>
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
              role="dialog"
              aria-modal="true"
              aria-labelledby="entity-filter-title"
            >
              <div className="ee-filter-header">
                <h3 id="entity-filter-title"><SlidersHorizontal size={18}/> Filtros Avanzados</h3>
                <button className="close-btn" onClick={() => setShowFilters(false)} aria-label="Cerrar filtros" title="Cerrar"><X size={20}/></button>
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
              aria-label="Cerrar publicación"
              title="Volver"
            >
              <ArrowLeft size={22} />
            </button>
            <div className="explorer-overlay-content hide-scroll-hint">
              <PaperCard 
                paper={selectedPaper}
                isLiked={likedPaperIds.has(selectedPaper.id)}
                isSaved={savedPaperIds.has(selectedPaper.id)}
                isRead={readPaperIds.has(selectedPaper.id)}
                onLike={toggleLike}
                onNotInterested={(paper) => { markNotInterested(paper); setSelectedPaper(null); }}
                onMarkAsRead={markAsRead}
                onOpenPdf={(paper) => setPdfPaperToView(paper)}
                onSaveToList={onSaveToList}
                getInteractionState={getInteractionState}
                trackViewTime={trackViewTime}
                trackSkip={trackSkip}
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
