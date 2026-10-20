import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ChartBar, EnvelopeSimple, Star } from '@phosphor-icons/react';
import { GithubMark } from '../ui/GithubMark.tsx';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.ts';
import { useEmailNotifications } from '../../context/EmailNotificationsContext.tsx';
import { useLanguage } from '../../context/LanguageContext.tsx';
import {
  NUDGE_DWELL_MS,
  STAR_FETCH_BUDGET_MS,
  cacheStarCount,
  emailNudgeProblem,
  pickNudge,
  readCachedStarCount,
  readDismissedNudges,
  rememberNudgeDismissal,
} from '../../utils/nudges.ts';
import NudgePanel from './NudgePanel.tsx';

// The one place that decides whether anybody is asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
// Guests are out entirely: they already have one thing being asked of them.
// The analytics consent ask comes first and owns the corner until it is
// answered. It does not wait the minute: until then, detailed analytics is off.

export const REPO_URL = 'https://github.com/mugar123/papertok';
const REPO_API_URL = 'https://api.github.com/repos/mugar123/papertok';

// How long the thanks beat is on screen before the panel leaves.
const THANKS_HOLD_MS = 600;

const COPY = {
  en: {
    consent: {
      title: 'Help us improve PaperTok',
      // The first layer stays short; the policy it links has the detail.
      body: 'We use cookies to understand how PaperTok is used and make it better. If you reject, we only count visits anonymously.',
      policy: 'Privacy policy',
      newTab: ' (opens in a new tab)',
      allow: 'Accept',
      anonymous: 'Reject',
      saveFailed: 'Not saved: this browser is blocking site storage.',
    },
    dismiss: 'Dismiss and do not show again',
    starsLabel: (count: number) => `${count} ${count === 1 ? 'star' : 'stars'} on GitHub`,
    'open-source': {
      title: 'PaperTok is open source',
      body: 'MIT licensed. A star helps other people find it.',
      cta: 'Star on GitHub',
    },
    'email-down': {
      'not-configured': {
        title: 'Email updates are paused',
        body: 'The service is not connected yet, so no digest will go out.',
      },
      unavailable: {
        title: 'Email updates are paused',
        body: 'The email service is not responding right now, so digests are not going out.',
      },
      cta: 'Settings',
    },
  },
};

export default function NudgeHost() {
  const { user, loading: authLoading, onboardingComplete } = useAuth();
  const { decided, updateConsent } = useAnalyticsConsent();
  const [consentSaveFailed, setConsentSaveFailed] = useState(false);
  const { locale } = useLanguage();
  const { health, loading: emailLoading } = useEmailNotifications();
  const location = useLocation();
  const navigate = useNavigate();

  const [dismissed, setDismissed] = useState(() => readDismissedNudges());
  const [dwellDone, setDwellDone] = useState(false);
  // `null` until one is picked. The star count is `undefined` while it is
  // still being resolved and a number-or-null once it is: the panel does not
  // appear until then, so the count travels with it and never lands late on a
  // reader's copy.
  const [picked, setPicked] = useState<string | null>(null);
  const [stars, setStars] = useState<number | null | undefined>(undefined);
  const [thanked, setThanked] = useState(false);
  // One per visit: flipped the moment the choice is made, so a re-render, a
  // navigation or the health request landing cannot start a second one. State
  // and not a ref, because this is read during render — the same shape (and
  // the same reason) as the guest interests sheet.
  const [choiceMade, setChoiceMade] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const signedIn = Boolean(user) && !authLoading && onboardingComplete;
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setDwellDone(true), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone]);

  const askConsent = signedIn && !decided;
  const openable = dwellDone
    && signedIn
    && decided
    && location.pathname === '/feed';

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  if (openable && !choiceMade) {
    setChoiceMade(true);
    const id = pickNudge({
      eligible: ['open-source', ...(emailProblem ? ['email-down'] : [])],
      dismissed,
    });
    if (id) {
      setPicked(id);
      setStars(id === 'open-source' ? (readCachedStarCount() ?? undefined) : null);
    }
  }

  // The count, when it was not already cached. A short budget, and then the
  // panel goes without it: a chip that arrives late would push the copy.
  useEffect(() => {
    if (picked !== 'open-source' || stars !== undefined) return undefined;
    let settled = false;
    const reveal = (value: number | null) => {
      if (settled || !aliveRef.current) return;
      settled = true;
      setStars(value);
    };
    const budget = window.setTimeout(() => reveal(null), STAR_FETCH_BUDGET_MS);
    fetch(REPO_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        const count = Number(payload?.stargazers_count);
        const usable = Number.isInteger(count) && count >= 0;
        if (usable) cacheStarCount(count);
        reveal(usable ? count : null);
      })
      .catch(() => reveal(null));
    return () => window.clearTimeout(budget);
  }, [picked, stars]);

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
    setThanked(false);
  }, []);

  // Pressing the star opens GitHub in its own tab (the button is a link, so
  // the browser does that itself) and the panel nods once before leaving.
  const handleStar = useCallback(() => {
    setThanked(true);
    window.setTimeout(() => close('open-source'), THANKS_HOLD_MS);
  }, [close]);

  const handleSettings = useCallback(() => {
    close('email-down');
    navigate('/settings/notifications');
  }, [close, navigate]);

  // Emptied first so a second refusal is announced too: a live region speaks
  // only when its text changes.
  const answerConsent = useCallback(async (value: string) => {
    setConsentSaveFailed(false);
    const saved = await updateConsent(value);
    setConsentSaveFailed(!saved);
    // The panel, and the button that had focus, leave with the answer: focus
    // goes where the skip link would take it rather than to <body>.
    if (saved) document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [updateConsent]);

  const copy = COPY.en;
  const isStar = picked === 'open-source';
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;
  const ready = picked !== null && stars !== undefined;

  return (
    <AnimatePresence>
      {askConsent ? (
        <NudgePanel
          key="analytics-consent"
          icon={<ChartBar size={19} />}
          title={copy.consent.title}
          body={(
            <>
              {copy.consent.body}{' '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer">
                {copy.consent.policy}
                <span className="visually-hidden">{copy.consent.newTab}</span>
              </a>
              <span role="status" className="nudge-status">{consentSaveFailed ? copy.consent.saveFailed : ''}</span>
            </>
          )}
          action={{ label: copy.consent.allow, onClick: () => answerConsent(ANALYTICS_CONSENT.DETAILED) }}
          secondaryAction={{ label: copy.consent.anonymous, onClick: () => answerConsent(ANALYTICS_CONSENT.ANONYMOUS) }}
        />
      ) : ready && (isStar || emailCopy) && (
        isStar ? (
          <NudgePanel
            key="nudge-open-source"
            icon={<GithubMark size={19} />}
            iconClassName={`nudge-icon--github${thanked ? ' is-thanked' : ''}`}
            title={(
              <>
                {copy['open-source'].title}
                {stars !== null && (
                  <span className="nudge-stars" aria-label={copy.starsLabel(stars!)}>
                    <Star size={11} weight="fill" aria-hidden="true" />
                    {stars!.toLocaleString(locale)}
                  </span>
                )}
              </>
            )}
            body={copy['open-source'].body}
            action={{ label: copy['open-source'].cta, href: REPO_URL, onClick: handleStar }}
            dismissLabel={copy.dismiss}
            onDismiss={() => close('open-source')}
          />
        ) : (
          <NudgePanel
            key="nudge-email-down"
            icon={<EnvelopeSimple size={19} />}
            title={emailCopy!.title}
            body={emailCopy!.body}
            action={{ label: copy['email-down'].cta, onClick: handleSettings }}
            dismissLabel={copy.dismiss}
            onDismiss={() => close('email-down')}
          />
        )
      )}
    </AnimatePresence>
  );
}
