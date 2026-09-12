import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { LogIn, Sparkles } from 'lucide-react';
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

export default function GuestFeedPage({
  onAuthRequired,
  onOpenPdf,
  onOpenComments = null,
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

  // The first ask, the moment the page is up — not once the feed has loaded,
  // and with no beat before it: a visitor who has just arrived is choosing
  // what to read, and the cards can fill in behind the sheet. Not while the
  // sign-in door is open — a guest who went straight for "Sign in" is about
  // to answer this in the onboarding anyway.
  // Adjusted during render rather than in an effect so the sheet is in the
  // first paint, not one commit behind it. Once per visit: "Not now" closes
  // it, and `askedOnce` keeps this from asking again on the next render.
  const [askedOnce, setAskedOnce] = useState(false);
  if (firstAsk && !askedOnce && !interestsPromptSuspended) {
    setAskedOnce(true);
    setInterestsOpen(true);
  }

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
            // The one action a visitor can complete without an account: the
            // papers are ours, in state, so Skip drops the card here instead
            // of asking for a sign-up the reader did not come for.
            onNotInterested: guestFeed.dismissPaper,
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
