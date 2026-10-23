import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ChartBar, EnvelopeSimple, ShieldCheck } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.tsx';
import { useAuth } from '../../context/AuthContext.tsx';
import { PRIVACY_POLICY_CHANGE, PRIVACY_POLICY_VERSION } from '../../legal/privacyPolicy.ts';
import { ANALYTICS_CONSENT } from '../../services/analyticsService.ts';
import { useEmailNotifications } from '../../context/EmailNotificationsContext.tsx';
import {
  NUDGE_DWELL_MS,
  emailNudgeProblem,
  pickNudge,
  privacyNoticeOwed,
  readDismissedNudges,
  readPrivacyNoticeAck,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
} from '../../utils/nudges.ts';
import { isPublicRoute } from '../../utils/publicNavigation.ts';
import NudgePanel from './NudgePanel.tsx';

// The one place that decides whether anybody is asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
// The analytics consent ask comes first and owns the corner until it is
// answered. It does not wait the minute: until then, detailed analytics is off.
//
// A privacy policy change takes the visit's turn before any nudge, and it is
// the only panel guests see: on a public page they are reading, never in the
// welcome, which is a sign-up rather than reading. It returns on later visits
// until it is dismissed; utils/nudges.ts decides who is owed it.
const PRIVACY_NOTICE = 'privacy-change';

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
    privacy: {
      title: 'Privacy policy updated',
      policy: 'Read the policy',
      newTab: ' (opens in a new tab)',
      done: 'Got it',
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
  const guestReading = !user && !authLoading && isPublicRoute(location.pathname);
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!(signedIn || guestReading) || dwellDone) return undefined;
    const timer = window.setTimeout(() => setDwellDone(true), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, guestReading, dwellDone]);

  const askConsent = signedIn && !decided;
  const openable = dwellDone
    && signedIn
    && decided
    && location.pathname === '/feed';
  const guestOpenable = dwellDone && guestReading;

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  if ((openable || guestOpenable) && !choiceMade) {
    setChoiceMade(true);
    const privacyOwed = privacyNoticeOwed({
      version: PRIVACY_POLICY_VERSION,
      acknowledged: readPrivacyNoticeAck(user?.uid),
      accountCreated: user?.metadata?.creationTime,
    });
    const id = privacyOwed ? PRIVACY_NOTICE : openable && pickNudge({
      eligible: emailProblem ? ['email-down'] : [],
      dismissed,
    });
    if (id) setPicked(id);
  }

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
  }, []);

  // Escape only puts it away for this visit: a key pressed to clear the corner
  // is no sign the change was read. It comes back on the next visit.
  const hidePrivacy = useCallback(() => setPicked(null), []);
  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    setPicked(null);
    // As with the consent answer: the button that had focus leaves with the panel.
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [uid]);

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
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;
  const privacyShown = picked === PRIVACY_NOTICE;

  return (
    <>
    {/* Always mounted, outside the panel: a live region speaks when its text
        changes, and one that arrives already holding text is often not read. */}
    <p className="visually-hidden" role="status">
      {privacyShown ? `${copy.privacy.title}. ${PRIVACY_POLICY_CHANGE}` : ''}
    </p>
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
      ) : privacyShown ? (
        <NudgePanel
          key="privacy-change"
          icon={<ShieldCheck size={19} />}
          title={copy.privacy.title}
          body={(
            <>
              {PRIVACY_POLICY_CHANGE}{' '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer">
                {copy.privacy.policy}
                <span className="visually-hidden">{copy.privacy.newTab}</span>
              </a>
            </>
          )}
          action={{ label: copy.privacy.done, onClick: acknowledgePrivacy }}
          onEscape={hidePrivacy}
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
    </>
  );
}
