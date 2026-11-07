import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUDGE_DISMISSED_KEY,
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  VISIT_START,
  adoptAccountNotice,
  answerPrivacyNotice,
  chooseVisitNotice,
  emailNudgeProblem,
  feedCardsStay,
  forgetPrivacyNotice,
  noticeOnScreen,
  pickNudge,
  pickVisitNotice,
  privacyCardsCover,
  privacyDialogOpen,
  privacyNoticeOwed,
  privacyNoticeStatus,
  readDismissedNudges,
  readPrivacyNoticeAck,
  readingMinutePassed,
  recordPrivacyNoticeShown,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
  visitChoiceDue,
  visitChoiceGates,
  visitReaderReady,
  type AccountNoticeRecord,
} from './nudges.ts';
import { setCardsCovered, trackVisibleTime } from './visible-time.ts';
import { FEED_DISPLAY_STATES, FEED_EMPTY, getFeedDisplayState } from './feed-loading-state.ts';
import { PRIVACY_NOTICE_BASELINE_VERSION, PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../legal/privacy-policy.ts';

const fakeStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => map.set(key, String(value)),
    removeItem: (key: string) => map.delete(key),
  };
};

const brokenStorage = () => ({
  getItem() { throw new Error('storage disabled'); },
  setItem() { throw new Error('storage disabled'); },
  removeItem() { throw new Error('storage disabled'); },
});

test('lo descartado se lee como una lista de ids, y la basura no rompe nada', () => {
  assert.deepEqual(readDismissedNudges(fakeStorage()), []);
  assert.deepEqual(readDismissedNudges(fakeStorage({ [NUDGE_DISMISSED_KEY]: '["open-source"]' })), ['open-source']);
  assert.deepEqual(readDismissedNudges(fakeStorage({ [NUDGE_DISMISSED_KEY]: 'no soy json' })), []);
  assert.deepEqual(readDismissedNudges(fakeStorage({ [NUDGE_DISMISSED_KEY]: '{"open-source":true}' })), [], 'un objeto no es una lista');
  assert.deepEqual(readDismissedNudges(fakeStorage({ [NUDGE_DISMISSED_KEY]: '["ok", 7, null]' })), ['ok'], 'solo ids de texto');
  assert.deepEqual(readDismissedNudges(brokenStorage()), [], 'una ventana privada no puede tumbar el arranque');
});

test('descartar añade el id una sola vez y devuelve la lista que vale de ahora en adelante', () => {
  const storage = fakeStorage();
  assert.deepEqual(rememberNudgeDismissal('open-source', storage), ['open-source']);
  assert.deepEqual(rememberNudgeDismissal('open-source', storage), ['open-source'], 'sin duplicados');
  assert.deepEqual(rememberNudgeDismissal('email-down', storage), ['open-source', 'email-down']);
  assert.deepEqual(JSON.parse(storage.getItem(NUDGE_DISMISSED_KEY)!), ['open-source', 'email-down']);
});

test('si el navegador no deja escribir, el aviso se apaga igual en esta visita', () => {
  assert.deepEqual(rememberNudgeDismissal('open-source', brokenStorage()), ['open-source']);
});

test('se elige entre los pendientes, y solo entre ellos', () => {
  const eligible = ['open-source', 'email-down'];
  assert.equal(pickNudge({ eligible, dismissed: [], random: () => 0 }), 'open-source');
  assert.equal(pickNudge({ eligible, dismissed: [], random: () => 0.99 }), 'email-down');
  assert.equal(pickNudge({ eligible, dismissed: ['open-source'], random: () => 0 }), 'email-down');
  assert.equal(pickNudge({ eligible, dismissed: ['open-source'], random: () => 0.99 }), 'email-down');
});

test('sin nada pendiente no se enseña nada', () => {
  assert.equal(pickNudge({ eligible: [], dismissed: [], random: () => 0 }), null);
  assert.equal(pickNudge({ eligible: ['open-source'], dismissed: ['open-source'], random: () => 0 }), null);
  assert.equal(pickNudge({ eligible: ['open-source'], dismissed: ['de-otra-versión'], random: () => 0 }), 'open-source', 'un id que ya no existe no estorba');
  assert.equal(pickNudge({}), null, 'sin argumentos tampoco revienta');
});

/**
 * El silencio no es un problema. El estado inicial del contexto de correo es
 * literalmente `configured: false`, así que un predicado ingenuo enseñaría el
 * aviso a todo el mundo mientras la petición de salud está en el aire —o si
 * nunca llega— y estaría afirmando algo que nadie ha comprobado.
 */
test('el aviso de correo solo sale cuando el servicio ha nombrado el problema', () => {
  assert.equal(emailNudgeProblem({ loading: true, health: { configured: false, available: false, code: null } }), null);
  assert.equal(emailNudgeProblem({ loading: false, health: { configured: false, available: false, code: null } }), null, 'el estado por defecto no es una respuesta');
  assert.equal(emailNudgeProblem({ loading: false, health: {} }), null);
  assert.equal(emailNudgeProblem({}), null);
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: false, available: false, code: 'EMAIL_NOT_CONFIGURED' } }),
    'not-configured',
  );
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: true, available: false, code: 'EMAIL_PROVIDER_UNAVAILABLE' } }),
    'unavailable',
  );
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: true, available: false, code: 'EMAIL_SENDER_NOT_VERIFIED' } }),
    'unavailable',
    'cualquier otro código roto se cuenta como no disponible',
  );
});

test('a health check the Worker refused to run announces no email outage', () => {
  // `/health/email` answers this code without asking Resend once the window's
  // live probes are spent, so nothing is known about the provider.
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: false, available: false, code: 'HEALTH_PROBE_LIMITED' } }),
    null,
  );
});

test('a quota ledger that is missing or failing announces no email outage', () => {
  // With no ledger to reserve a probe in, `/health/email` answers this code
  // without asking Resend.
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: false, available: false, code: 'PROVIDER_QUOTA_NOT_CONFIGURED' } }),
    null,
  );
});

test('un servicio sano no tiene nada que avisar', () => {
  assert.equal(emailNudgeProblem({ loading: false, health: { configured: true, available: true, code: null } }), null);
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: true, available: true, code: 'EMAIL_RATE_LIMITED' } }),
    null,
    'si el servicio dice que está disponible, no se le contradice',
  );
});

test('los tiempos son los acordados', () => {
  assert.equal(NUDGE_DWELL_MS, 60_000, 'un minuto leyendo antes de pedir nada');
});

test('a reader who has not been shown this policy version is owed the notice', () => {
  const version = '2026-10-22';
  const effectiveAt = '2026-10-22T05:00:00Z';
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: null, signedIn: true }), true, 'an account with no creation date');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: null, signedIn: false }), false, 'a guest cannot be told apart from a first-time visitor');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: '2026-10-20', signedIn: true }), true, 'shown an earlier version');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: '2026-10-22', signedIn: true }), false, 'shown this one');
  assert.equal(
    privacyNoticeOwed({ version: '2026-10-22.2', effectiveAt, acknowledged: '2026-10-22', signedIn: true }),
    true,
    'a second change on the same day is news to whoever was shown the first',
  );
});

test('being shown a later version settles an earlier one, and a suffix sorts as a number', () => {
  const owed = (version: string, acknowledged: string | null) => privacyNoticeOwed({ version, effectiveAt: '2026-10-25T05:00:00Z', acknowledged, signedIn: true });
  assert.equal(owed('2026-10-25', '2026-11-05'), false, 'a tab on an older bundle');
  assert.equal(owed('2026-10-25.2', '2026-10-26'), false, 'a later day covers an earlier day with a suffix');
  assert.equal(owed('2026-10-25.2', '2026-10-25.10'), false, '.10 is after .2');
  assert.equal(owed('2026-10-25.10', '2026-10-25.2'), true, '.2 is before .10');
  assert.equal(owed('2026-10-25.2', '2026-10-25'), true, 'no suffix is before .2');
  assert.equal(owed('2026-10-25', '2026-10-25.2'), false, '.2 covers the day itself');
  assert.equal(owed('2026-10-25', 'garbage'), true, 'a stored value that is no version covers nothing');
});

test('a tab on an older bundle does not overwrite a newer version already shown', () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('reader-a', '2026-11-05', storage);
  rememberPrivacyNotice('reader-a', '2026-10-25', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-11-05');
  rememberPrivacyNotice('reader-a', '2026-11-05.2', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-11-05.2', 'a newer one is stored');
  rememberPrivacyNotice('reader-a', '2026-11-05.10', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-11-05.10');
  rememberPrivacyNotice('reader-a', '2026-11-05.9', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-11-05.10');
  storage.setItem('papertok_privacyNotice:reader-b', 'garbage');
  rememberPrivacyNotice('reader-b', '2026-10-25', storage);
  assert.equal(readPrivacyNoticeAck('reader-b', storage), '2026-10-25', 'a stored value that is no version is replaced');
});

test('an account opened at or after the moment of the change is not told about it', () => {
  const version = '2026-10-22';
  const effectiveAt = '2026-10-22T05:00:00Z';
  const owed = (accountCreated: string | null) => privacyNoticeOwed({ version, effectiveAt, acknowledged: null, accountCreated, signedIn: true });
  assert.equal(owed('Tue, 20 Oct 2026 09:00:00 GMT'), true);
  assert.equal(owed('Wed, 21 Oct 2026 23:59:00 GMT'), true, 'the day before is an account that read the old policy');
  assert.equal(owed('Thu, 22 Oct 2026 04:59:59 GMT'), true, 'the same day but before the change went live read the old policy');
  assert.equal(owed('2026-10-22T04:59:59.999Z'), true, 'a millisecond before');
  assert.equal(owed('Thu, 22 Oct 2026 05:00:00 GMT'), false, 'the instant it took effect started under it');
  assert.equal(owed('Thu, 22 Oct 2026 08:00:00 GMT'), false, 'later that day started under it');
  assert.equal(owed('Thu, 22 Oct 2026 06:30:00 +0200'), true, 'an offset is read as the instant it names: 04:30Z');
  assert.equal(owed('Thu, 22 Oct 2026 07:00:00 +0200'), false, 'an offset is read as the instant it names: 05:00Z');
  assert.equal(owed('not a date'), true, 'an unknown start is told');
  assert.equal(owed(null), true, 'a missing start is told');
  assert.equal(
    privacyNoticeOwed({ version: '2026-11-05', effectiveAt: '2026-11-05T05:00:00Z', acknowledged: '2026-10-22', accountCreated: 'Fri, 23 Oct 2026 08:00:00 GMT', signedIn: true }),
    true,
    'and is told about the next change',
  );
});

test('an account created after an earlier change on the same UTC day is still told of a later one', () => {
  // Boundary times come from the shipped instant, so the next policy change moves them.
  const effective = Date.parse(PRIVACY_POLICY_EFFECTIVE_AT);
  const HOUR = 3_600_000;
  const owed = (offsetMs: number) =>
    privacyNoticeOwed({
      version: PRIVACY_POLICY_VERSION,
      effectiveAt: PRIVACY_POLICY_EFFECTIVE_AT,
      acknowledged: null,
      accountCreated: new Date(effective + offsetMs).toUTCString(),
      signedIn: true,
    });
  assert.equal(owed(-14 * HOUR), true, '14 hours before this change');
  assert.equal(owed(-1000), true, 'a second before this change');
  assert.equal(owed(0), false, 'the instant of this change');
});

test('each account is told separately', () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('reader-a', '2026-10-22', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-10-22');
  assert.equal(readPrivacyNoticeAck('reader-b', storage), null, 'another account on this device');
});

test('a deleted account leaves nothing of its uid behind, and no other account is touched', () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('reader-a', '2026-10-22', storage);
  rememberPrivacyNotice('reader-b', '2026-10-22', storage);
  forgetPrivacyNotice('reader-a', storage);
  assert.deepEqual([...storage.map.keys()], ['papertok_privacyNotice:reader-b']);
  assert.doesNotThrow(() => forgetPrivacyNotice('reader-a', brokenStorage()));
});

test('blocked storage leaves the notice owed instead of failing', () => {
  assert.equal(readPrivacyNoticeAck('reader-a', brokenStorage()), null);
  assert.doesNotThrow(() => rememberPrivacyNotice('reader-a', '2026-10-22', brokenStorage()));
});

test('a privacy change owed to the reader takes the visit before any nudge', () => {
  assert.equal(
    pickVisitNotice({ privacyOwed: true, eligible: ['email-down'], dismissed: [] }),
    PRIVACY_NOTICE_ID,
    'the email nudge waits until the notice is answered',
  );
  assert.equal(pickVisitNotice({ privacyOwed: true }), PRIVACY_NOTICE_ID, 'also when no nudge is pending');
  assert.equal(pickVisitNotice({ privacyOwed: false, eligible: ['email-down'], dismissed: [] }), 'email-down');
  assert.equal(pickVisitNotice({ privacyOwed: false, eligible: ['email-down'], dismissed: ['email-down'] }), null, 'a dismissed nudge stays dismissed');
  assert.equal(pickVisitNotice({ privacyOwed: false }), null);
});

test('a privacy change owed to the reader is chosen on arrival, a nudge only after the minute of reading', () => {
  // A dialog a minute in would interrupt the card being read.
  assert.equal(visitChoiceDue({ privacyOwed: true, dwellDone: false }), true);
  assert.equal(visitChoiceDue({ privacyOwed: true, dwellDone: true }), true);
  assert.equal(visitChoiceDue({ privacyOwed: false, dwellDone: false }), false, 'the email nudge waits');
  assert.equal(visitChoiceDue({ privacyOwed: false, dwellDone: true }), true);
});

// A signed-in reader at /feed, where either notice may be chosen.
const ON_FEED = { nudge: true, privacy: true };

test('closing the privacy dialog any way spends the visit\'s turn, so a nudge waits for the next visit', () => {
  const facts = { gates: ON_FEED, privacyOwed: true, eligible: ['email-down'], dismissed: [] };
  const arrived = chooseVisitNotice(VISIT_START, facts);
  assert.equal(arrived.picked, PRIVACY_NOTICE_ID, 'the notice owed is chosen on arrival');
  assert.equal(chooseVisitNotice(readingMinutePassed(arrived), facts).picked, PRIVACY_NOTICE_ID, 'while it is on screen the minute passing changes nothing');

  // Got it, Escape, a press outside and the X all reach onClose (privacy-notice.tsx).
  for (const dwellDone of [false, true]) {
    const closed = answerPrivacyNotice({ ...arrived, dwellDone });
    assert.equal(closed.picked, null, 'put away');
    assert.equal(chooseVisitNotice(readingMinutePassed(closed), facts).picked, null, `no nudge follows this visit (the minute had${dwellDone ? '' : ' not'} passed)`);
  }
  const next = chooseVisitNotice(readingMinutePassed(VISIT_START), { ...facts, privacyOwed: false });
  assert.equal(next.picked, 'email-down', 'the next visit picks the nudge after its minute of reading');
  assert.equal(answerPrivacyNotice(next), next, 'a late close of the dialog does not take the nudge away');
});

test('the privacy notice is shown only to a signed-in reader on the feed, and returns when they come back', () => {
  const on = (picked: string | null, signedIn: boolean, pathname: string) => noticeOnScreen({ picked, signedIn, pathname, privacyOwed: true });
  assert.equal(on(PRIVACY_NOTICE_ID, true, '/feed'), PRIVACY_NOTICE_ID);
  for (const pathname of ['/feed/', '/feed//', '/Feed', '/FEED', '/Feed/']) {
    assert.equal(on(PRIVACY_NOTICE_ID, true, pathname), PRIVACY_NOTICE_ID, `the feed route also matches ${pathname}`);
  }
  for (const pathname of ['/search', '/lists', '/explore', '/settings', '/paper/abc', '/feed/x', '/']) {
    assert.equal(on(PRIVACY_NOTICE_ID, true, pathname), null, `a paper may be open as a modal on ${pathname}`);
  }
  assert.equal(on(PRIVACY_NOTICE_ID, false, '/feed'), null, 'signed out');
  assert.equal(on(null, true, '/feed'), null, 'nothing picked');
});

test('the email nudge, once picked, stays on every route until it is dismissed', () => {
  for (const pathname of ['/feed', '/search', '/lists', '/settings', '/paper/abc', '/']) {
    assert.equal(noticeOnScreen({ picked: 'email-down', signedIn: true, pathname, privacyOwed: true }), 'email-down', pathname);
  }
});

test('the email nudge is chosen where it was before the privacy notice: at /feed exactly, also while the profile read has failed', () => {
  const reader = { user: { uid: 'u1' }, loading: false, onboardingComplete: true };
  const afterTheMinute = (pathname: string, over: Partial<Parameters<typeof visitChoiceGates>[0]> = {}) => chooseVisitNotice(
    { ...VISIT_START, dwellDone: true },
    { gates: visitChoiceGates({ ...reader, ...over, pathname }), privacyOwed: false, eligible: ['email-down'], dismissed: [] },
  );
  assert.equal(afterTheMinute('/feed').picked, 'email-down');
  // The gates ask nothing of the profile read, so a failed one (the feed route's retry screen) does not hold the nudge back.
  assert.equal(visitChoiceGates({ ...reader, pathname: '/settings' }).signedIn, true, 'its minute runs on any route');
  for (const pathname of ['/feed/', '/Feed', '/FEED', '/search', '/settings', '/']) {
    assert.equal(afterTheMinute(pathname).choiceMade, false, `not chosen on ${pathname}, so /feed can still choose it`);
  }
  assert.equal(afterTheMinute('/feed', { loading: true }).choiceMade, false, 'still loading');
  assert.equal(afterTheMinute('/feed', { onboardingComplete: false }).choiceMade, false, 'not onboarded');
  assert.equal(afterTheMinute('/feed', { user: null }).choiceMade, false, 'signed out');
  assert.equal(visitChoiceGates({ ...reader, user: null, pathname: '/feed' }).signedIn, false, 'and its minute does not run');
});

test('the privacy notice is chosen on every spelling of the feed route, and a nudge does not take its turn there', () => {
  const reader = { user: { uid: 'u1' }, loading: false, onboardingComplete: true };
  for (const pathname of ['/feed', '/feed/', '/Feed', '/FEED']) {
    const gates = visitChoiceGates({ ...reader, pathname });
    assert.equal(chooseVisitNotice(VISIT_START, { gates, privacyOwed: true, eligible: ['email-down'] }).picked, PRIVACY_NOTICE_ID, pathname);
  }
  assert.equal(chooseVisitNotice(VISIT_START, { gates: visitChoiceGates({ ...reader, pathname: '/settings' }), privacyOwed: true }).choiceMade, false, 'off the feed nothing is chosen');
});

test('the privacy dialog is not shown while the profile could not be loaded, and it is once a retry loads it', () => {
  const user = { uid: 'u1' };
  const ready = (over: Partial<Parameters<typeof visitReaderReady>[0]> = {}) => visitReaderReady({ user, loading: false, onboardingComplete: true, profileLoadError: null, ...over });
  assert.equal(ready(), true);
  // The stored onboarding marks it complete before the profile read fails, and the feed route shows its retry screen.
  assert.equal(ready({ profileLoadError: 'PROFILE_LOAD_FAILED' }), false, 'the profile read failed');
  assert.equal(ready({ loading: true }), false, 'still loading');
  assert.equal(ready({ onboardingComplete: false }), false, 'not onboarded');
  assert.equal(ready({ user: null }), false, 'signed out');
  // Chosen on arrival all the same, so it keeps the visit's turn and no nudge is picked over the retry screen.
  const arrived = chooseVisitNotice(VISIT_START, { gates: visitChoiceGates({ user, loading: false, onboardingComplete: true, pathname: '/feed' }), privacyOwed: true, eligible: ['email-down'] });
  assert.equal(arrived.picked, PRIVACY_NOTICE_ID);
  assert.equal(noticeOnScreen({ picked: arrived.picked, signedIn: ready({ profileLoadError: 'PROFILE_LOAD_FAILED' }), pathname: '/feed', privacyOwed: true }), null);
  // Off screen the dialog closes, and it opens again when Try again brings the feed back.
  assert.equal(privacyDialogOpen({ shown: false, cardsShown: true, modalOpen: false, tabVisible: true, wasOpen: true }), false);
  assert.equal(noticeOnScreen({ picked: PRIVACY_NOTICE_ID, signedIn: ready(), pathname: '/feed', privacyOwed: true }), PRIVACY_NOTICE_ID);
  assert.equal(privacyDialogOpen({ shown: true, cardsShown: true, modalOpen: false, tabVisible: true, wasOpen: false }), true);
});

test('the privacy dialog waits for a hidden tab to be visible and stays open if the tab is hidden after', () => {
  const open = (tabVisible: boolean, wasOpen: boolean) => privacyDialogOpen({ shown: true, cardsShown: true, modalOpen: false, tabVisible, wasOpen });
  assert.equal(open(false, false), false);
  assert.equal(open(true, false), true);
  assert.equal(open(false, true), true);
});

// Whether the privacy dialog is open after each render, as NudgeHost feeds it:
// `cardsShown` is whether the feed has cards (true unless a step says not), and
// `modalOpen` whether a modal is on the page while the dialog is closed.
const dialogSteps = (events: Array<{ shown: boolean; cardsShown?: boolean; modalOpen: boolean }>) => {
  let wasOpen = false;
  return events.map(({ cardsShown = true, ...event }) => (wasOpen = privacyDialogOpen({ ...event, cardsShown, tabVisible: true, wasOpen })));
};

test('the privacy dialog opens once the feed shows its first cards, never over its loading or error screen', () => {
  // NudgeHost reads cards as the feed context having papers, which is exactly
  // when FeedContainer leaves its skeleton, veil, error and empty screens.
  for (const state of [{ loading: true }, { loading: true, showLoader: true }, { initialLoadPending: true }, { error: 'FEED_LOAD_FAILED' }, { error: 'FEED_LOAD_FAILED', autoRetryPending: true }, { error: FEED_EMPTY }, { hasSourceEmptyState: true }]) {
    assert.notEqual(getFeedDisplayState({ hasPapers: false, ...state }), FEED_DISPLAY_STATES.FEED, JSON.stringify(state));
    assert.equal(getFeedDisplayState({ hasPapers: true, ...state }), FEED_DISPLAY_STATES.FEED, `${JSON.stringify(state)} with papers`);
  }
  assert.deepEqual(
    dialogSteps([
      { shown: true, cardsShown: false, modalOpen: false },
      { shown: true, cardsShown: false, modalOpen: false },
      { shown: true, cardsShown: true, modalOpen: false },
    ]),
    [false, false, true],
    'a cold load: the first page, or the error and its Try again, comes before the dialog',
  );
  assert.deepEqual(
    dialogSteps([
      { shown: true, cardsShown: false, modalOpen: true },
      { shown: true, cardsShown: true, modalOpen: true },
      { shown: true, cardsShown: true, modalOpen: false },
    ]),
    [false, false, true],
    'cards under another dialog: it also waits for that one',
  );
  assert.deepEqual(
    dialogSteps([
      { shown: true, cardsShown: false, modalOpen: false },
      { shown: false, cardsShown: true, modalOpen: false },
      { shown: true, cardsShown: true, modalOpen: false },
    ]),
    [false, false, true],
    'the reader left the loading feed and came back to its cards',
  );
  assert.deepEqual(
    dialogSteps([
      { shown: true, cardsShown: true, modalOpen: false },
      { shown: true, cardsShown: false, modalOpen: false },
    ]),
    [true, true],
    'once open it does not depend on the cards',
  );
});

test('the privacy dialog never opens over another dialog: it waits for that one to close', () => {
  assert.deepEqual(
    dialogSteps([
      { shown: true, modalOpen: true },
      { shown: true, modalOpen: true },
      { shown: true, modalOpen: false },
    ]),
    [false, false, true],
    'another modal still open, or closing, as the reader reaches the feed',
  );
  assert.deepEqual(dialogSteps([{ shown: true, modalOpen: false }]), [true], 'nothing else open: it opens on arrival');
});

test('once open, the privacy dialog stays open until it is closed or the reader leaves the feed, and when shown again it waits as before', () => {
  assert.deepEqual(
    dialogSteps([
      { shown: true, modalOpen: false },
      { shown: true, modalOpen: true },
      { shown: true, modalOpen: false },
    ]),
    [true, true, true],
    'a modal opened over it does not close it',
  );
  assert.deepEqual(
    dialogSteps([
      { shown: true, modalOpen: false },
      { shown: false, modalOpen: false },
    ]),
    [true, false],
    'Got it, Escape, the close button or leaving the feed',
  );
  assert.deepEqual(
    dialogSteps([
      { shown: true, modalOpen: false },
      { shown: false, modalOpen: false },
      { shown: true, modalOpen: true },
      { shown: true, modalOpen: false },
    ]),
    [true, false, false, true],
    'shown again (its record could not be stored), it again waits for any other dialog',
  );
});

test('the cards under the privacy dialog stay when it is answered, and leave with the feed when it closes for any other reason', () => {
  for (const pathname of ['/feed', '/feed/', '/Feed', '/FEED']) {
    assert.equal(feedCardsStay({ readerReady: true, pathname }), true, `answered on ${pathname}`);
  }
  for (const pathname of ['/settings', '/settings/profile', '/following', '/lists', '/search', '/paper/abc', '/feed/x', '/onboarding', '/']) {
    assert.equal(feedCardsStay({ readerReady: true, pathname }), false, `the reader went to ${pathname}`);
  }
  const user = { uid: 'u1' };
  for (const [over, why] of [[{ user: null }, 'signed out'], [{ profileLoadError: 'PROFILE_LOAD_FAILED' }, 'the profile retry screen'], [{ loading: true }, 'auth answering again'], [{ onboardingComplete: false }, 'sent to the onboarding']] as const) {
    const readerReady = visitReaderReady({ user, loading: false, onboardingComplete: true, profileLoadError: null, ...over });
    assert.equal(feedCardsStay({ readerReady, pathname: '/feed' }), false, why);
  }
});

test('a card under the privacy dialog counts again when it is answered, and reports nothing while a feed that closed it leaves', (t) => {
  t.after(() => setCardsCovered(false));
  // One card read for 2 s, then NudgeHost's cover as the dialog opens and closes, then 300 ms more.
  const readThenClose = (closedOn: { readerReady: boolean; pathname: string }) => {
    let time = 0;
    const reported: number[] = [];
    const card = trackVisibleTime(Object.assign(new EventTarget(), { hidden: false }), seconds => reported.push(seconds), () => time);
    card.setInView(true);
    time += 2000;
    setCardsCovered(...privacyCardsCover({ dialogOpen: true, cardsStay: feedCardsStay({ readerReady: true, pathname: '/feed' }) }));
    time += 20_000;
    setCardsCovered(...privacyCardsCover({ dialogOpen: false, cardsStay: feedCardsStay(closedOn) }));
    time += 300;
    card.stop();
    setCardsCovered(false);
    return reported;
  };
  for (const pathname of ['/feed', '/Feed', '/feed/']) {
    assert.deepEqual(readThenClose({ readerReady: true, pathname }), [2.3], `answered on ${pathname}, here or in another tab`);
  }
  for (const [closedOn, why] of [
    [{ readerReady: true, pathname: '/settings' }, 'the reader went to another route'],
    [{ readerReady: false, pathname: '/feed' }, 'signed out or sent to the profile retry screen'],
  ] as const) {
    assert.deepEqual(readThenClose(closedOn), [2], `${why}: no skip or dwell for the 300 ms exit`);
  }
});

// A version after the shipped baseline, as the next policy change will be: for it the account's own record
// decides. The boundaries come from these values, so the next real change moves nothing here.
const NEXT_VERSION = '2026-12-01';
const NEXT_EFFECTIVE_AT = '2026-12-01T09:00:00Z';
const HOUR = 3_600_000;
type NoticeUser = { uid: string; metadata?: { creationTime?: string | null } } | null;
type NoticeStorage = ReturnType<typeof fakeStorage> | ReturnType<typeof brokenStorage>;
const createdBefore = (uid: string, offsetMs = -24 * HOUR, effectiveAt = NEXT_EFFECTIVE_AT) =>
  ({ uid, metadata: { creationTime: new Date(Date.parse(effectiveAt) + offsetMs).toUTCString() } });

interface NoticeFacts { user: NoticeUser; storage?: NoticeStorage; account?: AccountNoticeRecord | null; signedIn?: boolean; version?: string; effectiveAt?: string }

const statusOf = ({ user, storage = fakeStorage(), account = null, signedIn = true, version = NEXT_VERSION, effectiveAt = NEXT_EFFECTIVE_AT }: NoticeFacts) =>
  privacyNoticeStatus({ user, signedIn, version, effectiveAt, baseline: PRIVACY_NOTICE_BASELINE_VERSION, account, storage });

// A visit's arrival on /feed with no other dialog open, from the parts NudgeHost calls in this order. The
// reader then closes the dialog (Got it, the X, Escape, a press outside, Back or closing the tab), which
// writes nothing more. `saved` is what was handed to the account's record.
const arrive = ({ cardsShown = true, tabVisible = true, ...facts }: NoticeFacts & { cardsShown?: boolean; tabVisible?: boolean }) => {
  const { user, signedIn = true, version = NEXT_VERSION } = facts;
  const saved: [string, string][] = [];
  const status = statusOf(facts);
  const privacyOwed = status === 'owed';
  const gates = visitChoiceGates({ user, loading: false, onboardingComplete: signedIn, pathname: '/feed' });
  const { picked } = chooseVisitNotice(VISIT_START, { gates, privacyOwed, eligible: ['email-down'] });
  const shown = noticeOnScreen({ picked, signedIn, pathname: '/feed', privacyOwed }) === PRIVACY_NOTICE_ID;
  const dialogOpen = privacyDialogOpen({ shown, cardsShown, modalOpen: false, tabVisible, wasOpen: false });
  recordPrivacyNoticeShown({
    uid: user?.uid,
    dialogOpen,
    version,
    storage: facts.storage,
    saveToAccount: (uid, shownVersion) => { saved.push([uid, shownVersion]); return Promise.resolve(); },
  });
  return { status, dialogOpen, saved };
};

test('the 2026-11-07 notice is shown to no account any more, on any browser, with or without a record of it', () => {
  // Pablo, 2026-11-07 (ENG-196): it had gone out that morning, remembered only by each browser.
  const version = '2026-11-07';
  const effectiveAt = '2026-11-07T23:59:59Z';
  const readers = [createdBefore('a-month-old', -30 * 24 * HOUR, effectiveAt), createdBefore('an-hour-old', -HOUR, effectiveAt), { uid: 'unknown-start' }];
  for (const user of readers) {
    for (const account of [null, { uid: user.uid, version: null }]) {
      const storage = fakeStorage();
      const visit = arrive({ user, storage, account, version, effectiveAt });
      const which = `${user.uid}, account record ${account ? 'empty' : 'not read'}`;
      assert.equal(visit.status, 'settled', `${which}: settled without asking the account`);
      assert.equal(visit.dialogOpen, false, `${which}: a new browser stays shut`);
      assert.equal(storage.map.size, 0, `${which}: nothing is written to this browser`);
      assert.deepEqual(visit.saved, [], `${which}: nor to the account`);
    }
  }
  const reader = createdBefore('reader', -HOUR, effectiveAt);
  assert.equal(statusOf({ user: reader, storage: fakeStorage({ 'papertok_privacyNotice:reader': version }), version, effectiveAt }), 'settled', 'a browser that showed it');
  assert.equal(statusOf({ user: reader, storage: brokenStorage(), version, effectiveAt }), 'settled', 'a browser that keeps nothing');
  assert.equal(statusOf({ user: reader, version: `${version}.2`, effectiveAt }), 'ask-account', 'a second change that day is not covered');
});

test('a later version waits for the account record, opens once, and the record keeps it shut on every other browser', () => {
  const reader = createdBefore('reader-a');
  const phone = fakeStorage();
  const pending = arrive({ user: reader, storage: phone });
  assert.equal(pending.status, 'ask-account', 'a browser with no copy asks the account');
  assert.equal(pending.dialogOpen, false, 'and nothing opens before it answers, so nothing has to be taken back');
  assert.equal(phone.map.size, 0, 'nothing is recorded before it opens');

  const account = { uid: reader.uid, version: PRIVACY_NOTICE_BASELINE_VERSION };
  assert.equal(arrive({ user: reader, storage: phone, account, cardsShown: false }).dialogOpen, false, 'a feed without cards yet');
  assert.equal(arrive({ user: reader, storage: phone, account, tabVisible: false }).dialogOpen, false, 'a tab in the background');
  assert.equal(phone.map.size, 0, 'neither records anything');

  const first = arrive({ user: reader, storage: phone, account });
  assert.equal(first.status, 'owed', 'the account was shown only the baseline');
  assert.equal(first.dialogOpen, true);
  assert.deepEqual(first.saved, [[reader.uid, NEXT_VERSION]], 'recorded in the account as it opens');
  assert.equal(readPrivacyNoticeAck(reader.uid, phone), NEXT_VERSION, 'and in this browser');
  assert.equal(arrive({ user: reader, storage: phone }).status, 'settled', 'a reload is settled by this browser, without asking the account');

  const laptop = fakeStorage();
  const elsewhere = arrive({ user: reader, storage: laptop, account: adoptAccountNotice(reader.uid, NEXT_VERSION, laptop) });
  assert.equal(elsewhere.dialogOpen, false, 'another browser or device reads the account and stays shut');
  assert.deepEqual(elsewhere.saved, [], 'and writes nothing to it');
  assert.equal(arrive({ user: reader, storage: laptop }).status, 'settled', 'it keeps the answer, so its next visit does not ask again');
  const empty = fakeStorage();
  assert.equal(statusOf({ user: reader, storage: empty, account: adoptAccountNotice(reader.uid, null, empty) }), 'owed', 'an account with no record');
  assert.equal(empty.map.size, 0, 'leaves nothing in this browser until the dialog opens');
  assert.equal(arrive({ user: reader, storage: fakeStorage(), version: `${NEXT_VERSION}.2`, account: { uid: reader.uid, version: NEXT_VERSION } }).status, 'owed', 'the version after it is still told');
  assert.equal(arrive({ user: createdBefore('reader-b'), storage: phone, account: { uid: 'reader-b', version: null } }).dialogOpen, true, 'another account on the same browser is told too');
});

test('closing the dialog any way never brings it back: not this visit, not after a reload, also when this browser keeps nothing', () => {
  const reader = createdBefore('reader-a');
  const blocked = brokenStorage();
  const opened = arrive({ user: reader, storage: blocked, account: { uid: reader.uid, version: null } });
  assert.equal(opened.dialogOpen, true);
  assert.deepEqual(opened.saved, [[reader.uid, NEXT_VERSION]], 'the account is told although this browser keeps nothing');
  // Still owed in memory, since this browser could not keep it. Got it, the X, Escape and a press outside
  // all reach onClose (privacy-notice.tsx), which spends the visit's one notice.
  const facts = { gates: ON_FEED, privacyOwed: true, eligible: ['email-down'] };
  const closed = answerPrivacyNotice(chooseVisitNotice(VISIT_START, facts));
  assert.equal(chooseVisitNotice(readingMinutePassed(closed), facts).picked, null, 'not picked again this visit, back from another route included');
  assert.equal(noticeOnScreen({ picked: closed.picked, signedIn: true, pathname: '/feed', privacyOwed: true }), null);
  assert.equal(arrive({ user: reader, storage: blocked, account: { uid: reader.uid, version: NEXT_VERSION } }).dialogOpen, false, 'after a reload the account record keeps it shut');
});

test('a new account, one still onboarding and a guest are not told, and their account is not asked', () => {
  for (const offsetMs of [0, 1000, 10 * HOUR, 28 * HOUR]) {
    const visit = arrive({ user: createdBefore('new', offsetMs), storage: fakeStorage() });
    assert.equal(visit.status, 'settled', `created ${offsetMs} ms after the change took effect`);
    assert.deepEqual(visit.saved, []);
  }
  assert.equal(arrive({ user: createdBefore('onboarding'), signedIn: false }).status, 'settled', 'an older account still onboarding waits for it to finish');
  assert.equal(arrive({ user: createdBefore('onboarding') }).status, 'ask-account', 'and its account is asked once it has');
  const guest = fakeStorage();
  assert.equal(arrive({ user: null, storage: guest, signedIn: false }).status, 'settled', 'a guest');
  recordPrivacyNoticeShown({ uid: null, dialogOpen: true, version: NEXT_VERSION, storage: guest, saveToAccount: () => assert.fail('a guest has no account') });
  assert.equal(guest.map.size, 0, 'nothing is recorded without an account');
});

test('an account record read for one account never decides for the next', () => {
  const storage = fakeStorage();
  const readerB = createdBefore('reader-b');
  assert.equal(statusOf({ user: readerB, storage, account: { uid: 'reader-a', version: NEXT_VERSION } }), 'ask-account', 'A having been shown it does not settle B');
  assert.equal(statusOf({ user: readerB, storage, account: { uid: 'reader-a', version: null } }), 'ask-account', 'nor does A lacking it make B owed');
  rememberPrivacyNotice('reader-a', NEXT_VERSION, storage);
  assert.equal(statusOf({ user: readerB, storage }), 'ask-account', "nor does A's copy in this browser");
  assert.equal(statusOf({ user: createdBefore('reader-a'), storage }), 'settled', 'which settles A');
});

test('a failed account read shows nothing on a guess, and a failed save is reported without breaking the visit', async (t) => {
  const reader = createdBefore('reader-a');
  const storage = fakeStorage();
  const unread = arrive({ user: reader, storage, account: null });
  assert.equal(unread.dialogOpen, false, 'a read that failed leaves no record, so it stays shut until the next visit asks again');
  assert.equal(storage.map.size, 0);
  assert.equal(statusOf({ user: reader, storage: brokenStorage(), account: { uid: reader.uid, version: NEXT_VERSION } }), 'settled', 'with storage blocked, the account record settles it');
  assert.equal(statusOf({ user: reader, storage: brokenStorage(), account: { uid: reader.uid, version: null } }), 'owed', 'and tells it');

  // A save the account refuses: offline, or the rules for the record not deployed yet.
  const warn = t.mock.method(console, 'warn', () => undefined);
  recordPrivacyNoticeShown({ uid: reader.uid, dialogOpen: true, version: NEXT_VERSION, storage, saveToAccount: () => Promise.reject(new Error('permission-denied')) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warn.mock.callCount(), 1, 'reported, not thrown');
  assert.equal(statusOf({ user: reader, storage }), 'settled', "this browser's copy still settles it here");
  assert.equal(statusOf({ user: reader, account: { uid: reader.uid, version: PRIVACY_NOTICE_BASELINE_VERSION } }), 'owed', 'another browser, whose account record lacks it, tells it once more');
  assert.doesNotThrow(() => recordPrivacyNoticeShown({ uid: reader.uid, dialogOpen: true, version: NEXT_VERSION, storage: brokenStorage(), saveToAccount: () => Promise.resolve() }));
});

test('the privacy dialog, recorded as told on opening, stays open until it is closed or the reader leaves the feed', () => {
  const reader = createdBefore('reader-a');
  const storage = fakeStorage();
  recordPrivacyNoticeShown({ uid: reader.uid, dialogOpen: true, version: NEXT_VERSION, storage, saveToAccount: () => Promise.resolve() });
  const privacyOwed = statusOf({ user: reader, storage, account: { uid: reader.uid, version: null } }) === 'owed';
  assert.equal(privacyOwed, false, 'told once it opened, although the record read before it opened lacks it');
  const on = (pathname: string, dialogOpen: boolean) => noticeOnScreen({ picked: PRIVACY_NOTICE_ID, signedIn: true, pathname, privacyOwed, dialogOpen });
  assert.equal(on('/feed', true), PRIVACY_NOTICE_ID, 'still open on the feed');
  assert.equal(on('/settings', true), null, 'leaving the feed closes it');
  assert.equal(on('/feed', false), null, 'and it does not open again on return');
  assert.equal(noticeOnScreen({ picked: PRIVACY_NOTICE_ID, signedIn: false, pathname: '/feed', privacyOwed, dialogOpen: true }), null, 'signed out');
  assert.equal(answerPrivacyNotice({ ...VISIT_START, choiceMade: true, picked: PRIVACY_NOTICE_ID }).picked, null, 'Got it or any other close puts it away');
});

test('a notice shown in another tab puts away the one this tab picked and has not opened', () => {
  const reader = createdBefore('reader-a');
  const account = { uid: reader.uid, version: null };
  const shownIn = (storage: ReturnType<typeof fakeStorage>, pathname: string) => {
    const privacyOwed = statusOf({ user: reader, storage, account }) === 'owed';
    return noticeOnScreen({ picked: PRIVACY_NOTICE_ID, signedIn: true, pathname, privacyOwed }) === PRIVACY_NOTICE_ID;
  };

  const storage = fakeStorage();
  assert.equal(shownIn(storage, '/feed'), true, 'picked in this tab');
  assert.equal(shownIn(storage, '/settings'), false, 'waiting off the feed');
  rememberPrivacyNotice(reader.uid, NEXT_VERSION, storage);
  assert.equal(shownIn(storage, '/feed'), false, 'back on the feed after the other tab showed it');

  const newer = fakeStorage();
  rememberPrivacyNotice(reader.uid, `${NEXT_VERSION}.2`, newer);
  assert.equal(shownIn(newer, '/feed'), false, 'a tab on a newer bundle settled a later version');

  assert.equal(
    noticeOnScreen({ picked: 'email-down', signedIn: true, pathname: '/feed', privacyOwed: false }),
    'email-down',
    'the email nudge does not depend on the policy',
  );
});

test("who is told is decided from the account, its creation time, this browser's copy and the account's record", () => {
  const status = (user: NoticeUser, { storage = fakeStorage(), signedIn = true, recorded = null }: { storage?: NoticeStorage; signedIn?: boolean; recorded?: string | null } = {}) =>
    statusOf({ user, storage, signedIn, account: user ? { uid: user.uid, version: recorded } : null });
  const createdAt = (offsetMs: number) => createdBefore('a', offsetMs);
  assert.equal(status(createdAt(-24 * HOUR)), 'owed', 'an older account');
  assert.equal(status(createdAt(-1000)), 'owed', 'a second before');
  assert.equal(status(createdAt(0)), 'settled', 'the effective instant');
  assert.equal(status(createdAt(1000)), 'settled', 'a second after');
  assert.equal(status(createdAt(28 * HOUR)), 'settled', 'a new account the next day');
  assert.equal(status({ uid: 'a' }), 'owed', 'no metadata: told');
  assert.equal(status(null), 'settled', 'nobody');
  assert.equal(status(createdAt(-HOUR), { signedIn: false }), 'settled', 'not signed in');
  assert.equal(status(createdAt(-HOUR), { recorded: NEXT_VERSION }), 'settled', 'the account was shown it');
  assert.equal(status(createdAt(-HOUR), { recorded: '2027-01-05' }), 'settled', 'the account was shown a later version on a newer bundle');
  assert.equal(status(createdAt(-HOUR), { recorded: PRIVACY_NOTICE_BASELINE_VERSION }), 'owed', 'shown only an earlier one');
  assert.equal(status(createdAt(-HOUR), { recorded: 'garbage' }), 'owed', 'a record that is no version covers nothing');
  const storage = fakeStorage();
  rememberPrivacyNotice('a', NEXT_VERSION, storage);
  assert.equal(status({ uid: 'a' }, { storage }), 'settled', 'shown to this account in this browser');
  assert.equal(status({ uid: 'b' }, { storage }), 'owed', 'another account on the same browser');
});
