import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { SignIn, Sparkle } from '@phosphor-icons/react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { useGuestFeed } from '../../hooks/useGuestFeed.js';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.js';
import {
  readGuestInterests,
  saveGuestInterests,
} from '../../utils/guestInterests.js';
import FeedContainer from '../Feed/FeedContainer.jsx';
import ThemeToggle from '../Layout/ThemeToggle.jsx';
import GuestEndCard from './GuestEndCard.jsx';
import GuestInterestsPrompt from './GuestInterestsPrompt.jsx';
import GuestWelcome from './GuestWelcome.jsx';
import './GuestFeedPage.css';

const NO_AREAS = Object.freeze([]);

export default function GuestFeedPage({
  onAuthRequired,
  onOpenPdf,
  onOpenComments = null,
}) {
  const { language } = useLanguage();
  const { consent, trackEvent } = useAnalyticsConsent();
  // `null` until this device has answered the welcome's interests step. In
  // that state the page IS the welcome (GuestWelcome): four screens on what
  // PaperTok is, what you do in it, which areas to start from and the specific
  // topics inside them, and the feed only once they are answered. Afterwards the header chip reopens the
  // areas as an editable sheet.
  const [interests, setInterests] = useState(() => readGuestInterests());
  const areas = interests?.areas?.length ? interests.areas : NO_AREAS;
  const topics = interests?.topics?.length ? interests.topics : NO_AREAS;
  const firstVisit = interests === null;
  // Not a single source is asked while the welcome is up: the feed is built
  // from its answer, so a load for the fixed sample would be thrown away.
  const guestFeed = useGuestFeed({ areas, topics, enabled: !firstVisit });
  const [interestsOpen, setInterestsOpen] = useState(false);
  const trackedDemoRef = useRef(false);

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
    // The action is also the dialog's reason: «Leer en simple» and
    // «Conexiones» open it saying what an account unlocks for them.
    onAuthRequired?.(action);
  }, [onAuthRequired, trackEvent]);

  // The welcome answers with `{ areas, topics }`; the header chip's sheet
  // changes areas only, so it keeps the topics still inside them.
  const submitInterests = useCallback((answer) => {
    const next = Array.isArray(answer) ? { areas: answer, topics: interests?.topics ?? [] } : answer;
    const stored = saveGuestInterests(next);
    setInterests(readGuestInterests() ?? { areas: stored, topics: [], dismissed: stored.length === 0 });
    setInterestsOpen(false);
    trackEvent('guest_interests', {
      action: stored.length > 0 ? 'set' : 'clear',
      areas: stored.length,
      language,
    });
  }, [interests, language, trackEvent]);

  const dismissInterests = useCallback(() => {
    setInterestsOpen(false);
  }, []);

  const interestsChipLabel = areas.length > 0
    ? `${areas.length} ${areas.length === 1 ? 'area' : 'areas'}`
    : ('Interests');
  const interestsChipName = areas.length > 0
    ? (`Your interests: ${areas.length} ${areas.length === 1 ? 'area' : 'areas'}. Change them`)
    : ('Choose your interests');

  // The welcome is a page of its own, with its own <main>: the feed's page
  // is not mounted underneath it, so the route keeps exactly one landmark.
  // Its sign-in is the same door as the header's.
  if (firstVisit) {
    return (
      <GuestWelcome
        initialAreas={NO_AREAS}
        onComplete={submitInterests}
        onSignIn={() => requestAccount('other')}
      />
    );
  }

  return (
    <>
      <main className="guest-feed-page">
        {/* The page's h1, above the paper titles (h2): this route is also `/`
            and every protected route without a session, and it had none. */}
        <h1 className="visually-hidden">{'PaperTok: scientific papers for you'}</h1>
        <header className="guest-feed-header" aria-label={'PaperTok guest navigation'}>
          <div className="guest-wordmark" aria-label="PaperTok">Paper<span>Tok</span></div>
          <div className="guest-header-actions">
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
              <Sparkle size={15} aria-hidden="true" />
              <span className="guest-interests-label">{interestsChipLabel}</span>
            </button>
            <button type="button" className="guest-sign-in-button" onClick={() => requestAccount('other')}>
              <SignIn size={15} /> {'Sign in'}
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
            onSubmit={submitInterests}
            onDismiss={dismissInterests}
          />
        )}
      </AnimatePresence>
    </>
  );
}
