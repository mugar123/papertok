import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { AnimatePresence } from 'framer-motion';
import { EnvelopeSimple } from '@phosphor-icons/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/auth-context.tsx';
import { useEmailNotifications } from '../../context/email-notifications-context.tsx';
import { useFeed } from '../../context/feed-context.tsx';
import { PRIVACY_NOTICE_BASELINE_VERSION, PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../../legal/privacy-policy.ts';
import { readAccountPrivacyNotice, saveAccountPrivacyNotice } from '../../services/privacy-notice-service.ts';
import {
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  VISIT_START,
  accountAnswerPending,
  answerPrivacyNotice,
  chooseVisitNotice,
  emailNudgeProblem,
  feedCardsStay,
  heldAccountNotice,
  loadAccountNotice,
  modalIsOpen,
  noticeOnScreen,
  privacyCardsCover,
  privacyDialogOpen,
  privacyNoticeStatus,
  readDismissedNudges,
  readingMinutePassed,
  recordPrivacyNoticeShown,
  rememberNudgeDismissal,
  visitChoiceGates,
  visitReaderReady,
  type AccountNoticeRecord,
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
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
// Guests are out entirely: they already have one thing being asked of them.
//
// A privacy policy change takes the visit's turn before any nudge. Only
// signed-in accounts are told, in a dialog that opens once the feed shows its
// first cards, never over its loading or error screen; utils/nudges.ts decides
// who is owed it, and when that takes the account's own record, the dialog
// and the visit's choice of a notice wait for the read (a failed read releases
// the choice). Once the dialog is open on screen the version is recorded
// as told for the account, in the account and in this browser
// (recordPrivacyNoticeShown), so it does not return on a later visit or another
// device however it was closed. It stays open until the reader closes it,
// and any close spends the visit's turn (answerPrivacyNotice). Both are picked
// on the feed, a nudge where it was before the notice existed
// (visitChoiceGates). The dialog is shown on the feed only, and leaving the
// feed closes it; a nudge stays on every route until it is dismissed
// (noticeOnScreen). The notice takes the turn on
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

// A hidden tab does not open the dialog, so a tab in the background cannot use
// up the notice before anybody has seen it.
function subscribeToTabVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
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
  const { picked, dwellDone } = visit;

  const gates = visitChoiceGates({ user, loading: authLoading, onboardingComplete, pathname: location.pathname });
  const { signedIn } = gates;
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setVisit(readingMinutePassed), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone]);

  // The account's record of the version it was shown, once read. Kept with its
  // uid, so a read for one account never decides for the next.
  const [accountNotice, setAccountNotice] = useState<AccountNoticeRecord | null>(null);
  // The uid whose read failed in this visit, so the visit stops waiting for it.
  const [accountReadFailedFor, setAccountReadFailedFor] = useState<string | null>(null);
  const uid = user?.uid;

  // Read again on every render and whenever another tab writes storage, so a
  // notice shown in another tab puts away the one waiting here as well.
  const privacyStatus = useSyncExternalStore(
    subscribeToOtherTabs,
    () => privacyNoticeStatus({
      user,
      signedIn,
      version: PRIVACY_POLICY_VERSION,
      effectiveAt: PRIVACY_POLICY_EFFECTIVE_AT,
      baseline: PRIVACY_NOTICE_BASELINE_VERSION,
      account: accountNotice,
    }),
    () => 'settled' as const,
  );
  const privacyOwed = privacyStatus === 'owed';
  // Whether the account is being asked and its read for this uid has not failed.
  const privacyPending = accountAnswerPending({ status: privacyStatus, uid, failedFor: accountReadFailedFor });

  // Asked only when nothing else settles it, and not again in this visit once a
  // read for the uid has failed (a profile retry included): the notice stays
  // unshown until the next visit asks again. An answer that lands after the
  // account changed is dropped.
  useEffect(() => {
    if (!privacyPending || !uid) return undefined;
    const controller = new AbortController();
    void loadAccountNotice({ uid, read: readAccountPrivacyNotice, signal: controller.signal }).then(answer => {
      if (answer === 'failed') setAccountReadFailedFor(uid);
      else if (answer) setAccountNotice(answer);
    });
    return () => controller.abort();
  }, [privacyPending, uid]);

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  const chosen = chooseVisitNotice(visit, {
    gates,
    privacyOwed,
    privacyPending,
    eligible: emailProblem ? ['email-down'] : [],
    dismissed,
  });
  if (chosen !== visit) setVisit(chosen);

  const close = useCallback((id: string) => {
    setDismissed(rememberNudgeDismissal(id));
    setVisit(current => ({ ...current, picked: null }));
  }, []);

  // The dialog waits for the For You feed's first cards (/feed renders this
  // context's list), so it never covers the loading or error screen. Nor does
  // it open over another modal: one still open, or still playing its exit, is
  // waited for. Modals are watched only while it waits with cards on screen.
  const cardsShown = useFeed().papers.length > 0;
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const readerReady = visitReaderReady({ user, loading: authLoading, onboardingComplete, profileLoadError });
  const onScreen = noticeOnScreen({ picked, signedIn: readerReady, pathname: location.pathname, privacyOwed, dialogOpen: privacyOpen });
  const privacyShown = onScreen === PRIVACY_NOTICE_ID;
  const waiting = privacyShown && cardsShown && !privacyOpen;
  const subscribe = useCallback((onChange: () => void) => (waiting ? subscribeToModals(onChange) : () => undefined), [waiting]);
  const modalOpen = useSyncExternalStore(subscribe, () => waiting && modalIsOpen(document), () => false);
  const tabVisible = useSyncExternalStore(subscribeToTabVisibility, () => document.visibilityState === 'visible', () => false);
  const dialogOpen = privacyDialogOpen({ shown: privacyShown, cardsShown, modalOpen, tabVisible, wasOpen: privacyOpen });
  if (dialogOpen !== privacyOpen) setPrivacyOpen(dialogOpen);
  // Open, the version counts as told for the rest of the visit too.
  const heldNotice = heldAccountNotice({ dialogOpen, uid, version: PRIVACY_POLICY_VERSION, account: accountNotice });
  if (heldNotice !== accountNotice) setAccountNotice(heldNotice);

  // The cards under the open dialog stop counting their time on screen. When
  // the reader closes it, they count again. When it
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

  // Recorded once the dialog is on screen, so the version counts as told
  // however it is then closed. Back is not routed to the dialog: like the app's
  // other dialogs (lists, email updates, the search palette), this one pushes no
  // history entry, so Back goes where it would without it. Unlike them it opens
  // unasked, so on a cold start at /feed Back leaves PaperTok (an installed app
  // closes) instead of closing the dialog; it was already recorded, so it does
  // not return. Only the full-screen reader, PDF viewer and Similar layer
  // borrow an entry (use-overlay-history.ts).
  useEffect(() => {
    recordPrivacyNoticeShown({ uid, dialogOpen, version: PRIVACY_POLICY_VERSION, saveToAccount: saveAccountPrivacyNotice });
  }, [uid, dialogOpen]);

  const closePrivacy = useCallback(() => setVisit(answerPrivacyNotice), []);

  const handleSettings = useCallback(() => {
    close('email-down');
    void navigate('/settings/notifications');
  }, [close, navigate]);

  const copy = COPY.en;
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;

  return (
    <>
      <PrivacyNotice open={dialogOpen} onClose={closePrivacy} />
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
