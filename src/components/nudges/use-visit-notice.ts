import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../../legal/privacyPolicy.ts';
import {
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  PRIVACY_NOTICE_SELECTOR,
  emailNudgeProblem,
  focusAfterNotice,
  isNudgePath,
  modalIsOpen,
  noticeOnScreen,
  pickVisitNotice,
  privacyOwedFor,
  readDismissedNudges,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
  statusIsSet,
  trackFocusOutsideNotice,
  visitChoiceDue,
  visitReaderReady,
} from '../../utils/nudges.ts';

export const PRIVACY_NOTICE_COPY = {
  title: 'Privacy policy updated',
  announced: 'The notice is at the top of the feed, before the papers.',
  policy: 'Read the policy',
  newTab: ' (opens in a new tab)',
  done: 'Got it',
  hide: 'Hide for now',
  hideDetail: ' (shows again next visit)',
};

function subscribeToModals(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
  return () => observer.disconnect();
}

// The one place that decides whether anybody is told or asked anything on a
// visit, and when. AppContent calls it once: NudgeHost renders the email nudge
// and the status message, and the feed renders the privacy notice above its
// cards (app.tsx passes it to FeedContainer).
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
// signed-in accounts are told, and it returns on later visits until the reader
// chooses Got it; utils/nudges.ts decides who is owed it. It is chosen on
// arrival rather than a minute in, because it takes a row above the cards and
// arriving later would move the card being read. Whatever was picked is shown on
// the feed only and comes back when the reader returns to it. A change of account
// remounts AppContent, which clears what was picked for the previous reader.
export function useVisitNotice() {
  const { user, loading: authLoading, onboardingComplete, profileLoadError } = useAuth();
  const { health, loading: emailLoading } = useEmailNotifications();
  const location = useLocation();

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

  const closeNudge = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
  }, []);

  const onScreen = noticeOnScreen({ picked, signedIn, pathname: location.pathname });
  const privacyShown = onScreen === PRIVACY_NOTICE_ID;

  // Where focus was on the page before it went into the notice: Got it and Hide
  // for now hand it back there, so the next Tab continues from the card the
  // reader was on and not from the top of the page. Focus moves only when it was
  // inside the notice: Safari does not focus a button on click.
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

  // Hide for now puts it away for this visit and does not count as reading it,
  // so it returns next time.
  const hidePrivacy = useCallback(() => {
    const active = document.activeElement;
    const focusWasInside = Boolean(active && document.querySelector(PRIVACY_NOTICE_SELECTOR)?.contains(active));
    const before = focusTracker.current?.target();
    const rect = before?.getBoundingClientRect();
    const rememberedOnScreen = Boolean(rect && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth);
    setPicked(null);
    const next = focusAfterNotice({ focusWasInside, viaKeyboard: Boolean(active?.matches(':focus-visible')), rememberedOnScreen });
    if (next === 'blur') (active as HTMLElement).blur();
    else if (next === 'remembered') before?.focus({ preventScroll: true });
    else if (next === 'page') document.getElementById('main-content')?.focus({ preventScroll: true });
  }, []);

  const uid = user?.uid;
  const acknowledgePrivacy = useCallback(() => {
    if (uid) rememberPrivacyNotice(uid, PRIVACY_POLICY_VERSION);
    hidePrivacy();
  }, [uid, hidePrivacy]);

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

  return { onScreen, privacyShown, statusSet, emailProblem, closeNudge, hidePrivacy, acknowledgePrivacy };
}

export type VisitNotice = ReturnType<typeof useVisitNotice>;
