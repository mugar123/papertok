import type { Variants } from 'framer-motion';
import type { Paper } from '../../models/paper.ts';
import type { PaperCardProps } from '../feed/paper-card.tsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowClockwise, ArrowLeft, House } from '@phosphor-icons/react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useFeed } from '../../context/feed-context.tsx';
import useQuickSave from '../../hooks/use-quick-save.ts';
import { usePublicPageMetadata } from '../../hooks/use-public-page-metadata.ts';
import { loadPaperByIdentity } from '../../services/paper-lookup.ts';
import {
  encodePaperKey,
  getPublicPaperPath,
  parsePaperKey,
} from '../../utils/public-navigation.ts';
import { paperLegacyAdapter } from '../../models/paper.ts';
import { hydrateSeededPaper, seedPaintsWhole } from '../../utils/paper-seed.ts';
import { publicPaperMetadata, readShareSeed } from '../../utils/share-seed.ts';
import PaperCard from '../feed/paper-card.tsx';
import SkeletonCard from '../feed/skeleton-card.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import Petri from '../onboarding/petri.tsx';
import './public-paper-page.css';

const COPY = {
  loading: {
    en: 'Loading paper...',
  },
  notFoundTitle: {
    en: 'We could not find this paper',
  },
  notFoundDescription: {
    en: 'The link may no longer be available or may not be valid.',
  },
  errorTitle: {
    en: 'The paper could not be loaded',
  },
  errorDescription: {
    en: 'Check your connection and try again.',
  },
  retry: {
    en: 'Retry',
  },
  back: {
    en: 'Back',
  },
  home: {
    en: 'Home',
  },
};

export default function PublicPaperPage({
  onAuthRequired,
  onOpenPdf,
  onSaveToList,
  isAuthenticated = false,
}: Pick<PaperCardProps, 'onAuthRequired'> & {
  onOpenPdf?: (paper: Paper) => void;
  onSaveToList?: (paper: Paper) => void;
  isAuthenticated?: boolean;
}) {
  const { paperKey = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    likedPaperIds,
    savedPaperIds,
    readPaperIds,
    toggleLike,
    markNotInterested,
    markAsRead,
    unmarkAsRead,
    interactionIdFor,
    libraryCopyFor,
    ensurePersonalLibrary,
    trackViewTime,
    trackSkip,
    trackPdfOpened,
  } = useFeed();
  const handleSaveToList = useQuickSave(onSaveToList!, 'other');
  const [result, setResult] = useState<{ requestKey: string; paper: Partial<Paper> | null; status: string }>({ requestKey: '', paper: null, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const requestIdRef = useRef(0);
  const identity = useMemo(() => parsePaperKey(paperKey), [paperKey]);

  // A paper handed over by an in-app link (a list, the search palette) renders
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
  // A shared link opened by a crawler that runs JavaScript: its document came
  // from the Worker with the paper written in (utils/share-seed.ts). It is the
  // page until the providers answer, and what stays when they cannot be
  // reached — for Googlebot they cannot: api.papertok.app's robots.txt closes
  // them. A copy an in-app link handed over still comes first.
  const shareSeed = useMemo(() => {
    const candidate = readShareSeed(paperKey);
    if (!candidate) return null;
    try {
      return paperLegacyAdapter(candidate);
    } catch {
      return null;
    }
  }, [paperKey]);
  const sharePainted = !seedPainted && seedPaintsWhole(shareSeed);
  const requestKey = `${paperKey}:${attempt}`;
  const hasCurrentResult = result.requestKey === requestKey;
  const loadedPaper = hasCurrentResult ? result.paper : (seedPainted ? seededPaper : (sharePainted ? shareSeed : null));
  // A link that brought no copy of its own — a shared link, a bookmark — is
  // answered by the provider under the provider's id, and the reader's own
  // marks are keyed by the id the feed gave the paper. If the reader's
  // library holds a copy of it under any id, that copy is laid over the
  // answer exactly as a list's copy would be: their marks apply, and the
  // paper reads as it did in the feed. With no copy, the id alone is
  // resolved, so a like made here lands on the mark that already exists.
  const paper = useMemo(() => {
    if (!loadedPaper || seededPaper) return loadedPaper;
    const copy = libraryCopyFor(loadedPaper);
    if (copy) return hydrateSeededPaper(paperLegacyAdapter({ ...copy.paper, id: copy.id }), loadedPaper);
    const id = interactionIdFor(loadedPaper);
    return id === loadedPaper.id ? loadedPaper : { ...loadedPaper, id };
  }, [loadedPaper, seededPaper, libraryCopyFor, interactionIdFor]);
  // The library is what the alias table is built from; a signed-in reader
  // arriving by link has not opened a list yet, so it is asked for here.
  useEffect(() => {
    if (isAuthenticated) void ensurePersonalLibrary?.();
  }, [isAuthenticated, ensurePersonalLibrary]);
  const status = hasCurrentResult
    ? result.status
    : (seedPainted || sharePainted ? 'ready' : (identity ? 'loading' : 'not-found'));
  const text = useCallback((entry: { en: string }) => entry.en, []);

  // The card arrives in up to two beats: the copy handed over by the link,
  // then the full paper once the providers answer. Declared as variants rather
  // than driven by imperative controls — controls have to be bound to a
  // mounted element before `start()` does anything, and a start that misses
  // its binding leaves the card sitting at `initial`, which is invisible.
  const prefersReducedMotion = useReducedMotion();
  // Purely derived: a seed was on screen and the network has now answered, so
  // this render is the upgrade. Without a seed the card is simply entering.
  const cardPhase = hasCurrentResult && (seedPainted || sharePainted) ? 'dissolve' : 'shown';

  const cardVariants = useMemo<Variants>(() => ({
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
  // A paper handed over in router state — from the search palette or a list —
  // is painted on the very first frame, so there is no wait for the cover to
  // bridge. Without this it went up anyway and sat over a finished page until
  // the card's own animation reported in: a skeleton on top of the paper it
  // was standing in for.
  const [seededOnArrival] = useState(() => seedPainted || sharePainted);
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
  // Built from the paper on screen, seed included: a page painted from a seed
  // is the paper from its first render, never a noindex «loading».
  const metadata = useMemo(() => publicPaperMetadata(paper, canonicalRoute), [canonicalRoute, paper]);
  usePublicPageMetadata(metadata);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    if (!identity) return undefined;
    // What stays on screen when the providers find nothing or fail: the copy
    // an in-app link handed over, or the seed a shared link's document
    // carried. With either on screen, an empty or failed response reads as a
    // hiccup, not as proof the paper stopped existing.
    const fallback = seededPaper || shareSeed;

    loadPaperByIdentity(identity)
      .then((loadedPaper) => {
        if (requestId !== requestIdRef.current) return;
        if (!loadedPaper) {
          setResult({ requestKey, paper: fallback, status: fallback ? 'ready' : 'not-found' });
          return;
        }
        // The provider's paper, with the copy the link handed over laid on
        // top where it speaks: the id the reader's marks are keyed by, the
        // branch the feed filed it under, the authors and abstract as the
        // reader saw them. Without this the page showed another provider's
        // account of the same paper, unread and unliked.
        setResult({ requestKey, paper: hydrateSeededPaper(seededPaper, loadedPaper), status: 'ready' });
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return;
        console.error('Public paper could not be loaded', error);
        setResult({ requestKey, paper: fallback, status: fallback ? 'ready' : 'error' });
      });

    return () => {
      requestIdRef.current += 1;
    };
  }, [identity, requestKey, seededPaper, shareSeed]);

  const goBack = useCallback(() => {
    const historyIndex = typeof window !== 'undefined' ? window.history.state?.idx : null;
    if (Number.isInteger(historyIndex) && historyIndex > 0) void navigate(-1);
    else void navigate('/feed');
  }, [navigate]);

  const retry = useCallback(() => setAttempt(current => current + 1), []);
  const getInteractionState = useCallback((candidate: Paper) => ({
    isLiked: likedPaperIds.has(candidate.id),
    isSaved: savedPaperIds.has(candidate.id),
    isRead: readPaperIds.has(candidate.id),
  }), [likedPaperIds, readPaperIds, savedPaperIds]);
  const handleOpenPdf = useCallback((candidate: Paper) => {
    if (isAuthenticated) void trackPdfOpened(candidate);
    onOpenPdf?.(candidate);
  }, [isAuthenticated, onOpenPdf, trackPdfOpened]);

  return (
    <main className={`public-paper-page${isAuthenticated ? ' public-paper-page--app' : ''}`}>
      {isAuthenticated ? (
        // Signed in, the app navbar owns the top of the screen (app.tsx keeps
        // it mounted on this route), so the page adds only a way back. The
        // standalone chrome below is for shared links opened without session.
        <Button
          variant="ghost"
          size="icon"
          className="public-paper-back-floating"
          onClick={goBack}
          aria-label={text(COPY.back)}
          title={text(COPY.back)}
        >
          <ArrowLeft size={20} />
        </Button>
      ) : (
        <nav className="public-paper-nav" aria-label={'Paper navigation'}>
          <button type="button" className="public-paper-nav-button" onClick={goBack} aria-label={text(COPY.back)} title={text(COPY.back)}>
            <ArrowLeft size={20} />
          </button>
          <div className="public-paper-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
          <button type="button" className="public-paper-nav-button" onClick={() => { void navigate('/feed'); }} aria-label={text(COPY.home)} title={text(COPY.home)}>
            <House size={19} />
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
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0.1 : 0.3, ease: 'easeOut' }}
          >
            {/* Real text, not just an aria-label: an empty region whose only
                text is its own label is never announced as a status change. */}
            <span className="visually-hidden">{text(COPY.loading)}</span>
            <SkeletonCard />
          </motion.div>
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
            paper={paper as Paper}
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
            onSaveToList={handleSaveToList}
            onPickList={onSaveToList}
            publicMode={!isAuthenticated}
            analyticsSurface="other"
            hideScrollHint
            titleAs="h1"
          />
        </motion.section>
      ) : status === 'loading' ? null : (
        <EmptyState
          as="h1"
          className="public-paper-state"
          aria-live="polite"
          art={<Petri pose={status === 'not-found' ? 'blankPage' : 'upset'} />}
          title={text(status === 'not-found' ? COPY.notFoundTitle : COPY.errorTitle)}
          actions={(
            <>
              <Button onClick={retry}>
                <ArrowClockwise size={16} aria-hidden="true" /> {text(COPY.retry)}
              </Button>
              <Button variant="outline" onClick={goBack}>
                <ArrowLeft size={16} aria-hidden="true" /> {text(COPY.back)}
              </Button>
              <Button variant="outline" onClick={() => { void navigate('/feed'); }}>
                <House size={16} aria-hidden="true" /> {text(COPY.home)}
              </Button>
            </>
          )}
        >
          {text(status === 'not-found' ? COPY.notFoundDescription : COPY.errorDescription)}
        </EmptyState>
      )}
    </main>
  );
}
