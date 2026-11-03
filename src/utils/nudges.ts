import { emailServiceState } from './email-health.ts';

type NudgeStorage = Pick<Storage, 'getItem' | 'setItem'>;
/**
 * The small panels that ask for something once and then never again, such as
 * a heads-up that email is down. Everything here is the part that can be
 * decided without a browser — which of them may be shown, which one is shown
 * and what "already answered" means — so the component that renders them is
 * left with rendering.
 *
 * Two rules run through all of it. A nudge is asked once per device and then
 * remembered forever, so the cost of being wrong is not a stray pixel but a
 * person being asked again something they already declined. And a nudge may
 * only claim what somebody has actually confirmed: silence from a health
 * endpoint is not a fault, it is silence.
 */

export const NUDGE_DISMISSED_KEY = 'papertok_nudges_dismissed';

/** A minute of reading before anything asks for attention. */
export const NUDGE_DWELL_MS = 60_000;

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage: NudgeStorage | null | undefined) {
  return storage === undefined ? browserStorage() : storage;
}

/** The ids this device has already answered. Anything else reads as none. */
export function readDismissedNudges(storage?: NudgeStorage | null) {
  try {
    const raw = resolveStorage(storage)?.getItem(NUDGE_DISMISSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Marks one answered, and hands back the list that holds from here on. It
 * returns that list even when the write failed — a private window still gets
 * the panel out of the way for the rest of the visit, which is the part the
 * person asked for.
 */
export function rememberNudgeDismissal<T>(id: T, storage?: NudgeStorage | null) {
  const next: (string | T)[] = readDismissedNudges(storage);
  if (!next.includes(id)) next.push(id);
  try {
    resolveStorage(storage)?.setItem(NUDGE_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // The visit's own state is the fallback; nothing else to do here.
  }
  return next;
}

const PRIVACY_NOTICE_KEY = 'papertok_privacyNotice';

// Unlike the nudges above, kept per reader: each account that signs in on this
// device has to be told separately. It is not swept at sign-out, so signing in
// again does not repeat a notice already dismissed. Deleting the account does
// remove it (forgetPrivacyNotice).
function privacyNoticeKey(uid: string) {
  return `${PRIVACY_NOTICE_KEY}:${encodeURIComponent(uid)}`;
}

/** The policy version this reader last dismissed on this device, if any. */
export function readPrivacyNoticeAck(uid: string, storage?: NudgeStorage | null) {
  try {
    return resolveStorage(storage)?.getItem(privacyNoticeKey(uid)) ?? null;
  } catch {
    return null;
  }
}

/** For a deleted account: its uid has no business staying in this browser. */
export function forgetPrivacyNotice(uid: string, storage?: (NudgeStorage & Pick<Storage, 'removeItem'>) | null) {
  try {
    (storage === undefined ? browserStorage() : storage)?.removeItem(privacyNoticeKey(uid));
  } catch {
    // Clearing site data removes it too.
  }
}

/**
 * Orders policy versions ('2026-10-25', '2026-10-25.2'): by date, then by the
 * numeric suffix, so '.10' follows '.2'. A value that is not a version covers
 * nothing, so it reads as older than every version.
 */
function policyVersionRank(version: string | null) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/.exec(version ?? '');
  return match ? { day: match[1], suffix: Number(match[2] ?? 0) } : null;
}

function policyVersionCovers(acknowledged: string | null, version: string) {
  const had = policyVersionRank(acknowledged);
  const owed = policyVersionRank(version);
  if (!had || !owed) return acknowledged === version;
  return had.day !== owed.day ? had.day > owed.day : had.suffix >= owed.suffix;
}

/**
 * Keeps the newest version dismissed: another tab still running an older
 * bundle must not write its version over a newer one this reader dismissed.
 */
export function rememberPrivacyNotice(uid: string, version: string, storage?: NudgeStorage | null) {
  try {
    const target = resolveStorage(storage);
    if (policyVersionCovers(readPrivacyNoticeAck(uid, target), version)) return;
    target?.setItem(privacyNoticeKey(uid), version);
  } catch {
    // The host still closes the notice for this visit; it returns next time.
  }
}

/**
 * Whether a reader still has to hear about policy `version`; dismissing it or a
 * later version settles that. Only signed-in
 * accounts are told: a guest has no creation date, so a first-time visitor
 * could not be told apart from someone who read the old policy. An account
 * created at or after `effectiveAt` (an ISO instant: when the change went
 * live) started under the policy as it is and has nothing to be told; one whose
 * creation time is unknown is told.
 */
export function privacyNoticeOwed({ version, effectiveAt, acknowledged, accountCreated, signedIn }: { version: string; effectiveAt: string; acknowledged: string | null; accountCreated?: string | null; signedIn: boolean }) {
  if (!signedIn || policyVersionCovers(acknowledged, version)) return false;
  const created = accountCreated ? new Date(accountCreated) : null;
  if (!created || Number.isNaN(created.getTime())) return true;
  return created.getTime() < new Date(effectiveAt).getTime();
}

/**
 * Whether the privacy dialog may be on screen: signed in, onboarded and with a
 * profile that loaded. While the profile read has failed, ProtectedRoute shows
 * its retry screen instead of the feed, so the dialog has no feed to open over
 * (app.tsx's showNavbar asks the same).
 */
export function visitReaderReady({ user, loading, onboardingComplete, profileLoadError }: { user: unknown; loading: boolean; onboardingComplete: boolean; profileLoadError: string | null }) {
  return Boolean(user) && !loading && onboardingComplete && !profileLoadError;
}

/**
 * What NudgeHost asks of the policy: the signed-in account, when it was
 * created and what this browser has stored for its uid. Kept here so the
 * arguments that decide who is told are tested, not only the rule itself.
 */
export function privacyOwedFor({ user, signedIn, version, effectiveAt, storage }: { user: { uid: string; metadata?: { creationTime?: string | null } } | null | undefined; signedIn: boolean; version: string; effectiveAt: string; storage?: NudgeStorage | null }) {
  if (!user) return false;
  return privacyNoticeOwed({
    version,
    effectiveAt,
    acknowledged: readPrivacyNoticeAck(user.uid, storage),
    accountCreated: user.metadata?.creationTime,
    signedIn,
  });
}

/** The only route a notice is picked on, and the privacy dialog shown on. */
const NUDGE_PATH = '/feed';

/**
 * Whether `pathname` is the feed route. React Router (and app.tsx, which sets no
 * caseSensitive) also match '/feed/', '/Feed' and '/FEED'.
 */
function isFeedPath(pathname: string) {
  return pathname.replace(/\/+$/, '').toLowerCase() === NUDGE_PATH;
}

/**
 * Who may be told or asked something, and where each notice may be chosen.
 * `signedIn` is an account signed in and onboarded, also while its profile
 * read has failed; the minute of reading runs while it is true. The email
 * nudge keeps the rule it had before the privacy notice existed: chosen at
 * '/feed' exactly. The privacy notice is chosen on every spelling of the feed
 * route (isFeedPath). While the profile read has failed it is not shown
 * (visitReaderReady), and it keeps the visit's turn until a retry loads the
 * profile, as it does while the feed has no cards.
 */
export function visitChoiceGates({ user, loading, onboardingComplete, pathname }: { user: unknown; loading: boolean; onboardingComplete: boolean; pathname: string }) {
  const signedIn = Boolean(user) && !loading && onboardingComplete;
  return { signedIn, nudge: signedIn && pathname === NUDGE_PATH, privacy: signedIn && isFeedPath(pathname) };
}

/**
 * Whether a modal (the reader, the PDF viewer, the Similar layer, a list
 * dialog, the search palette) is open in `root`: every one in this app writes
 * `aria-modal="true"`.
 */
export function modalIsOpen(root: { querySelector(selector: string): unknown }) {
  return root.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Whether the privacy dialog is open. It opens when the notice is on screen
 * (`shown`), the feed shows its first cards (`cardsShown`) and no other modal is
 * open, so it never lands over the feed's loading or error screen, a paper or
 * another dialog: it waits for the cards, and for that dialog to close. Once
 * open it stays open, under any modal opened over it, until the reader puts it
 * away or leaves the feed. `wasOpen` is the value this returned on the previous
 * render; `cardsShown` and `modalOpen` only matter while the dialog is closed
 * (open, it is a modal itself).
 */
export function privacyDialogOpen({ shown, cardsShown, modalOpen, wasOpen }: { shown: boolean; cardsShown: boolean; modalOpen: boolean; wasOpen: boolean }) {
  return shown && (wasOpen || (cardsShown && !modalOpen));
}

export const PRIVACY_NOTICE_ID = 'privacy-change';

/**
 * The picked notice, while it may be on screen. A nudge, once picked on the
 * feed, stays on every route until it is dismissed, as it did before the
 * privacy notice existed. The privacy dialog is shown only to a signed-in reader
 * on the feed, since elsewhere a paper may be open as a modal, and comes back
 * when the reader returns to the feed. It also goes once it is no longer owed
 * (`privacyOwed`, read from storage on every render): Got it chosen in another
 * tab settles it here too.
 */
export function noticeOnScreen({ picked, signedIn, pathname, privacyOwed }: { picked: string | null; signedIn: boolean; pathname: string; privacyOwed: boolean }) {
  if (picked !== PRIVACY_NOTICE_ID) return picked;
  return signedIn && isFeedPath(pathname) && privacyOwed ? picked : null;
}

/** One of the pending ones, at random, or nothing at all. */
export function pickNudge({ eligible = [], dismissed = [], random = Math.random }: { eligible?: string[]; dismissed?: string[]; random?: () => number } = {}) {
  const pending = eligible.filter(id => !dismissed.includes(id));
  if (pending.length === 0) return null;
  const index = Math.min(pending.length - 1, Math.floor(random() * pending.length));
  return pending[index];
}

/**
 * What the visit shows: the privacy change when it is owed, which takes the
 * turn before any nudge, otherwise one of the pending nudges, or nothing.
 */
export function pickVisitNotice({ privacyOwed, eligible = [], dismissed = [], random }: { privacyOwed: boolean; eligible?: string[]; dismissed?: string[]; random?: () => number }) {
  return privacyOwed ? PRIVACY_NOTICE_ID : pickNudge({ eligible, dismissed, random });
}

/**
 * Whether the visit's notice is chosen now, on the feed. A privacy change owed
 * to the reader is chosen at once, so its dialog opens with the feed's first
 * cards (privacyDialogOpen): a minute into reading it would interrupt the card
 * being read. A nudge waits for the minute of reading.
 */
export function visitChoiceDue({ privacyOwed, dwellDone }: { privacyOwed: boolean; dwellDone: boolean }) {
  return privacyOwed || dwellDone;
}

/**
 * One visit's notices, as NudgeHost keeps them: the notice picked (`null` for
 * none), whether the visit's choice has been made, whether the reader hid the
 * privacy notice for this visit, whether the minute of reading has passed, and
 * which minute of reading that is, counted from 0 (Hide for now starts another).
 */
export interface VisitNotices { picked: string | null; choiceMade: boolean; privacyHidden: boolean; dwellDone: boolean; readingMinute: number }

export const VISIT_START: VisitNotices = { picked: null, choiceMade: false, privacyHidden: false, dwellDone: false, readingMinute: 0 };

/**
 * The visit once minute `readingMinute` of reading has passed (NudgeHost's
 * timer). A timer started for an earlier minute ends nothing: the minute was
 * started over by Hide for now, and the nudge it lets follow waits a whole
 * minute from the hide, also when the reader hid the notice before the first
 * minute was up.
 */
export function readingMinutePassed(visit: VisitNotices, readingMinute: number): VisitNotices {
  if (visit.readingMinute !== readingMinute || visit.dwellDone) return visit;
  return { ...visit, dwellDone: true };
}

/**
 * The visit with its notice chosen once that is due (visitChoiceDue), or
 * `visit` itself while it is not, or was already made: one choice per visit, so
 * a re-render, a navigation or the email health answer landing cannot start a
 * second one. Each notice is a candidate only where its gate is open
 * (visitChoiceGates), so a route or state where only the other one may be
 * chosen does not spend the visit's choice. A privacy notice hidden this visit
 * is no longer a candidate.
 */
export function chooseVisitNotice(visit: VisitNotices, { gates, privacyOwed, eligible, dismissed, random }: { gates: { nudge: boolean; privacy: boolean }; privacyOwed: boolean; eligible?: string[]; dismissed?: string[]; random?: () => number }): VisitNotices {
  const owed = gates.privacy && privacyOwed && !visit.privacyHidden;
  if (visit.choiceMade || !visitChoiceDue({ privacyOwed: owed, dwellDone: gates.nudge && visit.dwellDone })) return visit;
  return { ...visit, choiceMade: true, picked: pickVisitNotice({ privacyOwed: owed, eligible, dismissed, random }) };
}

/**
 * The visit after the reader answers the privacy notice. Got it spends the
 * visit's one notice, so a nudge waits for the next visit. Hide for now (or
 * Escape, a press outside, the X) puts the notice away for this visit and opens
 * the choice again with the minute of reading started over: a nudge such as
 * email being down may then follow a minute later, so a reader who keeps
 * hiding the notice is still told.
 */
export function answerPrivacyNotice(visit: VisitNotices, answer: 'got-it' | 'hide'): VisitNotices {
  if (visit.picked !== PRIVACY_NOTICE_ID) return visit;
  if (answer === 'got-it') return { ...visit, picked: null };
  return { picked: null, choiceMade: false, privacyHidden: true, dwellDone: false, readingMinute: visit.readingMinute + 1 };
}

/**
 * What, if anything, is wrong with email — as reported by the service itself.
 *
 * `code` is the discriminant, not `configured`: the context's initial state is
 * `{ configured: false, available: false, code: null }`, which is what "we have
 * not heard back" looks like. Reading that as a fault would announce an outage
 * to everyone on every cold load, including when the health request never
 * lands. And a service that says it is available is believed, whatever else it
 * reports. A check the Worker did not run leaves the status unknown
 * (`emailServiceState`), which is not a fault either.
 */
export function emailNudgeProblem({ loading = false, health = {} }: { loading?: boolean; health?: { code?: string | null; available?: boolean; configured?: boolean } | null } = {}): 'not-configured' | 'unavailable' | null {
  if (loading || !health?.code || emailServiceState(health) !== 'down') return null;
  return health.code === 'EMAIL_NOT_CONFIGURED' ? 'not-configured' : 'unavailable';
}
