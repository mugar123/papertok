import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple, ShieldCheck } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { PRIVACY_POLICY_CHANGE, PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../../legal/privacyPolicy.ts';
import {
  NUDGE_DWELL_MS,
  NUDGE_PANEL_SELECTOR,
  isNudgePath,
  modalIsOpen,
  PRIVACY_NOTICE_ID,
  emailNudgeProblem,
  escapeBelongsToOther,
  noticeOnScreen,
  pickVisitNotice,
  privacyOwedFor,
  readDismissedNudges,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
  statusIsSet,
  trackFocusOutsideNotice,
} from '../../utils/nudges.ts';
import NudgePanel from './nudge-panel.tsx';

// The one place that decides whether anybody is asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
//
//   · Guests are out entirely: they already have one thing being asked of them.
//
// A privacy policy change takes the visit's turn before any nudge. Only
// signed-in accounts are told, and it returns on later visits until it is
// dismissed; utils/nudges.ts decides who is owed it. Whatever was picked, the
// email nudge too, is shown on the feed only and comes back when the reader
// returns to it: on a route with a modal paper it would cover the card and
// take the Escape meant for the notice. A change of account remounts this
// component, which clears what was picked for the previous reader.

const COPY = {
  en: {
    dismiss: 'Dismiss and do not show again',
    privacy: {
      title: 'Privacy policy updated',
      announced: 'The notice follows the feed, as a landmark with the same name.',
      policy: 'Read the policy',
      newTab: ' (opens in a new tab)',
      done: 'Got it',
      hide: 'Hide for now (shows again next visit)',
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

function subscribeToModals(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
  return () => observer.disconnect();
}

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
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setDwellDone(true), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone]);

  const openable = dwellDone
    && signedIn
    && isNudgePath(location.pathname);

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  if (openable && user && !choiceMade) {
    setChoiceMade(true);
    const id = pickVisitNotice({
      privacyOwed: privacyOwedFor({
        user,
        signedIn,
        version: PRIVACY_POLICY_VERSION,
        effectiveAt: PRIVACY_POLICY_EFFECTIVE_AT,
      }),
      eligible: emailProblem ? ['email-down'] : [],
      dismissed,
    });
    if (id) setPicked(id);
  }

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
  }, []);

  const onScreen = noticeOnScreen({ picked, signedIn, pathname: location.pathname });
  const privacyShown = onScreen === PRIVACY_NOTICE_ID;

  // Escape puts it away for this visit and does not count as reading it, so it
  // returns next time. On a phone the panel covers the bottom of the card, and
  // this is how a control focused underneath is seen again (WCAG 2.4.11).
  // The close button does the same for a touch reader, who has no Escape.
  // Focus moves only when it was inside the panel: Safari does not focus a
  // button on click, and a reader whose focus sits on a feed control keeps it.
  // Where focus was on the page before it went into the panel: Got it and the
  // close button hand it back there, so the next Tab continues from the card the
  // reader was on and not from the top of the page.
  const focusTracker = useRef<ReturnType<typeof trackFocusOutsideNotice> | null>(null);
  useEffect(() => {
    if (!privacyShown) return undefined;
    const tracker = trackFocusOutsideNotice(document);
    focusTracker.current = tracker;
    return () => {
      tracker.stop();
      focusTracker.current = null;
    };
  }, [privacyShown]);

  const hidePrivacyForVisit = useCallback(() => {
    const focusWasInside = Boolean(document.querySelector(NUDGE_PANEL_SELECTOR)?.contains(document.activeElement));
    const before = focusTracker.current?.target();
    setPicked(null);
    if (!focusWasInside) return;
    (before ?? document.getElementById('main-content'))?.focus({ preventScroll: true });
  }, []);

  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    if (uid) rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    hidePrivacyForVisit();
  }, [uid, hidePrivacyForVisit]);

  useEffect(() => {
    if (!privacyShown) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || escapeBelongsToOther(event.target)) return;
      hidePrivacyForVisit();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [privacyShown, hidePrivacyForVisit]);

  // A status set while a modal is open is never spoken (everything outside it is
  // hidden from assistive technology), and closing the modal would not change the
  // text again. So the message waits for the modal to close, and once set it stays
  // set: clearing it for each later modal would have it read after every one.
  // Modals are watched only while the notice is shown.
  const subscribe = useCallback((onChange: () => void) => (privacyShown ? subscribeToModals(onChange) : () => undefined), [privacyShown]);
  const modalOpen = useSyncExternalStore(subscribe, () => privacyShown && modalIsOpen(document), () => false);
  const [announced, setAnnounced] = useState(false);
  const statusSet = statusIsSet({ shown: privacyShown, modalOpen, announced });
  if (statusSet !== announced) setAnnounced(statusSet);

  const handleSettings = useCallback(() => {
    close('email-down');
    void navigate('/settings/notifications');
  }, [close, navigate]);

  const copy = COPY.en;
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

  return (
    <>
    {/* Always mounted, outside the panel: a live region speaks when its text
        changes, and one that arrives already holding text is often not read.
        It says only that the notice is there; the summary is read once, in the
        panel, instead of a second time from here. */}
    <p className="visually-hidden" role="status">
      {statusSet ? `${copy.privacy.title}. ${copy.privacy.announced}` : ''}
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
          dismissLabel={copy.privacy.hide}
          onDismiss={hidePrivacyForVisit}
        />
      ) : onScreen === 'email-down' && emailCopy && (
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
