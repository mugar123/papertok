import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, Home, RotateCw } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useFeed } from '../../context/FeedContext.jsx';
import { usePublicPageMetadata } from '../../hooks/usePublicPageMetadata.js';
import { fetchPapersByIds } from '../../services/arxivService.js';
import {
  enrichPapersBatch,
  fetchPaperByArxivIdViaOpenAlex,
  fetchPaperByWorkId,
  fetchPapersByDois,
} from '../../services/openAlexService.js';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
} from '../../utils/feedEnrichment.js';
import {
  encodePaperKey,
  getPublicPaperPath,
  parsePaperKey,
} from '../../utils/publicNavigation.js';
import { paperLegacyAdapter } from '../../models/Paper.js';
import { seedPaintsWhole } from '../../utils/paperSeed.js';
import PaperCard from '../Feed/PaperCard.jsx';
import SkeletonCard from '../Feed/SkeletonCard.jsx';
import { Button } from '../ui/button.jsx';
import CommentsSheet from '../Comments/CommentsSheet.jsx';
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

  // Papers the feed keys by provider id — an OpenAlex work, a PubMed record —
  // and remembered that way in Liked and Saved. OpenAlex resolves both ids
  // directly, abstract included; a failure here rejects so the page can
  // offer a retry rather than declare the paper missing.
  if (identity.type === 'openalex' || identity.type === 'pmid') {
    return fetchPaperByWorkId(identity.type, identity.value);
  }

  let paper = null;
  try {
    const papers = await fetchPapersByIds([identity.value]);
    paper = papers[0] || null;
  } catch (error) {
    console.warn('arXiv refused the paper, falling back to OpenAlex', error);
  }

  if (!paper) {
    // arXiv rate-limits by IP in bursts (a 429 ban that lasts minutes), and it
    // must not decide whether this page works: OpenAlex indexes the same
    // preprints, abstract included. The PDF link is derived from the arXiv id
    // we were asked for, since OpenAlex only sometimes carries one.
    const fallback = await fetchPaperByArxivIdViaOpenAlex(identity.value);
    if (!fallback) return null;
    return {
      ...fallback,
      pdfUrl: fallback.pdfUrl || `https://arxiv.org/pdf/${identity.value.replace(/v\d+$/i, '')}`,
    };
  }

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
  const location = useLocation();
  const { language } = useLanguage();
  const {
    likedPaperIds,
    savedPaperIds,
    readPaperIds,
    toggleLike,
    markNotInterested,
    markAsRead,
    unmarkAsRead,
    trackViewTime,
    trackSkip,
    trackPdfOpened,
  } = useFeed();
  const [result, setResult] = useState({ requestKey: '', paper: null, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const requestIdRef = useRef(0);
  const identity = useMemo(() => parsePaperKey(paperKey), [paperKey]);

  // A paper handed over by an in-app link (profile tabs, lists) renders
  // immediately, and the network load below becomes an upgrade instead of a
  // gate. This is what keeps the page alive when arXiv rate-limits: a paper
  // the app already holds must never turn into "could not be loaded".
  // The key check pins the seed to this URL, so stale navigation state can
  // never dress one paper up as another.
  const seededPaper = useMemo(() => {
    const candidate = location.state?.paper;
    if (!candidate || typeof candidate !== 'object') return null;
    try {
      const adapted = paperLegacyAdapter(candidate);
      return encodePaperKey(adapted) === paperKey ? adapted : null;
    } catch {
      return null;
    }
  }, [location.state, paperKey]);

  // A copy that carries its abstract is the page until the network upgrades
  // it — when it is the paper itself, as the search palette hands over. A
  // copy a list or a profile row stored (`state.stored`) is not painted even
  // with an abstract in it: it is a truncated summary and a handful of fields,
  // and painting it meant the card filling in piece by piece as the providers
  // answered. Those open on the skeleton, the way Liked rows always did, and
  // keep the copy only for the failure paths below.
  const seedPainted = seedPaintsWhole(seededPaper) && !location.state?.stored;
  const requestKey = `${paperKey}:${attempt}`;
  const hasCurrentResult = result.requestKey === requestKey;
  const paper = hasCurrentResult ? result.paper : (seedPainted ? seededPaper : null);
  const status = hasCurrentResult
    ? result.status
    : (seedPainted ? 'ready' : (identity ? 'loading' : 'not-found'));
  const isEnglish = language === 'en';
  const text = useCallback((entry) => entry[isEnglish ? 'en' : 'es'], [isEnglish]);

  // The card arrives in up to two beats: the copy handed over by the link,
  // then the full paper once the providers answer. Declared as variants rather
  // than driven by imperative controls — controls have to be bound to a
  // mounted element before `start()` does anything, and a start that misses
  // its binding leaves the card sitting at `initial`, which is invisible.
  const prefersReducedMotion = useReducedMotion();
  // Purely derived: a seed was on screen and the network has now answered, so
  // this render is the upgrade. Without a seed the card is simply entering.
  const cardPhase = hasCurrentResult && seedPainted ? 'dissolve' : 'shown';

  const cardVariants = useMemo(() => ({
    hidden: { opacity: 0, y: prefersReducedMotion ? 0 : 10 },
    shown: {
      opacity: 1,
      y: 0,
      transition: { duration: prefersReducedMotion ? 0.12 : 0.4, ease: [0.16, 1, 0.3, 1] },
    },
    // The seed becoming the full paper: a dissolve, so the abstract and the
    // rest do not pop in. Opacity only — a transform here would become the
    // containing block for the card's own fixed-position sheets.
    dissolve: {
      opacity: prefersReducedMotion ? 1 : [0.5, 1],
      y: 0,
      transition: { duration: prefersReducedMotion ? 0.12 : 0.55, ease: [0.22, 1, 0.36, 1] },
    },
  }), [prefersReducedMotion]);

  // The skeleton stays on top until the card has actually animated in, so the
  // reveal can never show through as an empty screen — whatever the card
  // itself is doing while it warms up.
  // No reset needed per paper: <Routes> is keyed by pathname, so a different
  // paper remounts this page outright.
  const [cardRevealed, setCardRevealed] = useState(false);
  // A paper handed over in router state — from the search palette, a list, a
  // profile tab — is painted on the very first frame, so there is no wait for
  // the cover to bridge. Without this it went up anyway and sat over a finished
  // page until the card's own animation reported in: a skeleton on top of the
  // paper it was standing in for.
  const [seededOnArrival] = useState(() => seedPainted);
  useEffect(() => {
    if (status !== 'ready' || cardRevealed) return undefined;
    // Belt and braces: if the animation's completion callback never lands,
    // the cover still lifts rather than hiding the paper for good.
    const timer = setTimeout(() => setCardRevealed(true), 1200);
    return () => clearTimeout(timer);
  }, [status, cardRevealed]);

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
          // With a seeded copy on screen, an empty provider response reads as
          // a hiccup, not as proof the paper stopped existing.
          setResult({ requestKey, paper: seededPaper, status: seededPaper ? 'ready' : 'not-found' });
          return;
        }
        setResult({ requestKey, paper: loadedPaper, status: 'ready' });
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Public paper could not be loaded', error);
        setResult({ requestKey, paper: seededPaper, status: seededPaper ? 'ready' : 'error' });
      });

    return () => {
      requestIdRef.current += 1;
    };
  }, [identity, requestKey, seededPaper]);

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
      {isAuthenticated ? (
        // Signed in, the app navbar owns the top of the screen (App.jsx keeps
        // it mounted on this route), so the page adds only a way back. The
        // standalone chrome below is for shared links opened without session.
        <Button
          variant="outline"
          size="icon"
          className="public-paper-back-floating"
          onClick={goBack}
          aria-label={text(COPY.back)}
          title={text(COPY.back)}
        >
          <ArrowLeft size={20} />
        </Button>
      ) : (
        <nav className="public-paper-nav" aria-label={isEnglish ? 'Paper navigation' : 'Navegación del paper'}>
          <button type="button" className="public-paper-nav-button" onClick={goBack} aria-label={text(COPY.back)} title={text(COPY.back)}>
            <ArrowLeft size={20} />
          </button>
          <div className="public-paper-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
          <button type="button" className="public-paper-nav-button" onClick={() => navigate('/')} aria-label={text(COPY.home)} title={text(COPY.home)}>
            <Home size={19} />
          </button>
        </nav>
      )}

      {/* The feed's own skeleton, in the shape of the card that is coming. It
          sits on top and lifts only once the card has animated in, so the gap
          between arriving here and the card being painted is never an empty
          black screen — whether the wait is the network or the card warming
          up. */}
      <AnimatePresence>
        {!seededOnArrival && (status === 'loading' || (status === 'ready' && !cardRevealed)) && (
          <motion.div
            key="paper-skeleton"
            className="public-paper-skeleton"
            role="status"
            aria-busy="true"
            aria-label={text(COPY.loading)}
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.3, ease: 'easeOut' }}
          >
            <SkeletonCard />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {commentsOpen && paper && (
          <CommentsSheet
            paper={paper}
            isAuthenticated={isAuthenticated}
            isEnglish={isEnglish}
            onClose={() => setCommentsOpen(false)}
            onAuthRequired={onAuthRequired}
          />
        )}
      </AnimatePresence>

      {status === 'ready' && paper ? (
        <motion.section
          className="public-paper-card"
          aria-label={paper.title}
          variants={cardVariants}
          initial="hidden"
          animate={cardPhase}
          onAnimationComplete={() => setCardRevealed(true)}
        >
          <PaperCard
            paper={paper}
            isLiked={isAuthenticated && likedPaperIds.has(paper.id)}
            isSaved={isAuthenticated && savedPaperIds.has(paper.id)}
            isRead={isAuthenticated && readPaperIds.has(paper.id)}
            onLike={toggleLike}
            onNotInterested={markNotInterested}
            onMarkAsRead={markAsRead}
            onUnmarkAsRead={unmarkAsRead}
            trackViewTime={trackViewTime}
            trackSkip={trackSkip}
            getInteractionState={getInteractionState}
            onAuthRequired={onAuthRequired}
            onOpenPdf={handleOpenPdf}
            onSaveToList={onSaveToList}
            // The card's own rail button — the same door the feed shows.
            // The sheet stays hosted by this page, which already had it.
            onOpenComments={() => setCommentsOpen(true)}
            publicMode={!isAuthenticated}
            analyticsSurface="other"
            hideScrollHint
          />
        </motion.section>
      ) : status === 'loading' ? null : (
        <section className="public-paper-state" aria-live="polite">
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
        </section>
      )}
    </main>
  );
}
