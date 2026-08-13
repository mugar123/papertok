import { Children, useState, useEffect, useRef, useCallback } from 'react';
import {
  Search,
  FileText,
  Users,
  ArrowLeft,
  Building2,
  Lightbulb,
  Briefcase,
  Sparkles,
  Compass,
  TrendingUp,
  Check,
  Plus,
  LoaderCircle,
  AlertCircle,
  RotateCw,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  searchAuthors,
  searchInstitutions,
  searchConcepts,
  searchLocalTopics,
  enrichAuthorInstitutionLocalization,
} from '../../services/openAlexService';
import { searchProjects } from '../../services/openAireService';
import { OpenAlexAdapter } from '../../services/adapters/OpenAlexAdapter';
import { PaperBuilder } from '../../services/PaperBuilder';
import { useFollowing } from '../../context/FollowingContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import PaperCard from '../Feed/PaperCard';
import PDFViewer from '../PDF/PDFViewer';
import ScientificText from '../ScientificText';
import { getLocalizedInstitutionName } from '../../utils/institutionLocalization';
import {
  filterRelevantSearchResults,
  getSearchSectionOrder,
  resolvePreferredSearchSection,
} from '../../utils/searchRelevance';
import { useDialogFocus } from '../../hooks/useDialogFocus.js';

import './SearchPage.css';

const paperSearchAdapter = new OpenAlexAdapter();
const SEARCH_DEBOUNCE_MS = 320;
const SEARCH_TIMEOUT_MS = 6000;
const SEARCH_MIN_LOADING_MS = 180;
const SEARCH_INITIAL_REVEAL_MS = 520;

const SEARCH_FILTER_OPTIONS = [
  { id: 'all', labelEs: 'Todo', labelEn: 'All', Icon: Search },
  { id: 'papers', labelEs: 'Papers', labelEn: 'Papers', Icon: FileText },
  { id: 'institutions', labelEs: 'Instituciones', labelEn: 'Institutions', Icon: Building2 },
  { id: 'authors', labelEs: 'Autores', labelEn: 'Authors', Icon: Users },
  { id: 'projects', labelEs: 'Proyectos', labelEn: 'Projects', Icon: Briefcase },
  { id: 'topics', labelEs: 'Temas', labelEn: 'Topics', Icon: Lightbulb },
];

const wait = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs));

function settleSearch(promise, fallback = [], timeoutMs = SEARCH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve({ value, status });
    };
    const timeoutId = setTimeout(() => finish(fallback, 'timeout'), timeoutMs);
    Promise.resolve(promise)
      .then(value => finish(value, 'fulfilled'))
      .catch(() => finish(fallback, 'rejected'));
  });
}

function handleSearchItemKeyDown(event, action) {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
}

function OrderedSearchSections({ children, preferredSection }) {
  return Children.toArray(children).sort((left, right) => (
    getSearchSectionOrder(left.props['data-section'], preferredSection)
    - getSearchSectionOrder(right.props['data-section'], preferredSection)
  ));
}

function FollowButton({ entity, isFollowing, isPending, onToggle }) {
  const { isEnglish } = useLanguage();
  const following = isFollowing(entity);
  const pending = isPending(entity);
  const label = following
    ? (isEnglish ? 'Following' : 'Siguiendo')
    : (isEnglish ? 'Follow' : 'Seguir');

  return (
    <button
      className={`search-follow-btn ${following ? 'following' : ''} ${pending ? 'is-pending' : ''}`}
      onClick={(event) => onToggle(event, entity)}
      disabled={pending}
      aria-pressed={following}
      aria-label={label}
      title={label}
    >
      {following
        ? <Check size={14} aria-hidden="true" />
        : <Plus size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}

function formatPaperDate(paper, locale) {
  const dateValue = paper.published || paper.publishedDate;
  if (dateValue) {
    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) return date.toLocaleDateString(locale);
  }
  return paper.year ? String(paper.year) : null;
}

export default function SearchPage({ onSaveToList = () => {} }) {
  const navigate = useNavigate();
  const prefersReducedMotion = useReducedMotion();
  const { language, isEnglish, locale } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const {
    likedPaperIds, savedPaperIds, readPaperIds,
    toggleLike, markNotInterested, markAsRead, trackViewTime, trackSkip,
  } = useFeed();
  
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchIntent, setSearchIntent] = useState(null);
  const [activeSearchFilter, setActiveSearchFilter] = useState('all');
  const [searchIssue, setSearchIssue] = useState(null);
  
  const [paperResults, setPaperResults] = useState([]);
  const [authorResults, setAuthorResults] = useState([]);
  const [institutionResults, setInstitutionResults] = useState([]);
  const [conceptResults, setConceptResults] = useState([]);
  const [projectResults, setProjectResults] = useState([]);
  
  const [selectedPaper, setSelectedPaper] = useState(null);
  const [pdfPaper, setPdfPaper] = useState(null);
  const closeSelectedPaper = useCallback(() => setSelectedPaper(null), []);
  const selectedPaperDialogRef = useDialogFocus(Boolean(selectedPaper && !pdfPaper), closeSelectedPaper);
  
  const timeoutRef = useRef(null);
  const requestAbortRef = useRef(null);
  const searchIdRef = useRef(0);
  const getInteractionState = useCallback((paper) => ({
    isLiked: likedPaperIds.has(paper.id),
    isSaved: savedPaperIds.has(paper.id),
    isRead: readPaperIds.has(paper.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);
  const clearResults = useCallback(() => {
    setPaperResults([]);
    setAuthorResults([]);
    setInstitutionResults([]);
    setConceptResults([]);
    setProjectResults([]);
  }, []);

  const performSearch = useCallback(async (searchTerm) => {
    const searchStartedAt = Date.now();
    const searchId = ++searchIdRef.current;
    requestAbortRef.current?.abort();
    const requestController = new AbortController();
    requestAbortRef.current = requestController;
    const localTopics = searchLocalTopics(searchTerm, language, 8);

    setIsSearching(true);
    setHasSearched(true);
    setSearchIssue(null);

    const sectionSetters = {
      papers: setPaperResults,
      authors: setAuthorResults,
      institutions: setInstitutionResults,
      topics: setConceptResults,
      projects: setProjectResults,
    };
    const resolvedOutcomes = new Map();
    let initialResultsRevealed = false;
    const isCurrentSearch = () => (
      searchId === searchIdRef.current && !requestController.signal.aborted
    );
    const track = (section, promise) => promise.then((outcome) => {
      const trackedOutcome = { ...outcome, section };
      resolvedOutcomes.set(section, trackedOutcome);
      if (initialResultsRevealed && isCurrentSearch()) {
        sectionSetters[section](outcome.value);
      }
      return trackedOutcome;
    });

    const tasks = [
      track('papers', settleSearch(
        paperSearchAdapter.search(searchTerm, 1, { signal: requestController.signal })
          .then(result => PaperBuilder.deduplicate(result.papers || []).slice(0, 10)),
      )),
      track('authors', settleSearch(
        searchAuthors(searchTerm, {
          signal: requestController.signal,
          throwOnError: true,
        }).then(results => filterRelevantSearchResults(
          searchTerm,
          results,
          author => [author.display_name],
        )).then(results => Promise.all(
          results.map(author => enrichAuthorInstitutionLocalization(author, { timeoutMs: 1500 })),
        )),
        [],
        5000,
      )),
      track('institutions', settleSearch(
        searchInstitutions(searchTerm, {
          signal: requestController.signal,
          throwOnError: true,
        }),
        [],
        4500,
      )),
      track('topics', settleSearch(
        searchConcepts(searchTerm, {
          language,
          limit: 8,
          signal: requestController.signal,
        }),
        localTopics,
        4500,
      )),
      track('projects', settleSearch(
        searchProjects(searchTerm, 1, {
          signal: requestController.signal,
          throwOnError: true,
        })
          .then(result => filterRelevantSearchResults(
            searchTerm,
            result.projects || [],
            project => [project.acronym, project.title, project.funder],
          )),
      )),
    ];

    const allOutcomesPromise = Promise.all(tasks);
    await Promise.race([allOutcomesPromise, wait(SEARCH_INITIAL_REVEAL_MS)]);
    const remainingMinimumDelay = Math.max(
      0,
      SEARCH_MIN_LOADING_MS - (Date.now() - searchStartedAt),
    );
    if (remainingMinimumDelay > 0) await wait(remainingMinimumDelay);

    if (!isCurrentSearch()) return;
    resolvedOutcomes.forEach(outcome => {
      sectionSetters[outcome.section](outcome.value);
    });
    initialResultsRevealed = true;

    const outcomes = await allOutcomesPromise;
    if (isCurrentSearch()) {
      const resultCount = outcomes.reduce(
        (total, outcome) => total + (Array.isArray(outcome.value) ? outcome.value.length : 0),
        0,
      );
      trackEvent('search_performed', {
        search_type: 'all',
        result_count: resultCount,
        has_results: resultCount > 0,
      });
      const unavailableSections = outcomes
        .filter(outcome => outcome.status !== 'fulfilled')
        .map(outcome => outcome.section);
      setSearchIssue(unavailableSections.length > 0
        ? { unavailableSections }
        : null);
      setIsSearching(false);
      if (requestAbortRef.current === requestController) {
        requestAbortRef.current = null;
      }
    }
  }, [language, trackEvent]);

  useEffect(() => {
    if (!query.trim()) {
      requestAbortRef.current?.abort();
      searchIdRef.current += 1;
      const resetStateTimeout = setTimeout(() => {
        clearResults();
        setIsSearching(false);
        setHasSearched(false);
        setSearchIssue(null);
      }, 0);
      return () => clearTimeout(resetStateTimeout);
    }

    requestAbortRef.current?.abort();
    searchIdRef.current += 1;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    
    timeoutRef.current = setTimeout(() => {
      performSearch(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    
    return () => {
      clearTimeout(timeoutRef.current);
      requestAbortRef.current?.abort();
    };
  }, [clearResults, query, performSearch]);

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

  const hasSearchSectionResults = paperResults.length > 0
    || authorResults.length > 0
    || institutionResults.length > 0
    || conceptResults.length > 0
    || projectResults.length > 0;
  const hasResults = hasSearchSectionResults || !!cleanOrcid;
  const hasVisibleResults = activeSearchFilter === 'all'
    ? hasResults
    : activeSearchFilter === 'papers'
      ? paperResults.length > 0
      : activeSearchFilter === 'institutions'
        ? institutionResults.length > 0
        : activeSearchFilter === 'authors'
          ? authorResults.length > 0 || !!cleanOrcid
          : activeSearchFilter === 'projects'
            ? projectResults.length > 0
            : conceptResults.length > 0;
  const activeFilterOption = SEARCH_FILTER_OPTIONS.find(option => option.id === activeSearchFilter)
    || SEARCH_FILTER_OPTIONS[0];
  const preferredSection = resolvePreferredSearchSection({
    query,
    hint: searchIntent,
    sectionValues: {
      papers: paperResults.map(paper => paper.title),
      topics: conceptResults.flatMap(concept => [
        concept.display_name,
        concept.labelEs,
        concept.labelEn,
      ]),
      authors: authorResults.map(author => author.display_name),
      institutions: institutionResults.flatMap(institution => [
        institution.display_name,
        ...Object.values(institution.localized_names || {}),
        ...(institution.aliases || []),
        ...(institution.acronyms || []),
      ]),
      projects: projectResults.flatMap(project => [
        project.acronym,
        project.title,
      ]),
    },
  });
  const openAlexUnavailable = searchIssue?.unavailableSections
    ?.filter(section => ['papers', 'authors', 'topics'].includes(section))
    .length >= 2;
  const suggestedQueries = [
    {
      label: isEnglish ? 'Cosmology' : 'Cosmología',
      icon: <Lightbulb size={14} />,
      query: isEnglish ? 'Cosmology' : 'Cosmología',
      section: 'topics',
    },
    {
      label: 'MIT',
      icon: <Building2 size={14} />,
      query: 'Massachusetts Institute of Technology',
      section: 'institutions',
    },
    {
      label: 'CRISPR Cas9',
      icon: <FileText size={14} />,
      query: 'CRISPR Cas9',
      section: 'papers',
    },
    {
      label: isEnglish ? 'Horizon projects' : 'Proyectos Horizon',
      icon: <Briefcase size={14} />,
      query: 'Horizon',
      section: 'projects',
    },
    {
      label: 'Geoffrey Hinton',
      icon: <Users size={14} />,
      query: 'Geoffrey Hinton',
      section: 'authors',
    },
    {
      label: isEnglish ? 'Quantum computing' : 'Computación cuántica',
      icon: <TrendingUp size={14} />,
      query: 'Quantum computing',
      section: 'topics',
    },
  ];

  const updateQuery = (nextQuery, intent = null, filter = activeSearchFilter) => {
    requestAbortRef.current?.abort();
    clearResults();
    setQuery(nextQuery);
    setSearchIntent(intent);
    setActiveSearchFilter(filter);
    setSearchIssue(null);
    setHasSearched(false);
    setIsSearching(Boolean(nextQuery.trim()));
  };

  const handleSuggestedSearch = (suggestion) => {
    updateQuery(suggestion.query, suggestion.section, suggestion.section);
  };

  const handleSearchFilterChange = (filterId) => {
    setActiveSearchFilter(filterId);
    setSearchIntent(filterId === 'all' ? null : filterId);
  };

  const clearSearch = () => {
    updateQuery('', null, 'all');
  };

  return (
    <div className="search-page-container">
      <div className="search-header">
        <div className="search-header-main">
          <button
            type="button"
            className="search-back-btn"
            onClick={() => navigate('/')}
            aria-label={isEnglish ? 'Back' : 'Volver'}
          >
            <ArrowLeft size={22} />
          </button>
          <div className={`search-input-wrapper ${isSearching ? 'is-searching' : ''}`}>
            <Search className="search-icon" size={18} />
            <input
              type="search"
              className="search-input"
              placeholder={isEnglish ? 'Search PaperTok...' : 'Buscar en PaperTok...'}
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) clearSearch();
              }}
              autoComplete="off"
              autoFocus
            />
            {isSearching && (
              <span
                className="search-input-loader"
                role="status"
                aria-label={isEnglish ? 'Searching' : 'Buscando'}
              >
                <LoaderCircle size={17} aria-hidden="true" />
              </span>
            )}
          </div>
        </div>
        <div
          className="search-filter-bar"
          role="tablist"
          aria-label={isEnglish ? 'Filter search results' : 'Filtrar resultados de búsqueda'}
        >
          {SEARCH_FILTER_OPTIONS.map(({ id, labelEs, labelEn, Icon }) => {
            const isActive = activeSearchFilter === id;
            const label = isEnglish ? labelEn : labelEs;
            return (
              <button
                key={id}
                id={`search-filter-${id}`}
                type="button"
                className={`search-filter-pill ${isActive ? 'active' : ''}`}
                role="tab"
                aria-selected={isActive}
                aria-controls="search-results-panel"
                onClick={() => handleSearchFilterChange(id)}
                title={label}
              >
                <Icon size={15} aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="search-results custom-scrollbar">
        <div id="search-results-panel" className="search-results-list" aria-busy={isSearching}>
            {!query.trim() && !isSearching && (
              <div className="search-initial-state">
                <div className="search-initial-hero">
                  <Compass size={48} className="search-initial-icon" />
                  <h2>{isEnglish ? 'Explore knowledge' : 'Explora el conocimiento'}</h2>
                  <p>{isEnglish
                    ? 'Search papers, researchers, topics, institutions, and funded projects.'
                    : 'Busca papers, investigadores, temas, universidades y proyectos financiados.'}</p>
                </div>
                
                <div className="search-suggestions">
                  <h3 className="search-suggestions-title"><Sparkles size={16} /> {isEnglish ? 'Suggested searches' : 'Búsquedas sugeridas'}</h3>
                  <div className="search-suggestions-grid">
                    {suggestedQueries.map(item => (
                      <button
                        type="button"
                        key={item.label}
                        onClick={() => handleSuggestedSearch(item)}
                        className="search-suggestion-chip"
                      >
                        {item.icon}
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {searchIssue && !isSearching && (
              <div
                className={`search-service-state ${hasResults ? 'is-partial' : 'is-error'}`}
                role={hasResults ? 'status' : 'alert'}
              >
                <AlertCircle size={20} aria-hidden="true" />
                <div className="search-service-copy">
                  <strong>{hasResults
                    ? (openAlexUnavailable
                        ? (isEnglish ? 'OpenAlex is temporarily unavailable' : 'OpenAlex no está disponible temporalmente')
                        : (isEnglish ? 'Partial results' : 'Resultados parciales'))
                    : (isEnglish ? 'Search is temporarily unavailable' : 'La búsqueda no está disponible temporalmente')}</strong>
                  <span>{hasResults
                    ? (openAlexUnavailable
                        ? (isEnglish
                            ? 'Some papers, authors, and topics may be missing until its quota resets.'
                            : 'Pueden faltar papers, autores y temas hasta que se restablezca su cuota.')
                        : (isEnglish ? 'Some sources did not respond.' : 'Algunas fuentes no han respondido.'))
                    : (isEnglish ? 'Please try again in a moment.' : 'Vuelve a intentarlo dentro de un momento.')}</span>
                </div>
                <button
                  type="button"
                  className="search-retry-btn"
                  onClick={() => performSearch(query.trim())}
                  aria-label={isEnglish ? 'Retry search' : 'Reintentar búsqueda'}
                  title={isEnglish ? 'Retry search' : 'Reintentar búsqueda'}
                >
                  <RotateCw size={17} />
                </button>
              </div>
            )}

            {query.trim() && isSearching && !hasVisibleResults && (
              <div
                className="search-loading-state"
                role="status"
                aria-label={isEnglish ? 'Preparing search results' : 'Preparando resultados de búsqueda'}
              >
                {[0, 1, 2].map(index => (
                  <div className="search-loading-row" key={index} style={{ '--loading-row-index': index }}>
                    <span className="search-loading-icon" />
                    <span className="search-loading-copy">
                      <span className="search-loading-line search-loading-line--title" />
                      <span className="search-loading-line search-loading-line--detail" />
                    </span>
                  </div>
                ))}
              </div>
            )}

            {!hasVisibleResults && query && hasSearched && !isSearching && !searchIssue && (
              <div className="search-empty">
                <Search size={40} className="search-empty-icon" />
                <p>{hasResults && activeSearchFilter !== 'all'
                  ? (isEnglish
                    ? `No ${activeFilterOption.labelEn.toLowerCase()} found for "${query}"`
                    : `No se encontraron ${activeFilterOption.labelEs.toLowerCase()} para "${query}"`)
                  : (isEnglish ? `No results found for "${query}"` : `No se encontraron resultados para "${query}"`)}</p>
                <span>{hasResults && activeSearchFilter !== 'all'
                  ? (isEnglish ? 'Try another filter or search term' : 'Prueba otro filtro o término de búsqueda')
                  : (isEnglish ? 'Try a different search term' : 'Intenta con otros términos o busca en inglés')}</span>
              </div>
            )}

            {hasVisibleResults && (
              <div key={activeSearchFilter} className="search-filtered-results">
                {/* Direct ORCID */}
                {cleanOrcid && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
                  <div className="search-section" style={{ order: 0 }}>
                    <h3 className="search-section-title">{isEnglish ? 'Direct ORCID search' : 'Búsqueda directa ORCID'}</h3>
                    <div
                      className="search-item"
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/author/https%3A%2F%2Forcid.org%2F${cleanOrcid}`),
                      )}
                    >
                      <div className="search-item-icon" style={{ background: '#a6ce39', color: 'white' }}>
                        <Users size={22} />
                      </div>
                      <div className="search-item-info">
                        <h4 style={{ color: '#a6ce39' }}>{isEnglish ? 'View ORCID profile' : 'Ver perfil ORCID'} {cleanOrcid}</h4>
                        <p>{isEnglish
                          ? 'Explore the author and their work through a verified unique identifier'
                          : 'Explorar autor e historial mediante su identificador único verificado'}</p>
                      </div>
                    </div>
                  </div>
                )}

                <OrderedSearchSections preferredSection={preferredSection}>
            {institutionResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'institutions') && (
              <div className="search-section" data-section="institutions">
                <h3 className="search-section-title">{isEnglish ? 'Universities and institutions' : 'Universidades e instituciones'}</h3>
                {institutionResults.map((inst, index) => {
                  const localizedName = getLocalizedInstitutionName(inst, language);
                  return (
                    <div
                      key={inst.id}
                      className="search-item search-item-enter"
                      style={{ '--search-item-index': index }}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/institution/${inst.id.split('/').pop()}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/institution/${inst.id.split('/').pop()}`),
                      )}
                    >
                      <div className="search-item-icon"><Building2 size={22} /></div>
                      <div className="search-item-info">
                        <h4>{localizedName}</h4>
                        <p>{inst.country_code || (isEnglish ? 'Unknown country' : 'País desconocido')} • {isEnglish ? 'Academic institution' : 'Institución académica'}</p>
                      </div>
                      <FollowButton
                        entity={{
                          type: 'institution',
                          id: inst.id,
                          displayName: inst.display_name,
                          source: inst._metadataSource || 'ror',
                          externalIds: { ror: inst.ror || inst.id },
                          metadata: { localizedNames: inst.localized_names },
                        }}
                        isFollowing={isFollowing}
                        isPending={isFollowPending}
                        onToggle={handleToggleFollow}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {projectResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'projects') && (
              <div className="search-section" data-section="projects">
                <h3 className="search-section-title">{isEnglish ? 'Research projects' : 'Proyectos de investigación'}</h3>
                {projectResults.map((project, index) => (
                  <div
                    key={project.id}
                    className="search-item search-item-enter"
                    style={{ '--search-item-index': Math.min(index, 6) }}
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/explorer/project/${project.id}?name=${encodeURIComponent(project.acronym || project.title)}&funder=${encodeURIComponent(project.funder)}`)}
                    onKeyDown={event => handleSearchItemKeyDown(
                      event,
                      () => navigate(`/explorer/project/${project.id}?name=${encodeURIComponent(project.acronym || project.title)}&funder=${encodeURIComponent(project.funder)}`),
                    )}
                  >
                    <div className="search-item-icon"><Briefcase size={22} /></div>
                    <div className="search-item-info">
                      <h4>{project.acronym ? `${project.acronym}: ${project.title}` : project.title}</h4>
                      <p>{project.funder}{project.budget > 0 ? (() => { try { return ` • ${new Intl.NumberFormat(locale, { style: 'currency', currency: project.currency, maximumFractionDigits: 0 }).format(project.budget)}`; } catch { return ` • ${project.budget.toLocaleString(locale)} €`; } })() : ''}</p>
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

            {conceptResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'topics') && (
              <div className="search-section" data-section="topics">
                <h3 className="search-section-title">{isEnglish ? 'Topics and areas' : 'Temas y áreas'}</h3>
                {conceptResults.map((concept, index) => (
                  <div
                    key={concept.id}
                    className="search-item search-topic-item search-item-enter"
                    style={{ '--search-item-index': Math.min(index, 6) }}
                    role="link"
                    tabIndex={0}
                    onClick={() => navigate(`/explorer/topic/${encodeURIComponent(String(concept.id).split('/').pop())}`)}
                    onKeyDown={event => handleSearchItemKeyDown(
                      event,
                      () => navigate(`/explorer/topic/${encodeURIComponent(String(concept.id).split('/').pop())}`),
                    )}
                  >
                    <div className="search-item-icon search-topic-icon"><Lightbulb size={22} /></div>
                    <div className="search-item-info">
                      <h4>{concept.display_name}</h4>
                      <p>
                        {concept._localTopic && concept.level === 0
                          ? `${concept.subcategoryCount || 0} ${isEnglish ? 'related topics' : 'temas relacionados'}`
                          : concept._localTopic
                            ? `${isEnglish ? 'Topic in' : 'Tema de'} ${concept.parent_display_name || (isEnglish ? 'PaperTok taxonomy' : 'la taxonomía de PaperTok')}`
                            : [
                                concept.field_display_name || (isEnglish ? 'OpenAlex topic' : 'Tema de OpenAlex'),
                                Number.isFinite(concept.works_count)
                                  ? `${concept.works_count.toLocaleString(locale)} ${isEnglish ? 'works' : 'trabajos'}`
                                  : '',
                              ].filter(Boolean).join(' • ')}
                      </p>
                    </div>
                    <FollowButton
                      entity={{
                        type: 'topic',
                        id: concept.id,
                        displayName: concept.display_name,
                        source: concept._localTopic ? 'papertok' : 'openalex',
                        metadata: {
                          categoryIds: concept.categoryIds,
                          labelEs: concept.labelEs,
                          labelEn: concept.labelEn,
                        },
                      }}
                      isFollowing={isFollowing}
                      isPending={isFollowPending}
                      onToggle={handleToggleFollow}
                    />
                  </div>
                ))}
              </div>
            )}

            {authorResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'authors') && (
              <div className="search-section" data-section="authors">
                <h3 className="search-section-title">{isEnglish ? 'Authors' : 'Autores'}</h3>
                {authorResults.map((author, index) => {
                  const authorFollow = { type: 'author', id: author.id, displayName: author.display_name, source: 'openalex', externalIds: { orcid: author.orcid } };
                  const authorInstitution = getLocalizedInstitutionName(
                    author.institutionData || { display_name: author.institution },
                    language,
                  );
                  return (
                    <div
                      key={author.id}
                      className="search-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      role="link"
                      tabIndex={0}
                      onClick={() => navigate(`/explorer/author/${author.id.split('/').pop()}`)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => navigate(`/explorer/author/${author.id.split('/').pop()}`),
                      )}
                    >
                      <div className="search-item-avatar">
                        {author.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div className="search-item-info">
                        <h4>{author.display_name}</h4>
                        <p>{authorInstitution || (isEnglish ? 'Unknown institution' : 'Institución desconocida')}</p>
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

            {paperResults.length > 0 && (activeSearchFilter === 'all' || activeSearchFilter === 'papers') && (
              <div className="search-section" data-section="papers">
                <h3 className="search-section-title">{isEnglish ? 'Publications' : 'Publicaciones'}</h3>
                {paperResults.map((paper, index) => {
                  const authors = (paper.authors || []).map(author => author.name || author);
                  return (
                    <div
                      key={paper.id}
                      className="search-item paper-item search-item-enter"
                      style={{ '--search-item-index': Math.min(index, 6) }}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedPaper(paper)}
                      onKeyDown={event => handleSearchItemKeyDown(
                        event,
                        () => setSelectedPaper(paper),
                      )}
                    >
                      <div className="search-item-icon"><FileText size={22} /></div>
                      <div className="search-item-info">
                        <h4><ScientificText>{paper.title}</ScientificText></h4>
                        <p className="search-item-authors">{authors.slice(0, 3).join(', ')}{authors.length > 3 ? ` +${authors.length - 3}` : ''}</p>
                        <span className="search-item-meta">
                          {formatPaperDate(paper, locale) || (isEnglish ? 'Unknown date' : 'Fecha desconocida')} • {paper.primaryCategory || paper.journal || 'Paper'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
                </OrderedSearchSections>
              </div>
            )}
          </div>
      </div>

      {/* Paper Card Overlay */}
      <AnimatePresence initial={false}>
      {selectedPaper && !pdfPaper && (
        <motion.div
          ref={selectedPaperDialogRef}
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={isEnglish ? 'Paper details' : 'Detalles del paper'}
          tabIndex={-1}
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.99 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.995 }}
          transition={prefersReducedMotion
            ? { duration: 0 }
            : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
        >
          <button 
            data-dialog-initial-focus
            className="search-back-btn" 
            onClick={closeSelectedPaper}
            aria-label={isEnglish ? 'Back to search results' : 'Volver a los resultados'}
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
        </motion.div>
      )}
      </AnimatePresence>

      {/* PDF Viewer */}
      {pdfPaper && (
        <PDFViewer paper={pdfPaper} onClose={() => setPdfPaper(null)} />
      )}
    </div>
  );
}
