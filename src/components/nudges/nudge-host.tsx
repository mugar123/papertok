import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../../legal/privacy-policy.ts';
import {
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  VISIT_START,
  answerPrivacyNotice,
  chooseVisitNotice,
  emailNudgeProblem,
  feedCardsStay,
  modalIsOpen,
  noticeOnScreen,
  privacyCardsCover,
  privacyDialogOpen,
  privacyOwedFor,
  readDismissedNudges,
  readingMinutePassed,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
  visitChoiceGates,
  visitReaderReady,
  type VisitNotices,
} from '../../utils/nudges.ts';
import { setCardsCovered } from '../../utils/visible-time.ts';
import NudgePanel from './nudge-panel.tsx';
import PrivacyNotice from './privacy-notice.tsx';

// The one place that decides whether anybody is told or asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two at once. The corner belongs to the reader.
//     (A privacy notice hidden for the visit gives its turn back; see below.)
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
// Guests are out entirely: they already have one thing being asked of them.
//
// A privacy policy change takes the visit's turn before any nudge. Only
// signed-in accounts are told, in a dialog that opens once the feed shows its
// first cards, never over its loading or error screen, and returns on later
// visits until the reader chooses Got it; utils/nudges.ts decides who is owed
// it. Got it spends the visit's turn. Hide for now (or Escape, a press outside,
// the X) hands it back, so a nudge may follow after another minute of reading:
// a reader who keeps hiding the notice is not kept from hearing that email is
// down (answerPrivacyNotice). Both are picked on the feed, a nudge where it was
// before the notice existed (visitChoiceGates). The dialog is shown on the feed
// only and comes back when the reader returns to it; a nudge stays on every
// route until it is dismissed (noticeOnScreen). The notice takes the turn on
// arrival, before the cards and before a failed profile read is retried: a
// visit whose feed never shows cards (an error, an empty feed) or whose profile
// never loads shows neither the dialog nor a nudge. A change of account
// remounts this component, which clears what was picked for the previous reader.

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

// Another tab's writes; this tab's own are read on its next render.
function subscribeToOtherTabs(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

export default function NudgeHost() {
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth();
  const { health, loading: emailLoading } = useEmailNotifications();
  const location = useLocation();
  const navigate = useNavigate();

  const [dismissed, setDismissed] = useState(() => readDismissedNudges());
  // What this visit picked, whether its choice is made and its minute of
  // reading has passed (utils/nudges.ts). State and not a ref, because the
  // choice is read during render — the same shape (and the same reason) as the
  // guest interests sheet.
  const [visit, setVisit] = useState<VisitNotices>(VISIT_START);
  const { picked, dwellDone, readingMinute } = visit;

  const gates = visitChoiceGates({ user, loading: authLoading, onboardingComplete, pathname: location.pathname });
  const { signedIn } = gates;
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  // Hide for now starts the minute over (readingMinute), so it restarts here
  // even when the first minute had not passed yet.
  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setVisit(current => readingMinutePassed(current, readingMinute)), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone, readingMinute]);

  // Read again on every render and whenever another tab writes storage, so Got
  // it chosen in another tab puts the notice away here as well.
  const privacyOwed = useSyncExternalStore(
    subscribeToOtherTabs,
    () => privacyOwedFor({ user, signedIn, version: PRIVACY_POLICY_VERSION, effectiveAt: PRIVACY_POLICY_EFFECTIVE_AT }),
    () => false,
  );

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  const chosen = chooseVisitNotice(visit, {
    gates,
    privacyOwed,
    eligible: emailProblem ? ['email-down'] : [],
    dismissed,
  });
  if (chosen !== visit) setVisit(chosen);

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setVisit(current => ({ ...current, picked: null }));
  }, []);

  const readerReady = visitReaderReady({ user, loading: authLoading, onboardingComplete, profileLoadError });
  const onScreen = noticeOnScreen({ picked, signedIn: readerReady, pathname: location.pathname, privacyOwed });
  const privacyShown = onScreen === PRIVACY_NOTICE_ID;

  // The dialog waits for the For You feed's first cards (/feed renders this
  // context's list), so it never covers the loading or error screen. Nor does
  // it open over another modal: one still open, or still playing its exit, is
  // waited for. Modals are watched only while it waits with cards on screen.
  const cardsShown = useFeed().papers.length > 0;
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const waiting = privacyShown && cardsShown && !privacyOpen;
  const subscribe = useCallback((onChange: () => void) => (waiting ? subscribeToModals(onChange) : () => undefined), [waiting]);
  const modalOpen = useSyncExternalStore(subscribe, () => waiting && modalIsOpen(document), () => false);
  const dialogOpen = privacyDialogOpen({ shown: privacyShown, cardsShown, modalOpen, wasOpen: privacyOpen });
  if (dialogOpen !== privacyOpen) setPrivacyOpen(dialogOpen);

  // The cards under the open dialog stop counting their time on screen. When
  // the reader answers it, here or in another tab, they count again. When it
  // closes because the feed is going (feedCardsStay), they stay paused while
  // the feed plays its exit. A layout effect, so the cover is lifted before the
  // next page's cards start their trackers in that commit's effects, and those
  // are not taken for leaving ones.
  const cardsStay = feedCardsStay({ readerReady, pathname: location.pathname });
  useLayoutEffect(() => {
    setCardsCovered(...privacyCardsCover({ dialogOpen, cardsStay }));
  }, [dialogOpen, cardsStay]);
  // Unmounted with the whole account's tree, its cards included.
  useLayoutEffect(() => () => setCardsCovered(false, { leaving: true }), []);

  // Hide for now puts it away for this visit and does not count as reading it,
  // so it returns next time. Back is not routed here: like the app's other
  // dialogs (lists, email updates, the search palette), this one pushes no
  // history entry, so Back goes where it would without it. Unlike them it opens
  // unasked, so on a cold start at /feed Back leaves PaperTok (an installed app
  // closes) instead of closing the dialog; the notice then returns on the next
  // visit, as after Hide for now. Only the full-screen reader, PDF viewer and
  // Similar layer borrow an entry (use-overlay-history.ts).
  const hidePrivacy = useCallback(() => setVisit(current => answerPrivacyNotice(current, 'hide')), []);

  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    if (uid) rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    setVisit(current => answerPrivacyNotice(current, 'got-it'));
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
