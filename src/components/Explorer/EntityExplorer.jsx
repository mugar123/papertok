import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Building2, Lightbulb, Users, Loader2, Search, X, Share2, ExternalLink, Filter, SlidersHorizontal, ChevronRight, ChevronDown, BadgeCheck, Check, FileText, Briefcase, Globe, MapPin, BookOpen, Download, Eye, Award, Tag } from 'lucide-react';
import { getEntityById, getWorksByEntity, getAuthorsByEntity, enrichPapersBatch, fetchPapersByDois, getAuthorProfileExact, getAuthorProfileByOrcid, findInstitution, getEntityRecentImpact, getLocalTopicEntity, enrichAuthorInstitutionLocalization } from '../../services/openAlexService';
import { isOpenAlexRateLimitError } from '../../services/openAlexClient';
import { fetchPapersByIds, getAuthorPapers } from '../../services/arxivService';
import { ElsevierAdapter, isScopusEnabled, PubmedAdapter, ScopusAdapter } from '../../services/adapters';
import { getPapersByProject, getProjectDetails } from '../../services/openAireService';
import { PaperBuilder } from '../../services/PaperBuilder';
import { extractOrcid, getOrcidRecord } from '../../services/orcidService';
import {
  filterAndSortEntityPapers,
  getPaperCitationCount,
  hasKnownPaperCitationCount,
  pinSourcePaper,
} from '../../utils/entityExplorer';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CATEGORIES } from '../../data/categories';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';
import RecentImpactStat from './RecentImpactStat';
import { normalizeScientificMarkup } from '../../utils/latex';
import { isOpaqueQueryTopicText, resolveQueryTopicRoute } from '../../utils/topicNavigation';
import { scoreQueryTopicPaper } from '../../utils/queryTopicSearch.js';
import { hasUsableAIAbstract } from '../../utils/aiExplanationAccess.js';
import { settleWithin } from '../../utils/asyncTiming';
import { fetchTopicPapers } from '../../services/topicRetrievalService.js';
import { getEntityWikiInfo } from '../../services/wikiService';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { safeExternalUrl } from '../../utils/externalUrl.js';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';
import 'katex/dist/katex.min.css';
import './EntityExplorer.css';

const ENTITY_PRIMARY_RENDER_BUDGET_MS = 7000;
const ENTITY_SUPPLEMENT_RENDER_BUDGET_MS = 3500;

const handleActivationKey = (event, action) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
};

const ROR_RELATION_LABELS = {
  es: {
    parent: 'Parte de',
    child: 'Incluye',
    related: 'Relacionada',
    predecessor: 'Predecesora',
    successor: 'Sucesora',
  },
  en: {
    parent: 'Part of',
    child: 'Includes',
    related: 'Related',
    predecessor: 'Predecessor',
    successor: 'Successor',
  },
};

export default function EntityExplorer({ onSaveToList = () => {} }) {
  const { type, id } = useParams();
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const { language, isEnglish, locale } = useLanguage();
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
  const closeSelectedPaper = useCallback(() => setSelectedPaper(null), []);
  const selectedPaperDialogRef = useDialogFocus(Boolean(selectedPaper && !pdfPaperToView), closeSelectedPaper);
  const [wikiInfo, setWikiInfo] = useState(null);
  const [settledWikiRequestKey, setSettledWikiRequestKey] = useState('');
  const [loadedWikiImageUrl, setLoadedWikiImageUrl] = useState('');
  const [orcidInfo, setOrcidInfo] = useState(null);
  const [isLoadingOrcid, setIsLoadingOrcid] = useState(false);

  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const observerRef = useRef(null);

  const [activeTab, setActiveTab] = useState('papers');
  const [expandedSummary, setExpandedSummary] = useState(false);
  const [participantsExpanded, setParticipantsExpanded] = useState(false);
  const [isWikiDescriptionExpanded, setIsWikiDescriptionExpanded] = useState(false);
  const [isProjectLinksMenuOpen, setIsProjectLinksMenuOpen] = useState(false);
  const [projectSummaryExpandedHeight, setProjectSummaryExpandedHeight] = useState(0);
  const [wikiDescriptionExpandedHeight, setWikiDescriptionExpandedHeight] = useState(0);
  const [isProjectSummaryExpandable, setIsProjectSummaryExpandable] = useState(false);
  const [isWikiDescriptionExpandable, setIsWikiDescriptionExpandable] = useState(false);
  const [resolvingParticipant, setResolvingParticipant] = useState(null);
  const [participantNavigationError, setParticipantNavigationError] = useState('');
  const [isResolvingAuthorInstitution, setIsResolvingAuthorInstitution] = useState(false);
  const [authorInstitutionNavigationError, setAuthorInstitutionNavigationError] = useState('');
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
  const localizedTopicEntity = useMemo(
    () => entity?._localTopic ? getLocalTopicEntity(entity.id || id, language) : null,
    [entity, id, language],
  );
  const entityOfficialName = localizedTopicEntity?.display_name || entity?.display_name || '';
  const entityDisplayName = type === 'institution'
    ? getLocalizedInstitutionName(entity, language)
    : entityOfficialName;
  const authorInstitution = type === 'author'
    ? entity?.institutionData || entity?.last_known_institutions?.[0] || (entity?.institution ? { display_name: entity.institution } : null)
    : null;
  const authorInstitutionDisplayName = getLocalizedInstitutionName(authorInstitution, language);
  const wikiRequestKey = `${entityReloadKey}:${language}:${type}:${entityDisplayName}`;
  const visibleWikiInfo = wikiInfo?._requestKey === wikiRequestKey ? wikiInfo : null;
  const safeRorUrl = safeExternalUrl(entity?.ror);
  const safeProjectWebsiteUrl = safeExternalUrl(entity?.websiteUrl);
  const safeWikiUrl = safeExternalUrl(visibleWikiInfo?.url);
  const safeHomepageUrl = safeExternalUrl(entity?.homepage_url);
  const canLoadWikiInfo = Boolean(
    entityDisplayName && ['institution', 'concept', 'topic', 'source'].includes(type),
  );
  const isWikiRequestPending = canLoadWikiInfo && settledWikiRequestKey !== wikiRequestKey;
  const topicFallbackDescription = ['concept', 'topic'].includes(type)
    ? localizedTopicEntity?.description
      || (typeof entity?.description === 'string' ? entity.description : '')
    : '';
  const wikiDescription = visibleWikiInfo?.extract || topicFallbackDescription;
  const hasLoadedWikiImage = Boolean(
    visibleWikiInfo?.thumbnail && loadedWikiImageUrl === visibleWikiInfo.thumbnail,
  );
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
  }, [entity?.summary, measureExpandableDescriptions, wikiDescription]);

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
    const metadata = entity._queryTopic
      ? {
          query: entity.metadata?.query || entity.query,
          source: entity.metadata?.source || 'free-text',
          categoryIds: entity.metadata?.categoryIds || entity.categoryIds || [],
        }
      : {
          funder: entity.funder,
          categoryIds: entity.categoryIds,
          localizedNames: type === 'institution' ? entity.localized_names : undefined,
        };
    return {
      type: followType,
      id: entity.id || entity.code || id,
      displayName: type === 'institution' ? entityOfficialName : entityDisplayName,
      source: type === 'project' ? 'openaire' : type === 'concept' || type === 'topic' ? 'papertok' : 'openalex',
      externalIds: {
        orcid: entity.orcid,
        ror: entity.ror,
      },
      metadata,
    };
  }, [entity, entityDisplayName, entityOfficialName, id, type]);

  // Reset overlays when navigating to a different entity
  useEffect(() => {
    setTimeout(() => {
      setSelectedPaper(null);
      setPdfPaperToView(null);
      setOrcidInfo(null);
      setActiveTab('papers');
      setExpandedSummary(false);
      setParticipantsExpanded(false);
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

      if (type === 'topic' && isOpaqueQueryTopicText(id)) {
        setEntity(resolveQueryTopicRoute(id, searchParams));
        setIsLoadingEntity(false);
        return;
      }

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

      if (type === 'author' && data) {
        data = await enrichAuthorInstitutionLocalization(data);
        if (isCancelled) return;
      }
      
      setEntity(data);
      setIsLoadingEntity(false);

      if (['institution', 'author'].includes(type) && data) {
        setIsLoadingRecentImpact(true);
        setRecentImpactError(null);
        try {
          const impact = await getEntityRecentImpact(type, data);
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
            console.error(`Failed to load recent ${type} impact`, error);
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

      }
    }
    loadEntity().catch(error => {
      if (isCancelled) return;
      console.error('Failed to load entity', error);
      setEntity(null);
      setEntityError('ENTITY_LOAD_FAILED');
      setIsLoadingEntity(false);
    });
    return () => {
      isCancelled = true;
    };
  }, [type, id, searchParams, entityReloadKey]);

  useEffect(() => {
    if (!canLoadWikiInfo) {
      return undefined;
    }

    let isActive = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    const alternateTitle = language === 'en'
      ? localizedTopicEntity?.labelEs
      : localizedTopicEntity?.labelEn;

    getEntityWikiInfo({
      title: entityDisplayName,
      alternateTitle,
      language,
      signal: controller.signal,
      strictTitleMatch: Boolean(entity?._queryTopic),
    }).then(info => {
      if (isActive && !controller.signal.aborted) {
        setWikiInfo(info ? { ...info, _requestKey: wikiRequestKey } : null);
      }
    }).catch(error => {
      if (error?.name !== 'AbortError') console.error('Failed to fetch Wikipedia info', error);
    }).finally(() => {
      window.clearTimeout(timeout);
      if (isActive) setSettledWikiRequestKey(wikiRequestKey);
    });

    return () => {
      isActive = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [
    canLoadWikiInfo,
    entityDisplayName,
    entity?._queryTopic,
    language,
    localizedTopicEntity?.labelEn,
    localizedTopicEntity?.labelEs,
    type,
    wikiRequestKey,
  ]);

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
        let topicProviderFailure = false;
        
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
            const elsevierAdapter = new ElsevierAdapter();
            const pubmedAdapter = new PubmedAdapter();
            const supplementalPromises = [
              elsevierAdapter.search(`"${entity.display_name}"`, page, { type: 'author' }),
              pubmedAdapter.search(`"${entity.display_name}"`, page, { type: 'author' }),
              isScopusEnabled()
                ? new ScopusAdapter().search(entity.display_name, page, { type: 'author', limit: 8 })
                : Promise.resolve({ papers: [] }),
            ];
            const primaryPromise = !resolvedId.startsWith('stub-')
              ? getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity.display_name)
              : getAuthorPapers(entity.display_name, 30);
            const [primaryResult, supplementalResults] = await Promise.all([
              settleWithin(primaryPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
              Promise.all(supplementalPromises.map(sourcePromise => (
                settleWithin(sourcePromise, ENTITY_SUPPLEMENT_RENDER_BUDGET_MS)
              ))),
            ]);

            if (primaryResult.status === 'fulfilled') {
              if (!resolvedId.startsWith('stub-')) {
                papersFromOA = primaryResult.value?.papers || [];
                total = primaryResult.value?.total || 0;
              } else {
                arxPapersFromNative = primaryResult.value || [];
              }
            } else {
              primaryError = primaryResult.reason || new Error('La fuente principal tardó demasiado en responder.');
            }

            const [els, pub, scopus] = supplementalResults.map(result => result.status === 'fulfilled' ? result.value?.papers || [] : []);
            
            fetchedPapers.push(...papersFromOA, ...arxPapersFromNative, ...els, ...pub, ...scopus);

            const supplementalError = supplementalResults.find(result => result.status === 'rejected')?.reason;
            if (fetchedPapers.length === 0 && (primaryError || supplementalError)) {
              throw primaryError || supplementalError;
            }
            
            if (resolvedId.startsWith('stub-')) {
              total = fetchedPapers.length;
            }
         } else if ((type === 'concept' || type === 'topic') && (entity._localTopic || entity._queryTopic)) {
            const topicResult = await fetchTopicPapers({
              ...entity,
              canonicalId: resolvedId,
              displayName: entityDisplayName,
            }, {
              filters,
              mode: sortBy.includes('publication_date') ? 'recent' : 'relevance',
              page,
              pageSize: 30,
              searchQuery: debouncedSearch,
              sortBy,
              timeoutMs: ENTITY_SUPPLEMENT_RENDER_BUDGET_MS,
            });
            if (topicResult.allFailed) throw new Error('All topic providers timed out.');
            topicProviderFailure = topicResult.partial;
            fetchedPapers.push(...topicResult.papers);
            total = topicResult.hasMore
              ? page * 30 + 1
              : (page - 1) * 30 + fetchedPapers.length;
         } else {
            const primaryResult = await settleWithin(
              getWorksByEntity(type, resolvedId, sortBy, page, debouncedSearch, filters, entity.display_name),
              ENTITY_PRIMARY_RENDER_BUDGET_MS,
            );
            if (primaryResult.status !== 'fulfilled') {
              throw primaryResult.reason || new Error('La fuente principal tardó demasiado en responder.');
            }
            const res = primaryResult.value;
            fetchedPapers.push(...(res.papers || []));
            total = res.total;
         }
        
        // Resolve project identifiers concurrently; arXiv availability must not
        // postpone DOI-backed papers that OpenAlex has already returned.
        const arxivPapersPromise = arxivIds.length > 0
          ? Promise.all([
              fetchPapersByIds(arxivIds),
              enrichPapersBatch(arxivIds, { allowProxy: false, timeoutMs: ENTITY_PRIMARY_RENDER_BUDGET_MS }),
            ]).then(([rawPapers, enrichmentMap]) => rawPapers.map(paper => {
              const enriched = enrichmentMap[paper.id];
              if (!enriched) return paper;
              const merged = PaperBuilder.merge(paper, enriched, 'openalex');
              merged._isOpenAlexEnriched = true;
              return merged;
            }))
          : Promise.resolve([]);
        const doiPapersPromise = dois.length > 0 ? fetchPapersByDois(dois) : Promise.resolve([]);
        const [arxivResult, doiResult] = await Promise.all([
          settleWithin(arxivPapersPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
          settleWithin(doiPapersPromise, ENTITY_PRIMARY_RENDER_BUDGET_MS),
        ]);
        if (arxivResult.status === 'fulfilled') fetchedPapers.push(...arxivResult.value);
        if (doiResult.status === 'fulfilled') fetchedPapers.push(...doiResult.value);
        
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

        if (topicProviderFailure && fetchedPapers.length > 0) {
          setPapersError('PARTIAL_PUBLICATIONS_LOAD_FAILED');
        }

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
        setPapersError('PUBLICATIONS_LOAD_FAILED');
        setHasMore(false); // Stop infinite looping on errors
      }
      if (isCancelled) return;
      setIsLoadingPapers(false);
      setIsFetchingMore(false);
    }
    loadPapers();
    return () => { isCancelled = true; };
  }, [type, id, entity, entityDisplayName, sortBy, page, debouncedSearch, filters, activeTab, searchParams, papersReloadKey]);

  useEffect(() => {
    let isCancelled = false;
    async function loadAuthors() {
      if (!entity || type === 'author' || entity._localTopic || entity._queryTopic || activeTab !== 'authors') return;
      if (authorsPage === 1) {
        setIsLoadingAuthors(true);
        setAuthorsError(null);
      }
      else setIsFetchingMoreAuthors(true);
      
      try {
        const resolvedId = entity.id || id;
        const { authors, total } = await getAuthorsByEntity(
          type,
          resolvedId,
          authorsPage,
          debouncedSearch,
          entity.display_name,
        );
        
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
        setAuthorsError('AUTHORS_LOAD_FAILED');
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
    const sortedPapers = filterAndSortEntityPapers(papers, { sortBy });
    if (!entity?._queryTopic) return sortedPapers;
    return [...sortedPapers].sort((left, right) => (
      scoreQueryTopicPaper(right, entity) - scoreQueryTopicPaper(left, entity)
    ));
  }, [entity, papers, sortBy]);

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: entityDisplayName || 'PaperTok',
        url: window.location.href,
      }).catch(console.error);
    } else {
      navigator.clipboard.writeText(window.location.href);
      alert(isEnglish ? 'Link copied to clipboard' : 'Enlace copiado al portapapeles');
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
        setParticipantNavigationError(isEnglish
          ? `We could not find an institution profile for ${participant.name}.`
          : `No encontramos el perfil institucional de ${participant.name}.`);
      }
    } catch (error) {
      console.error('Failed to resolve project participant', error);
      setParticipantNavigationError(isEnglish
        ? `We could not open ${participant.name}. Try again.`
        : `No pudimos abrir ${participant.name}. Inténtalo de nuevo.`);
    } finally {
      setResolvingParticipant(null);
    }
  };

  const openAuthorInstitution = async () => {
    const knownInstitution = entity?.last_known_institutions?.[0];
    const institutionName = entity?.institution || knownInstitution?.display_name;
    const institutionId = knownInstitution?.id?.split('/').pop();
    const rorId = knownInstitution?.ror?.split('/').pop();

    if ((!institutionName && !institutionId && !rorId) || isResolvingAuthorInstitution) return;

    setIsResolvingAuthorInstitution(true);
    setAuthorInstitutionNavigationError('');
    try {
      if (institutionId || rorId) {
        navigate(`/explorer/institution/${institutionId || rorId}`);
        return;
      }

      const institution = await findInstitution({
        name: institutionName,
        aliases: [knownInstitution?.display_name, entity?.institution].filter(Boolean),
      });

      if (institution?.id) {
        navigate(`/explorer/institution/${institution.id.split('/').pop()}`);
      } else {
        setAuthorInstitutionNavigationError(isEnglish
          ? 'We could not find this institution profile.'
          : 'No encontramos el perfil de esta institución.');
      }
    } catch (error) {
      console.error('Failed to resolve author institution', error);
      setAuthorInstitutionNavigationError(isEnglish
        ? 'We could not open this institution. Try again.'
        : 'No pudimos abrir esta institución. Inténtalo de nuevo.');
    } finally {
      setIsResolvingAuthorInstitution(false);
    }
  };

  if (isLoadingEntity) return (
      <div className="explorer-container">
        <div className="explorer-hero">
          <div className="explorer-hero-top">
            <div className="eht-left">
              <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
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
        <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
          <ArrowLeft size={24} />
        </button>
        <h2>{entityError
          ? (isEnglish ? 'The entity could not be loaded' : 'No se pudo cargar la entidad')
          : (isEnglish ? 'Entity not found' : 'Entidad no encontrada')}</h2>
        {entityError && (
          <>
            <p role="alert">{getUiErrorMessage(entityError, language, 'ENTITY_LOAD_FAILED')}</p>
            <button className="explorer-clear-btn" onClick={retryEntity}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
          </>
        )}
      </div>
    );
  }

  const renderIcon = () => {
    if (type === 'institution') return <Building2 size={36} />;
    if (type === 'concept' || type === 'topic') return <Lightbulb size={36} />;
    if (type === 'source') return <FileText size={36} />;
    if (type === 'project') return <Briefcase size={36} />;
    return <Users size={36} />;
  };

  const entityTypeLabel = type === 'author'
    ? (isEnglish ? 'Author' : 'Autor')
    : type === 'institution'
      ? (isEnglish ? 'University / Institution' : 'Universidad / Institución')
      : type === 'source'
        ? (isEnglish ? 'Journal' : 'Revista')
        : type === 'project'
          ? (isEnglish ? 'Research project' : 'Proyecto de investigación')
          : (isEnglish ? 'Topic' : 'Tema');
  const topConcepts = entity.x_concepts ? entity.x_concepts.slice(0, 4) : [];

  return (
    <div className="explorer-container">
      {/* Immersive Hero */}
      <div className="explorer-hero">
        <AnimatePresence>
          {hasLoadedWikiImage && (
            <motion.div 
              key="bg-blur"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1.0 }}
              className="ehc-bg-blur" 
              style={{ backgroundImage: `url(${visibleWikiInfo.thumbnail})` }}
            ></motion.div>
          )}
        </AnimatePresence>
        
        <div className="explorer-hero-top">
          <div className="eht-left">
            <button className="explorer-back-btn" onClick={() => navigate(-1)} aria-label={isEnglish ? 'Back' : 'Volver'} title={isEnglish ? 'Back' : 'Volver'}>
              <ArrowLeft size={20} />
            </button>
            <span className="ehc-type">{entityTypeLabel}</span>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="explorer-action-btn" onClick={handleShare} aria-label={isEnglish ? 'Share' : 'Compartir'} title={isEnglish ? 'Share' : 'Compartir'}>
              <Share2 size={18} />
            </button>
          </div>
        </div>
        
        <div className="explorer-hero-content">
          <div className="ehc-main">
            <div className="ehc-visual-slot">
              <motion.div
                className="ehc-icon"
                initial={false}
                animate={{ opacity: hasLoadedWikiImage ? 0 : 1, scale: hasLoadedWikiImage ? 0.96 : 1 }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
                aria-hidden={hasLoadedWikiImage}
              >
                {renderIcon()}
              </motion.div>
              <AnimatePresence>
                {visibleWikiInfo?.thumbnail && (
                  <motion.div
                    key={visibleWikiInfo.thumbnail}
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: hasLoadedWikiImage ? 1 : 0, scale: hasLoadedWikiImage ? 1 : 0.96 }}
                    exit={{ opacity: 0, scale: 0.97 }}
                    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
                    className="ehc-wiki-image"
                  >
                    <img
                      src={visibleWikiInfo.thumbnail}
                      alt={entityDisplayName}
                      onLoad={() => setLoadedWikiImageUrl(visibleWikiInfo.thumbnail)}
                      onError={() => setLoadedWikiImageUrl('')}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="ehc-info">
              <div className="ehc-title-row">
                <h1 className="ehc-name" style={{ margin: 0 }}>{entityDisplayName}</h1>
                {followEntity && (
                  <button
                    className={`entity-follow-btn ${isFollowing(followEntity) ? 'following' : ''} ${isFollowPending(followEntity) ? 'is-pending' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleFollow(followEntity).catch(console.error); }}
                    disabled={isFollowPending(followEntity)}
                    aria-pressed={isFollowing(followEntity)}
                  >
                    {isFollowing(followEntity)
                        ? <><Check size={14} /> <span>{isEnglish ? 'Following' : 'Siguiendo'}</span></>
                        : <span>{isEnglish ? 'Follow' : 'Seguir'}</span>}
                  </button>
                )}
              </div>
              {type === 'institution' && (
                <>
                  <p className="ehc-meta">
                    {[entity.geo?.city, entity.geo?.country].filter(Boolean).join(', ')}
                  </p>
                  {entity.rorVerified && safeRorUrl && (
                    <div className="ehc-institution-identity">
                      <a href={safeRorUrl} target="_blank" rel="noopener noreferrer" title={isEnglish ? 'View official ROR record' : 'Ver registro oficial en ROR'}>
                        <BadgeCheck size={13} /> {isEnglish ? 'ROR verified' : 'ROR verificado'}
                      </a>
                      {entity.established && <span>{isEnglish ? 'Since' : 'Desde'} {entity.established}</span>}
                    </div>
                  )}
                  {entity.relationships?.length > 0 && (
                    <div className="ehc-ror-relations" aria-label={isEnglish ? 'Institutional relationships verified by ROR' : 'Relaciones institucionales verificadas por ROR'}>
                      {entity.relationships.slice(0, 4).map(relationship => (
                        <button
                          key={`${relationship.type}-${relationship.rorId}`}
                          type="button"
                          onClick={() => navigate(`/explorer/institution/${relationship.rorId}`)}
                          title={`${ROR_RELATION_LABELS[language][relationship.type] || ROR_RELATION_LABELS[language].related}: ${relationship.label}`}
                        >
                          <span>{ROR_RELATION_LABELS[language][relationship.type] || ROR_RELATION_LABELS[language].related}</span>
                          <strong>{relationship.label}</strong>
                          <ChevronRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {type === 'author' && authorInstitutionDisplayName && (
                <div className="ehc-author-institution-wrap">
                  <button
                    type="button"
                    className="ehc-author-institution"
                    onClick={openAuthorInstitution}
                    disabled={isResolvingAuthorInstitution}
                    title={isEnglish ? 'View institution' : 'Ver institución'}
                  >
                    {isResolvingAuthorInstitution ? <Loader2 className="spinning" size={15} /> : <Building2 size={15} />}
                    <span>{authorInstitutionDisplayName}</span>
                  </button>
                  {authorInstitutionNavigationError && (
                    <p className="ehc-author-institution-error" role="alert">{authorInstitutionNavigationError}</p>
                  )}
                </div>
              )}
              {type === 'project' && entity.funder && (
                <p className="ehc-meta">
                  {entity.funder}{entity.fundingStream ? ` — ${entity.fundingStream}` : ''}
                </p>
              )}
              {type === 'project' && (entity.openaireId || safeProjectWebsiteUrl) && (
                <div className="project-links-menu" ref={projectLinksMenuRef}>
                  <button
                    type="button"
                    className={`project-links-trigger ${isProjectLinksMenuOpen ? 'is-open' : ''}`}
                    onClick={() => setIsProjectLinksMenuOpen(!isProjectLinksMenuOpen)}
                    aria-expanded={isProjectLinksMenuOpen}
                    aria-haspopup="menu"
                  >
                    <Globe size={15} />
                    <span>{isEnglish ? 'View project' : 'Ver proyecto'}</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                  <AnimatePresence>
                    {isProjectLinksMenuOpen && (
                      <motion.div
                        className="project-links-dropdown"
                        initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
                        transition={prefersReducedMotion
                          ? { duration: 0 }
                          : { duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
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
                            <span>
                              <strong>{isEnglish ? 'OpenAIRE record' : 'Ficha en OpenAIRE'}</strong>
                              <small>{isEnglish ? 'Data, publications, and participants' : 'Datos, publicaciones y participantes'}</small>
                            </span>
                            <ExternalLink size={14} />
                          </a>
                        )}
                        {safeProjectWebsiteUrl && (
                          <a
                            className="project-links-option"
                            href={safeProjectWebsiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => setIsProjectLinksMenuOpen(false)}
                            role="menuitem"
                          >
                            <span className="project-links-option-icon"><Globe size={16} /></span>
                            <span>
                              <strong>{isEnglish ? 'Official website' : 'Sitio oficial'}</strong>
                              <small>{isEnglish ? 'The project’s own website' : 'Web del propio proyecto'}</small>
                            </span>
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
                <span className="ehc-stat-value">{entity.works_count.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Publications' : 'Publicaciones'}</span>
              </div>
            )}
            {entity?.cited_by_count != null && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.cited_by_count.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Total citations' : 'Citas totales'}</span>
              </div>
            )}
            {(entity?.summary_stats?.h_index != null || entity?.h_index != null) && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity?.summary_stats?.h_index ?? entity?.h_index}</span>
                <span className="ehc-stat-label">{type === 'source' ? (isEnglish ? 'Type' : 'Tipo') : 'H-Index'}</span>
              </div>
            )}
            {['institution', 'author'].includes(type) && (
              <RecentImpactStat
                impact={recentImpact}
                isLoading={isLoadingRecentImpact}
                error={recentImpactError}
                isEnglish={isEnglish}
              />
            )}
            {type === 'project' && entity.budget > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.budget); } catch { return `${entity.budget.toLocaleString(locale)} €`; } })()}
                </span>
                <span className="ehc-stat-label">{isEnglish ? 'Total budget' : 'Presupuesto total'}</span>
              </div>
            )}
            {type === 'project' && entity.fundedAmount > 0 && entity.fundedAmount !== entity.budget && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">
                  {(() => { try { return new Intl.NumberFormat(locale, { style: 'currency', currency: entity.currency, maximumFractionDigits: 0 }).format(entity.fundedAmount); } catch { return `${entity.fundedAmount.toLocaleString(locale)} €`; } })()}
                </span>
                <span className="ehc-stat-label">{isEnglish ? 'Funding' : 'Financiación'}</span>
              </div>
            )}
            {type === 'project' && entity.startDate && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.startDate.split('-')[0]} - {entity.endDate?.split('-')[0] || '...'}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Duration' : 'Duración'}</span>
              </div>
            )}
            {type === 'project' && entity.participants?.length > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.participants.length}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Participants' : 'Participantes'}</span>
              </div>
            )}
            {type === 'project' && entity.measures?.citations > 0 && (
              <div className="ehc-stat-box">
                <span className="ehc-stat-value">{entity.measures.citations.toLocaleString(locale)}</span>
                <span className="ehc-stat-label">{isEnglish ? 'Citations' : 'Citas'}</span>
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
                <span className="project-chip"><Download size={13} /> {entity.measures.downloads.toLocaleString(locale)} {isEnglish ? 'downloads' : 'descargas'}</span>
              )}
              {entity.measures?.views > 0 && (
                <span className="project-chip"><Eye size={13} /> {entity.measures.views.toLocaleString(locale)} {isEnglish ? 'views' : 'vistas'}</span>
              )}
            </div>
          )}

          {/* Project Summary - expandable */}
          {type === 'project' && entity?.summary && (
            <motion.div
              layout={!prefersReducedMotion}
              className={`project-summary-box ${expandedSummary ? 'is-expanded' : ''} ${isProjectSummaryExpandable ? 'is-expandable' : ''}`}
              onClick={isProjectSummaryExpandable ? () => setExpandedSummary(!expandedSummary) : undefined}
              onKeyDown={isProjectSummaryExpandable ? (event) => handleActivationKey(event, () => setExpandedSummary(!expandedSummary)) : undefined}
              role={isProjectSummaryExpandable ? 'button' : undefined}
              tabIndex={isProjectSummaryExpandable ? 0 : undefined}
              aria-expanded={isProjectSummaryExpandable ? expandedSummary : undefined}
              aria-label={isProjectSummaryExpandable
                ? expandedSummary
                  ? (isEnglish ? 'Collapse project summary' : 'Contraer resumen del proyecto')
                  : (isEnglish ? 'Expand project summary' : 'Ampliar resumen del proyecto')
                : undefined}
              transition={prefersReducedMotion
                ? { duration: 0 }
                : { layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] } }}
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
                  <ChevronDown size={14} /> {expandedSummary
                    ? (isEnglish ? 'Show less' : 'Mostrar menos')
                    : (isEnglish ? 'Read more' : 'Leer más')}
                </span>
              )}
            </motion.div>
          )}

          {/* Project subjects */}
          {type === 'project' && entity.subjects?.length > 0 && (
            <div className="project-subjects">
              <h4 className="project-section-title"><Tag size={14} /> {isEnglish ? 'Project topics' : 'Temas del proyecto'}</h4>
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
              <h4 className="project-section-title"><Building2 size={14} /> {isEnglish ? 'Participating organizations' : 'Organizaciones participantes'}</h4>
              <motion.div
                id="project-participants-list"
                layout={!prefersReducedMotion}
                className="project-participants-grid"
                transition={prefersReducedMotion ? { duration: 0 } : { layout: { duration: 0.28 } }}
              >
                <AnimatePresence initial={false}>
                {entity.participants.slice(0, participantsExpanded ? entity.participants.length : 6).map((p, i) => (
                  <motion.button
                    key={`${p.name}-${p.country || i}`}
                    type="button"
                    className="project-participant-card"
                    layout={!prefersReducedMotion}
                    initial={i < 6 || prefersReducedMotion ? false : { opacity: 0, y: 8, scale: 0.985 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.99 }}
                    transition={prefersReducedMotion
                      ? { duration: 0 }
                      : { duration: 0.24, delay: i < 6 ? 0 : Math.min((i - 6) * 0.025, 0.18) }}
                    onClick={() => openParticipantInstitution(p)}
                    disabled={resolvingParticipant === p.name}
                    aria-label={`${isEnglish ? 'Open institution profile for' : 'Abrir perfil institucional de'} ${p.name}`}
                  >
                    <span className="project-participant-info">
                      <span className="project-participant-name">{p.name}</span>
                      {p.country && <span className="project-participant-country"><MapPin size={11} /> {p.country}</span>}
                    </span>
                    {resolvingParticipant === p.name
                      ? <Loader2 size={15} className="ehc-spinner" aria-hidden="true" />
                      : <ChevronRight size={15} className="project-participant-arrow" aria-hidden="true" />}
                  </motion.button>
                ))}
                </AnimatePresence>
              </motion.div>
              {participantNavigationError && (
                <p className="project-participant-error" role="alert">{participantNavigationError}</p>
              )}
              {entity.participants.length > 6 && (
                <button
                  className="project-show-more"
                  onClick={() => setParticipantsExpanded(value => !value)}
                  aria-expanded={participantsExpanded}
                  aria-controls="project-participants-list"
                >
                  {participantsExpanded
                    ? (isEnglish ? 'Show fewer organizations' : 'Mostrar menos organizaciones')
                    : `+${entity.participants.length - 6} ${isEnglish ? 'more organizations' : 'organizaciones más'}`}
                </button>
              )}
            </div>
          )}
          
          {/* Wikipedia or external info */}
          <AnimatePresence initial={false}>
            {(wikiDescription || entity?.homepage_url || (isWikiRequestPending && ['concept', 'topic'].includes(type))) && (
              <motion.div 
                layout
                className={`ehc-wiki ${isWikiDescriptionExpanded ? 'is-expanded' : ''} ${isWikiRequestPending && !wikiDescription ? 'is-loading' : ''}`}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -8 }}
                animate={{ opacity: 1, height: 'auto', y: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, y: -6 }}
                transition={prefersReducedMotion
                  ? { duration: 0 }
                  : {
                    opacity: { duration: 0.3 },
                    height: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
                    y: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
                    layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
                  }}
                aria-busy={isWikiRequestPending && !wikiDescription}
              >
                {isWikiRequestPending && !wikiDescription ? (
                  <div className="ehc-wiki-skeleton" role="status" aria-label={isEnglish ? 'Loading topic details' : 'Cargando información del tema'}>
                    <span />
                    <span />
                    <span />
                  </div>
                ) : wikiDescription ? (
                  <p
                    ref={wikiDescriptionTextRef}
                    className={isWikiDescriptionExpanded ? 'expanded' : 'collapsed'}
                    style={wikiDescriptionExpandedHeight ? { '--wiki-description-expanded-height': `${wikiDescriptionExpandedHeight}px` } : undefined}
                  >
                    {wikiDescription}
                  </p>
                ) : null}
                {isWikiDescriptionExpandable && (
                  <button
                    type="button"
                    className="ehc-wiki-toggle"
                    onClick={() => setIsWikiDescriptionExpanded(!isWikiDescriptionExpanded)}
                    aria-expanded={isWikiDescriptionExpanded}
                  >
                    <span>{isWikiDescriptionExpanded
                      ? (isEnglish ? 'Show less' : 'Mostrar menos')
                      : (isEnglish ? 'Read more' : 'Leer más')}</span>
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                )}
                <div className="ehc-links">
                  {safeWikiUrl && (
                    <a href={safeWikiUrl} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      Wikipedia <ExternalLink size={14} />
                    </a>
                  )}
                  {safeHomepageUrl && (
                    <a href={safeHomepageUrl} target="_blank" rel="noopener noreferrer" className="ehc-link">
                      {isEnglish ? 'Official website' : 'Web oficial'} <ExternalLink size={14} />
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
                    <span className="orcid-badge-label">{isEnglish ? 'Verified ORCID profile' : 'Perfil verificado ORCID'}</span>
                    <span className="orcid-badge-id">{orcidInfo.orcid}</span>
                  </div>
                </div>
                <a href={`https://orcid.org/${orcidInfo.orcid}`} target="_blank" rel="noopener noreferrer" className="orcid-profile-link">
                  {isEnglish ? 'View profile' : 'Ver perfil'} <ExternalLink size={12} />
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
                  {orcidInfo.researcherUrls.map((u, i) => {
                    const safeUrl = safeExternalUrl(u.url);
                    return safeUrl ? (
                      <a key={i} href={safeUrl} target="_blank" rel="noopener noreferrer" className="orcid-ext-link">
                        <Globe size={12} />
                        {u.name || (isEnglish ? 'External link' : 'Enlace externo')}
                      </a>
                    ) : null;
                  })}
                </div>
              )}

              {/* Work experience timeline */}
              {orcidInfo.employments?.length > 0 && (
                <div className="orcid-timeline-block">
                  <div className="orcid-timeline-title">
                    <span className="orcid-tl-icon orcid-tl-icon--work"><Briefcase size={12} /></span>
                    {isEnglish ? 'Professional experience' : 'Experiencia profesional'}
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
                          title={`${isEnglish ? 'Find and view profile for' : 'Buscar y ver perfil de'} ${emp.organization}`}
                        >
                          {emp.organization}
                        </div>
                        {emp.role && <div className="orcid-item-role">{emp.role}</div>}
                        {emp.startDate && (
                          <div className="orcid-item-dates">
                            {emp.startDate}
                            <span className="dot-separator">→</span>
                            {emp.endDate || (isEnglish ? 'Present' : 'Presente')}
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
                    {isEnglish ? 'Education' : 'Formación académica'}
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
                          title={`${isEnglish ? 'Find and view profile for' : 'Buscar y ver perfil de'} ${edu.organization}`}
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
             {isEnglish ? 'Papers' : 'Artículos'}
          </button>
          {(type !== 'author' && type !== 'project' && !entity._localTopic && !entity._queryTopic) && (
             <button className={`ee-tab ${activeTab === 'authors' ? 'active' : ''}`} onClick={() => setActiveTab('authors')}>
               {isEnglish ? 'Authors' : 'Autores'}
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
              placeholder={isEnglish
                ? `Search ${activeTab === 'papers' ? 'papers' : 'authors'} from ${type === 'institution' ? 'this institution' : type === 'concept' || type === 'topic' ? 'this topic' : type === 'project' ? 'this project' : 'this person'}...`
                : `Buscar ${activeTab === 'papers' ? 'publicaciones' : 'autores'} de ${type === 'institution' ? 'esta universidad' : type === 'concept' || type === 'topic' ? 'este tema' : type === 'project' ? 'este proyecto' : 'esta persona'}...`}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              aria-label={isEnglish
                ? `Search ${activeTab === 'papers' ? 'publications' : 'authors'} in this entity`
                : `Buscar ${activeTab === 'papers' ? 'publicaciones' : 'autores'} en esta entidad`}
            />
            {searchQuery && (
              <button className="es-clear" onClick={() => setSearchQuery('')} aria-label={isEnglish ? 'Clear search' : 'Limpiar búsqueda'} title={isEnglish ? 'Clear search' : 'Limpiar búsqueda'}>
                <X size={14} />
              </button>
            )}
          </div>
          {activeTab === 'papers' && (
             <button 
                className={`filter-btn ${filters?.category || filters?.peerReviewed || filters?.dateRange ? 'active' : ''}`} 
                onClick={() => setShowFilters(true)}
                aria-label={isEnglish ? 'Open filters' : 'Abrir filtros'}
                title={isEnglish ? 'Filters' : 'Filtros'}
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
                  aria-label={`${isEnglish ? 'Open publication' : 'Abrir publicación'}: ${normalizeScientificMarkup(paper.title) || (isEnglish ? 'Untitled' : 'Sin título')}`}
                  style={{ '--i': Math.min(idx, 8) }}
                >
                  <div className="eli-header">
                    <span className="eli-cat">{paper.categories && paper.categories.length > 0 ? paper.categories[0] : 'Paper'}</span>
                    <div className="eli-metrics">
                      {hasKnownPaperCitationCount(paper) && (
                        paper.sources?.primary === 'scopus' && paper.scopusCitedByUrl ? (
                          <a
                            className="eli-citations eli-citations--link"
                            href={safeExternalUrl(paper.scopusCitedByUrl) || undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`${getPaperCitationCount(paper).toLocaleString(locale)} ${isEnglish ? 'citations on Scopus' : 'citas en Scopus'}`}
                          >
                            <Award size={13} />
                            {getPaperCitationCount(paper).toLocaleString(locale)} {isEnglish ? 'citations on Scopus' : 'citas en Scopus'}
                          </a>
                        ) : (
                          <span className="eli-citations">
                            <Award size={13} />
                            {getPaperCitationCount(paper).toLocaleString(locale)} {isEnglish ? 'citations' : 'citas'}
                          </span>
                        )
                      )}
                      <span className="eli-date">{paper.year}</span>
                    </div>
                  </div>
                  <h3 className="eli-title">
                    <ScientificText>{paper.title}</ScientificText>
                    {paper.isPeerReviewed && (
                      <span className="pc-tooltip" data-tooltip={isEnglish ? 'Published in a peer-reviewed journal' : 'Publicado en revista (revisado por pares)'} style={{ display: 'inline-flex', verticalAlign: 'middle', marginLeft: '6px' }}>
                        <BadgeCheck size={16} style={{ color: '#1da1f2' }} />
                      </span>
                    )}
                  </h3>
                  <p className="eli-authors">{(paper.authors || []).map(a => a.name || a).join(', ')}</p>
                  <p className="eli-summary">
                    {hasUsableAIAbstract(paper.abstract)
                      ? <ScientificText>{paper.abstract}</ScientificText>
                      : (isEnglish ? 'Abstract unavailable.' : 'Resumen no disponible.')}
                  </p>
                </div>
              ))}
              
              {isLoadingPapers && !isFetchingMore && [1, 2, 3, 4, 5].map((n) => (
                  <div
                    key={`skeleton-${n}`} 
                    className="explorer-list-item skeleton-item"
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
                  </div>
                ))}

              {/* Infinite Scroll Sentinel */}
              {hasMore && (
                <div ref={observerRef} className="ehc-sentinel">
                  <Loader2 className="ehc-spinner" size={24} />
                  <span>{isEnglish ? 'Loading more articles...' : 'Cargando más artículos...'}</span>
                </div>
              )}
            </div>
            
            {!isLoadingPapers && filteredPapers.length === 0 && (
              <div className="explorer-empty">
                {papersError ? (
                  <>
                    <p role="alert">{getUiErrorMessage(papersError, language, 'PUBLICATIONS_LOAD_FAILED')}</p>
                    <button className="explorer-clear-btn" onClick={retryPapers}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
                  </>
                ) : (
                  <p>{isEnglish
                    ? 'No results matched your search and filters.'
                    : 'No se encontraron resultados que coincidan con tu búsqueda y filtros.'}</p>
                )}
              </div>
            )}
            {!isLoadingPapers && papersError && filteredPapers.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{getUiErrorMessage('PARTIAL_PUBLICATIONS_LOAD_FAILED', language)}</span>
                <button onClick={retryPapers}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
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
                aria-label={`${isEnglish ? 'Open profile for' : 'Abrir perfil de'} ${author.display_name}`}
              >
                <div className="ee-author-icon"><Users size={24} /></div>
                <div className="ee-author-info">
                  <h4>{author.display_name}</h4>
                  <p className="ee-author-metrics">
                    {author.source === 'crossref'
                      ? `${author.works_count.toLocaleString(locale)} ${isEnglish ? 'matching publications' : 'publicaciones coincidentes'}`
                      : `H-Index: ${author.h_index} • ${author.cited_by_count.toLocaleString(locale)} ${isEnglish ? 'citations' : 'citas'}`}
                  </p>
                </div>
                <ChevronRight size={18} className="ee-author-arrow" />
              </div>
            ))}
            
            {isLoadingAuthors && !isFetchingMoreAuthors && [1, 2, 3, 4, 5, 6].map(n => (
                <div
                  key={`skel-author-${n}`} 
                  className="ee-author-card skeleton-item"
                >
                  <div className="ee-author-icon skel skel-circle" style={{ width: '40px', height: '40px' }}></div>
                  <div className="ee-author-info">
                    <div className="skel skel-line" style={{ width: '70%', height: '18px', marginBottom: '8px' }}></div>
                    <div className="skel skel-line" style={{ width: '50%', height: '12px' }}></div>
                  </div>
                </div>
              ))}
            
            {hasMoreAuthors && (
              <div ref={observerAuthorsRef} className="ehc-sentinel">
                <Loader2 className="ehc-spinner" size={24} />
                <span>{isEnglish ? 'Loading more authors...' : 'Cargando más autores...'}</span>
              </div>
            )}
            {!isLoadingAuthors && entityAuthors.length === 0 && (
              <div className="explorer-empty">
                {authorsError ? (
                  <>
                    <p role="alert">{getUiErrorMessage(authorsError, language, 'AUTHORS_LOAD_FAILED')}</p>
                    <button className="explorer-clear-btn" onClick={retryAuthors}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
                  </>
                ) : (
                  <p>{isEnglish ? 'No authors matched your search.' : 'No se encontraron autores que coincidan con tu búsqueda.'}</p>
                )}
              </div>
            )}
            {!isLoadingAuthors && authorsError && entityAuthors.length > 0 && (
              <div className="explorer-inline-error" role="alert">
                <span>{getUiErrorMessage('PARTIAL_AUTHORS_LOAD_FAILED', language)}</span>
                <button onClick={retryAuthors}>{isEnglish ? 'Try again' : 'Reintentar'}</button>
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
              initial={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
              animate={prefersReducedMotion ? { opacity: 1 } : { x: 0 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { x: '100%' }}
              transition={prefersReducedMotion ? { duration: 0 } : { type: 'spring', damping: 25, stiffness: 200 }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="entity-filter-title"
            >
              <div className="ee-filter-header">
                <h3 id="entity-filter-title"><SlidersHorizontal size={18}/> {isEnglish ? 'Advanced filters' : 'Filtros avanzados'}</h3>
                <button className="close-btn" onClick={() => setShowFilters(false)} aria-label={isEnglish ? 'Close filters' : 'Cerrar filtros'} title={isEnglish ? 'Close' : 'Cerrar'}><X size={20}/></button>
              </div>
              <div className="ee-filter-body">
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Sort by' : 'Ordenar por'}</h4>
                  <div className="ee-filter-chips">
                    <button 
                      className={`ee-filter-chip ${sortBy === 'cited_by_count:desc' ? 'active' : ''}`}
                      onClick={() => setSortBy('cited_by_count:desc')}
                    >
                      {isEnglish ? 'Most cited' : 'Más citados'}
                    </button>
                    <button 
                      className={`ee-filter-chip ${sortBy === 'publication_date:desc' ? 'active' : ''}`}
                      onClick={() => setSortBy('publication_date:desc')}
                    >
                      {isEnglish ? 'Most recent' : 'Más recientes'}
                    </button>
                  </div>
                </div>
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Category (Area)' : 'Categoría (Área)'}</h4>
                  <div className="ee-filter-chips">
                    <button 
                      className={`ee-filter-chip ${filters.category === '' ? 'active' : ''}`}
                      onClick={() => setFilters({...filters, category: ''})}
                    >
                      {isEnglish ? 'All' : 'Todas'}
                    </button>
                    {Object.entries(CATEGORIES).map(([key, cat]) => (
                      <button 
                        key={key} 
                        className={`ee-filter-chip ${filters.category === key ? 'active' : ''}`}
                        onClick={() => setFilters({...filters, category: key})}
                      >
                        {isEnglish ? cat.labelEn : cat.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="ee-filter-section">
                  <h4>{isEnglish ? 'Publication date' : 'Fecha de publicación'}</h4>
                  <div className="ee-filter-chips">
                    {['', 'last_year', 'last_5_years'].map(val => (
                      <button 
                        key={val}
                        className={`ee-filter-chip ${filters.dateRange === val ? 'active' : ''}`}
                        onClick={() => setFilters({...filters, dateRange: val})}
                      >
                        {val === ''
                          ? (isEnglish ? 'Any date' : 'Cualquier fecha')
                          : val === 'last_year'
                            ? (isEnglish ? 'Last year' : 'Último año')
                            : (isEnglish ? 'Last 5 years' : 'Últimos 5 años')}
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
                    {isEnglish ? 'Peer-reviewed only' : 'Solo revisados por pares'}
                  </label>
                </div>
              </div>
              <div className="ee-filter-footer">
                <button className="ee-filter-reset" onClick={() => { setFilters({category:'', peerReviewed:false, dateRange:''}); setShowFilters(false); }}>
                  {isEnglish ? 'Reset' : 'Restablecer'}
                </button>
                <button className="ee-filter-apply" onClick={() => setShowFilters(false)}>
                  {isEnglish ? 'Apply filters' : 'Aplicar filtros'}
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Paper Card Overlay */}
      <AnimatePresence initial={false}>
        {selectedPaper && !pdfPaperToView && (
          <motion.div 
            ref={selectedPaperDialogRef}
            className="explorer-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={isEnglish ? 'Publication details' : 'Detalles de la publicación'}
            tabIndex={-1}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.2, ease: 'easeOut' }}
          >
            <motion.div
              className="explorer-overlay-surface"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 26, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.99 }}
              transition={prefersReducedMotion
                ? { duration: 0.1 }
                : { type: 'spring', damping: 30, stiffness: 330, mass: 0.72 }}
            >
              <button
                data-dialog-initial-focus
                className="explorer-overlay-close"
                onClick={closeSelectedPaper}
                aria-label={isEnglish ? 'Close publication' : 'Cerrar publicación'}
                title={isEnglish ? 'Back' : 'Volver'}
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
          </motion.div>
        )}
      </AnimatePresence>

      {pdfPaperToView && (
        <PDFViewer paper={pdfPaperToView} onClose={() => setPdfPaperToView(null)} />
      )}
    </div>
  );
}
