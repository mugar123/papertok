import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ChartBar, EnvelopeSimple } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAnalyticsConsent } from '../../context/analytics-context.tsx';
import { useAuth } from '../../context/auth-context.tsx';
import { ANALYTICS_CONSENT } from '../../services/analytics-service.ts';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import {
  NUDGE_DWELL_MS,
  emailNudgeProblem,
  pickNudge,
  readDismissedNudges,
  rememberNudgeDismissal,
} from '../../utils/nudges.ts';
import NudgePanel from './nudge-panel.tsx';

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
  const { health, loading: emailLoading } = useEmailNotifications();
  const location = useLocation();
  const navigate = useNavigate();

  const [dismissed, setDismissed] = useState(() => readDismissedNudges());
  const [dwellDone, setDwellDone] = useState(false);
  // `null` until one is picked.
  const [picked, setPicked] = useState<string | null>(null);
  // One per visit: flipped the moment the choice is made, so a re-render, a
  // navigation or the health request landing cannot start a second one. State
  // and not a ref, because this is read during render — the same shape (and
  // the same reason) as the guest interests sheet.
  const [choiceMade, setChoiceMade] = useState(false);

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
      eligible: emailProblem ? ['email-down'] : [],
      dismissed,
    });
    if (id) setPicked(id);
  }

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
  }, []);

  const handleSettings = useCallback(() => {
    close('email-down');
    void navigate('/settings/notifications');
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
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

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
          action={{ label: copy.consent.allow, onClick: () => { void answerConsent(ANALYTICS_CONSENT.DETAILED); } }}
          secondaryAction={{ label: copy.consent.anonymous, onClick: () => { void answerConsent(ANALYTICS_CONSENT.ANONYMOUS); } }}
        />
      ) : picked === 'email-down' && emailCopy && (
        <NudgePanel
          key="nudge-email-down"
          icon={<EnvelopeSimple size={19} />}
          title={emailCopy.title}
          body={emailCopy.body}
          action={{ label: copy['email-down'].cta, onClick: handleSettings }}
          dismissLabel={copy.dismiss}
          onDismiss={() => close('email-down')}
        />
      )}
    </AnimatePresence>
  );
}
