import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { LogIn, Search, Sparkles } from 'lucide-react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useGuestFeed } from '../../hooks/useGuestFeed.js';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.js';
import {
  dismissGuestInterests,
  readGuestInterests,
  saveGuestInterests,
} from '../../utils/guestInterests.js';
import FeedContainer from '../Feed/FeedContainer.jsx';
import ThemeToggle from '../Layout/ThemeToggle.jsx';
import GuestEndCard from './GuestEndCard.jsx';
import GuestInterestsPrompt from './GuestInterestsPrompt.jsx';
import './GuestFeedPage.css';

const NO_AREAS = Object.freeze([]);
// The prompt waits for the first card to be on screen, and then a beat more:
// the feed's own arrival (the atom veil lifting, the card composing) has to
// finish before anything else asks for the eye.
const INTERESTS_PROMPT_DELAY_MS = 900;

export default function GuestFeedPage({
  onReady,
  onAuthRequired,
  onOpenPdf,
  onOpenComments = null,
  onInterestsPromptChange = null,
  interestsPromptSuspended = false,
}) {
  const { isEnglish, language, setLanguage } = useLanguage();
  const { consent, trackEvent } = useAnalyticsConsent();
  // `null` until this device has answered the interests prompt one way or
  // the other; the prompt opens by itself only in that state. Afterwards the
  // header chip is the way back into it.
  const [interests, setInterests] = useState(() => readGuestInterests());
  const areas = interests?.areas?.length ? interests.areas : NO_AREAS;
  const guestFeed = useGuestFeed({ areas });
  const [interestsOpen, setInterestsOpen] = useState(false);
  const trackedDemoRef = useRef(false);
  const firstAsk = interests === null;
  const feedReady = guestFeed.papers.length > 0 && !guestFeed.loading && !guestFeed.isRefreshing;

  useEffect(() => {
    onReady?.(feedReady);
    return () => onReady?.(false);
  }, [feedReady, onReady]);

  useEffect(() => {
    onInterestsPromptChange?.(interestsOpen);
    return () => onInterestsPromptChange?.(false);
  }, [interestsOpen, onInterestsPromptChange]);

  // The first ask. Not while the sign-in door is open — a guest who went
  // straight for "Sign in" is about to answer this in the onboarding anyway.
  useEffect(() => {
    if (!firstAsk || interestsOpen || interestsPromptSuspended || !feedReady) return undefined;
    const timer = window.setTimeout(() => setInterestsOpen(true), INTERESTS_PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [feedReady, firstAsk, interestsOpen, interestsPromptSuspended]);

  useEffect(() => {
    if (
      guestFeed.loading
      || guestFeed.papers.length === 0
      || consent !== ANALYTICS_CONSENT.GRANTED
      || trackedDemoRef.current
    ) return undefined;

    let active = true;
    trackEvent('guest_demo_start', { entry_point: 'home', language }).then(tracked => {
      if (active && tracked) trackedDemoRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [consent, guestFeed.loading, guestFeed.papers.length, language, trackEvent]);

  const requestAccount = useCallback((action = 'other') => {
    const contentType = action === 'list' ? 'list' : action === 'other' ? 'other' : 'paper';
    trackEvent('select_content', { content_type: contentType, surface: 'feed' });
    onAuthRequired?.();
  }, [onAuthRequired, trackEvent]);

  const submitInterests = useCallback((nextAreas) => {
    const stored = saveGuestInterests(nextAreas);
    setInterests({ areas: stored, dismissed: stored.length === 0 });
    setInterestsOpen(false);
    trackEvent('guest_interests', {
      action: stored.length > 0 ? 'set' : 'clear',
      areas: stored.length,
      language,
    });
  }, [language, trackEvent]);

  const dismissInterests = useCallback(() => {
    setInterestsOpen(false);
    if (!firstAsk) return;
    // "Not now" is remembered: the prompt asked once and does not ask
    // again on this device. The chip in the header stays.
    dismissGuestInterests();
    setInterests({ areas: [], dismissed: true });
    trackEvent('guest_interests', { action: 'skip', areas: 0, language });
  }, [firstAsk, language, trackEvent]);

  const interestsChipLabel = areas.length > 0
    ? `${areas.length} ${isEnglish ? (areas.length === 1 ? 'area' : 'areas') : (areas.length === 1 ? 'área' : 'áreas')}`
    : (isEnglish ? 'Interests' : 'Intereses');
  const interestsChipName = areas.length > 0
    ? (isEnglish ? `Your interests: ${areas.length} ${areas.length === 1 ? 'area' : 'areas'}. Change them` : `Tus intereses: ${areas.length} ${areas.length === 1 ? 'área' : 'áreas'}. Cambiarlos`)
    : (isEnglish ? 'Choose your interests' : 'Elegir tus intereses');

  return (
    <>
      <main className="guest-feed-page">
        <header className="guest-feed-header" aria-label={isEnglish ? 'PaperTok guest navigation' : 'Navegación de invitado de PaperTok'}>
          <div className="guest-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
          <div className="guest-header-actions">
            <button type="button" className="guest-language-button" onClick={() => setLanguage(isEnglish ? 'es' : 'en')}>
              {isEnglish ? 'ES' : 'EN'}
            </button>
            {/* A visitor gets the system's answer by default and can still
                overrule it here: the bar that carries this control for a session
                is not rendered for them. */}
            <ThemeToggle className="guest-header-button" />
            <button
              type="button"
              className={`guest-interests-button ${areas.length > 0 ? 'is-set' : ''}`}
              onClick={() => setInterestsOpen(true)}
              aria-label={interestsChipName}
              aria-haspopup="dialog"
              aria-expanded={interestsOpen}
              title={interestsChipName}
            >
              <Sparkles size={15} aria-hidden="true" />
              <span className="guest-interests-label">{interestsChipLabel}</span>
            </button>
            <button type="button" className="guest-header-button" onClick={() => requestAccount('other')} aria-label={isEnglish ? 'Search' : 'Buscar'}>
              <Search size={17} />
            </button>
            <button type="button" className="guest-sign-in-button" onClick={() => requestAccount('other')}>
              <LogIn size={15} /> {isEnglish ? 'Sign in' : 'Entrar'}
            </button>
          </div>
        </header>

        <FeedContainer
          source={{
            ...guestFeed,
            publicMode: true,
            onAuthRequired: requestAccount,
            // One more snap item after the last paper. `requestAccount` is the
            // same door the header uses: it opens the AuthPrompt modal in place
            // instead of routing to /login, which would take the guest away from
            // the feed they were reading.
            endCard: (
              <GuestEndCard
                paperCount={guestFeed.papers.length}
                position={guestFeed.papers.length + 1}
                onSignUp={() => requestAccount('other')}
              />
            ),
          }}
          scrollKey="guest"
          onOpenPdf={onOpenPdf}
          onSaveToList={() => requestAccount('list')}
          onOpenComments={onOpenComments}
        />
      </main>

      {/* Outside <main>: a dialog is not page content, and the landmark test
          keeps the guest route to exactly one main region. */}
      <AnimatePresence>
        {interestsOpen && (
          <GuestInterestsPrompt
            key="guest-interests"
            initialAreas={areas}
            firstAsk={firstAsk}
            onSubmit={submitInterests}
            onDismiss={dismissInterests}
          />
        )}
      </AnimatePresence>
    </>
  );
}
