import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple, ShieldCheck } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { PRIVACY_POLICY_CHANGE, PRIVACY_POLICY_VERSION } from '../../legal/privacyPolicy.ts';
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
import { isPublicRoute } from '../../utils/public-navigation.ts';
import NudgePanel from './nudge-panel.tsx';

// The one place that decides whether anybody is asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
//
// A privacy policy change takes the visit's turn before any nudge, and it is
// the only panel guests see: on a public page they are reading, never in the
// welcome, which is a sign-up rather than reading. It returns on later visits
// until it is dismissed; utils/nudges.ts decides who is owed it. A change of
// account remounts this component, which clears what was picked for the
// previous reader.
const PRIVACY_NOTICE = 'privacy-change';

const COPY = {
  en: {
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

  const openable = dwellDone
    && signedIn
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

  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    setPicked(null);
    // The button that had focus leaves with the panel.
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [uid]);

  // Only where it was meant to be seen: a guest who moves on to the welcome,
  // a sign-up, no longer has it over the form.
  const privacyShown = picked === PRIVACY_NOTICE && (signedIn || guestReading);

  // Escape puts it away for this visit and does not count as reading it, so it
  // returns next time. On a phone the panel covers the bottom of the card, and
  // this is how a control focused underneath is seen again (WCAG 2.4.11).
  useEffect(() => {
    if (!privacyShown) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focusWasInside = Boolean(document.querySelector('.nudge')?.contains(document.activeElement));
      setPicked(null);
      if (focusWasInside) document.getElementById('main-content')?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [privacyShown]);

  const handleSettings = useCallback(() => {
    close('email-down');
    void navigate('/settings/notifications');
  }, [close, navigate]);

  const copy = COPY.en;
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

  return (
    <>
    {/* Always mounted, outside the panel: a live region speaks when its text
        changes, and one that arrives already holding text is often not read. */}
    <p className="visually-hidden" role="status">
      {privacyShown ? `${copy.privacy.title}. ${PRIVACY_POLICY_CHANGE}` : ''}
    </p>
    <AnimatePresence>
      {privacyShown ? (
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
