import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../../legal/privacyPolicy.ts';
import {
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  emailNudgeProblem,
  isNudgePath,
  modalIsOpen,
  noticeOnScreen,
  pickVisitNotice,
  privacyDialogOpen,
  privacyOwedFor,
  readDismissedNudges,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
  visitChoiceDue,
  visitReaderReady,
} from '../../utils/nudges.ts';
import NudgePanel from './nudge-panel.tsx';
import PrivacyNotice from './privacy-notice.tsx';

// The one place that decides whether anybody is told or asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
// Guests are out entirely: they already have one thing being asked of them.
//
// A privacy policy change takes the visit's turn before any nudge. Only
// signed-in accounts are told, in a dialog that opens on arrival at the feed and
// returns on later visits until the reader chooses Got it; utils/nudges.ts
// decides who is owed it. Whatever was picked is shown on the feed only and
// comes back when the reader returns to it. A change of account remounts this
// component, which clears what was picked for the previous reader.

const COPY = {
  en: {
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

function subscribeToModals(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
  return () => observer.disconnect();
}

export default function NudgeHost() {
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth();
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

  const signedIn = visitReaderReady({ user, loading: authLoading, onboardingComplete, profileLoadError });
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setDwellDone(true), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone]);

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  if (signedIn && user && !choiceMade && isNudgePath(location.pathname)) {
    const privacyOwed = privacyOwedFor({
      user,
      signedIn,
      version: PRIVACY_POLICY_VERSION,
      effectiveAt: PRIVACY_POLICY_EFFECTIVE_AT,
    });
    if (visitChoiceDue({ privacyOwed, dwellDone })) {
      setChoiceMade(true);
      const id = pickVisitNotice({
        privacyOwed,
        eligible: emailProblem ? ['email-down'] : [],
        dismissed,
      });
      if (id) setPicked(id);
    }
  }

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
  }, []);

  const onScreen = noticeOnScreen({ picked, signedIn, pathname: location.pathname });
  const privacyShown = onScreen === PRIVACY_NOTICE_ID;

  // The dialog never opens over another modal: one still open, or still playing
  // its exit, as the reader reaches the feed is waited for. Modals are watched
  // only while it waits.
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const waiting = privacyShown && !privacyOpen;
  const subscribe = useCallback((onChange: () => void) => (waiting ? subscribeToModals(onChange) : () => undefined), [waiting]);
  const modalOpen = useSyncExternalStore(subscribe, () => waiting && modalIsOpen(document), () => false);
  const dialogOpen = privacyDialogOpen({ shown: privacyShown, modalOpen, wasOpen: privacyOpen });
  if (dialogOpen !== privacyOpen) setPrivacyOpen(dialogOpen);

  // Hide for now puts it away for this visit and does not count as reading it,
  // so it returns next time.
  const hidePrivacy = useCallback(() => setPicked(null), []);

  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    if (uid) rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    setPicked(null);
  }, [uid]);

  const handleSettings = useCallback(() => {
    close('email-down');
    void navigate('/settings/notifications');
  }, [close, navigate]);

  const copy = COPY.en;
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

  return (
    <>
      <PrivacyNotice open={dialogOpen} onAcknowledge={acknowledgePrivacy} onHide={hidePrivacy} />
      <AnimatePresence>
        {onScreen === 'email-down' && emailCopy && (
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
