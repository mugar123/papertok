import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Home, LoaderCircle, RotateCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useFeed } from '../../context/FeedContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import { fetchPapersByIds } from '../../services/arxivService.js';
import {
  enrichPapersBatch,
  fetchPapersByDois,
} from '../../services/openAlexService.js';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
} from '../../utils/feedEnrichment.js';
import {
  getPublicPaperPath,
  parsePaperKey,
} from '../../utils/publicNavigation.js';
import PaperCard from '../Feed/PaperCard.jsx';
import './PublicPaperPage.css';

const COPY = {
  loading: {
    es: 'Cargando paper...',
    en: 'Loading paper...',
  },
  notFoundTitle: {
    es: 'No encontramos este paper',
    en: 'We could not find this paper',
  },
  notFoundDescription: {
    es: 'Puede que el enlace ya no esté disponible o no sea válido.',
    en: 'The link may no longer be available or may not be valid.',
  },
  errorTitle: {
    es: 'No se pudo cargar el paper',
    en: 'The paper could not be loaded',
  },
  errorDescription: {
    es: 'Revisa tu conexión y vuelve a intentarlo.',
    en: 'Check your connection and try again.',
  },
  retry: {
    es: 'Reintentar',
    en: 'Retry',
  },
  back: {
    es: 'Volver',
    en: 'Back',
  },
  home: {
    es: 'Inicio',
    en: 'Home',
  },
};

async function loadPaper(identity) {
  if (identity.type === 'doi') {
    const papers = await fetchPapersByDois([identity.value], { throwOnProviderError: true });
    return papers[0] || null;
  }

  const papers = await fetchPapersByIds([identity.value]);
  const paper = papers[0] || null;
  if (!paper) return null;

  try {
    const enrichmentId = getOpenAlexEnrichmentId(paper) || identity.value.replace(/v\d+$/i, '');
    const enrichment = await enrichPapersBatch([enrichmentId], { timeoutMs: 6_500 });
    return mergeOpenAlexEnrichment([paper], enrichment)[0];
  } catch (error) {
    console.warn('Public paper OpenAlex enrichment failed', error);
    return paper;
  }
}

export default function PublicPaperPage({
  onAuthRequired,
  onOpenPdf,
  onSaveToList,
  isAuthenticated = false,
}) {
  const { paperKey = '' } = useParams();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const {
    likedPaperIds,
    savedPaperIds,
    readPaperIds,
    toggleLike,
    markNotInterested,
    markAsRead,
    trackViewTime,
    trackSkip,
    trackPdfOpened,
  } = useFeed();
  const [result, setResult] = useState({ requestKey: '', paper: null, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const requestIdRef = useRef(0);
  const identity = useMemo(() => parsePaperKey(paperKey), [paperKey]);
  const requestKey = `${paperKey}:${attempt}`;
  const hasCurrentResult = result.requestKey === requestKey;
  const paper = hasCurrentResult ? result.paper : null;
  const status = hasCurrentResult ? result.status : (identity ? 'loading' : 'not-found');
  const isEnglish = language === 'en';
  const text = useCallback((entry) => entry[isEnglish ? 'en' : 'es'], [isEnglish]);

  const canonicalRoute = identity
    ? getPublicPaperPath(identity.type, identity.value)
    : `/public/paper/${encodeURIComponent(paperKey)}`;
  const metadata = useMemo(() => {
    if (!paper) return { route: canonicalRoute, noIndex: true };
    return {
      title: { es: paper.title, en: paper.title },
      description: { es: paper.abstract, en: paper.abstract },
      route: canonicalRoute,
      ogType: 'article',
    };
  }, [canonicalRoute, paper]);
  usePublicPageMetadata(metadata);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!identity) return undefined;

    loadPaper(identity)
      .then((loadedPaper) => {
        if (requestId !== requestIdRef.current) return;
        if (!loadedPaper) {
          setResult({ requestKey, paper: null, status: 'not-found' });
          return;
        }
        setResult({ requestKey, paper: loadedPaper, status: 'ready' });
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Public paper could not be loaded', error);
        setResult({ requestKey, paper: null, status: 'error' });
      });

    return () => {
      requestIdRef.current += 1;
    };
  }, [identity, requestKey]);

  const goBack = useCallback(() => {
    const historyIndex = typeof window !== 'undefined' ? window.history.state?.idx : null;
    if (Number.isInteger(historyIndex) && historyIndex > 0) navigate(-1);
    else navigate('/');
  }, [navigate]);

  const retry = useCallback(() => setAttempt(current => current + 1), []);
  const getInteractionState = useCallback(candidate => ({
    isLiked: likedPaperIds.has(candidate.id),
    isSaved: savedPaperIds.has(candidate.id),
    isRead: readPaperIds.has(candidate.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);
  const handleOpenPdf = useCallback(candidate => {
    if (isAuthenticated) trackPdfOpened(candidate);
    onOpenPdf?.(candidate);
  }, [isAuthenticated, onOpenPdf, trackPdfOpened]);

  return (
    <main className="public-paper-page">
      <nav className="public-paper-nav" aria-label={isEnglish ? 'Paper navigation' : 'Navegación del paper'}>
        <button type="button" className="public-paper-nav-button" onClick={goBack} aria-label={text(COPY.back)} title={text(COPY.back)}>
          <ArrowLeft size={20} />
        </button>
        <div className="public-paper-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
        <button type="button" className="public-paper-nav-button" onClick={() => navigate('/')} aria-label={text(COPY.home)} title={text(COPY.home)}>
          <Home size={19} />
        </button>
      </nav>

      {status === 'ready' && paper ? (
        <section className="public-paper-card" aria-label={paper.title}>
          <PaperCard
            paper={paper}
            isLiked={isAuthenticated && likedPaperIds.has(paper.id)}
            isSaved={isAuthenticated && savedPaperIds.has(paper.id)}
            isRead={isAuthenticated && readPaperIds.has(paper.id)}
            onLike={toggleLike}
            onNotInterested={markNotInterested}
            onMarkAsRead={markAsRead}
            trackViewTime={trackViewTime}
            trackSkip={trackSkip}
            getInteractionState={getInteractionState}
            onAuthRequired={onAuthRequired}
            onOpenPdf={handleOpenPdf}
            onSaveToList={onSaveToList}
            publicMode={!isAuthenticated}
            analyticsSurface="other"
            hideScrollHint
          />
        </section>
      ) : (
        <section className="public-paper-state" aria-live="polite">
          {status === 'loading' ? (
            <>
              <LoaderCircle className="public-paper-spinner" size={30} aria-hidden="true" />
              <p>{text(COPY.loading)}</p>
            </>
          ) : (
            <>
              <h1>{text(status === 'not-found' ? COPY.notFoundTitle : COPY.errorTitle)}</h1>
              <p>{text(status === 'not-found' ? COPY.notFoundDescription : COPY.errorDescription)}</p>
              <div className="public-paper-state-actions">
                <button type="button" className="public-paper-primary-action" onClick={retry}>
                  <RotateCw size={17} /> {text(COPY.retry)}
                </button>
                <button type="button" className="public-paper-secondary-action" onClick={goBack}>
                  <ArrowLeft size={17} /> {text(COPY.back)}
                </button>
                <button type="button" className="public-paper-secondary-action" onClick={() => navigate('/')}>
                  <Home size={17} /> {text(COPY.home)}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
