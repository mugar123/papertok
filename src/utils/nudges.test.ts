import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUDGE_DISMISSED_KEY,
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  emailNudgeProblem,
  escapeBelongsToOther,
  forgetPrivacyNotice,
  noticeOnScreen,
  pickNudge,
  pickVisitNotice,
  privacyNoticeOwed,
  privacyOwedFor,
  readDismissedNudges,
  readPrivacyNoticeAck,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
} from './nudges.ts';
import { PRIVACY_POLICY_EFFECTIVE_AT, PRIVACY_POLICY_VERSION } from '../legal/privacyPolicy.ts';

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

test('a reader who has not dismissed this policy version is owed the notice', () => {
  const version = '2026-10-22';
  const effectiveAt = '2026-10-22T05:00:00Z';
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: null, signedIn: true }), true, 'an account with no creation date');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: null, signedIn: false }), false, 'a guest cannot be told apart from a first-time visitor');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: '2026-10-20', signedIn: true }), true, 'dismissed an earlier version');
  assert.equal(privacyNoticeOwed({ version, effectiveAt, acknowledged: '2026-10-22', signedIn: true }), false, 'dismissed this one');
  assert.equal(
    privacyNoticeOwed({ version: '2026-10-22.2', effectiveAt, acknowledged: '2026-10-22', signedIn: true }),
    true,
    'a second change on the same day is news to whoever dismissed the first',
  );
});

test('dismissing a later version settles an earlier one, and a suffix sorts as a number', () => {
  const owed = (version: string, acknowledged: string | null) => privacyNoticeOwed({ version, effectiveAt: '2026-10-25T05:00:00Z', acknowledged, signedIn: true });
  assert.equal(owed('2026-10-25', '2026-11-05'), false, 'a tab on an older bundle');
  assert.equal(owed('2026-10-25.2', '2026-10-26'), false, 'a later day covers an earlier day with a suffix');
  assert.equal(owed('2026-10-25.2', '2026-10-25.10'), false, '.10 is after .2');
  assert.equal(owed('2026-10-25.10', '2026-10-25.2'), true, '.2 is before .10');
  assert.equal(owed('2026-10-25.2', '2026-10-25'), true, 'no suffix is before .2');
  assert.equal(owed('2026-10-25', '2026-10-25.2'), false, '.2 covers the day itself');
  assert.equal(owed('2026-10-25', 'garbage'), true, 'a stored value that is no version covers nothing');
});

test('a tab on an older bundle does not overwrite a newer dismissal', () => {
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
  const owed = (accountCreated: string) =>
    privacyNoticeOwed({ version: '2026-10-26', effectiveAt: '2026-10-26T05:00:00Z', acknowledged: null, accountCreated, signedIn: true });
  assert.equal(owed('Sun, 25 Oct 2026 15:00:00 GMT'), true, 'created the day of the earlier change, after it');
  assert.equal(owed('Mon, 26 Oct 2026 00:10:00 GMT'), true, 'after midnight UTC, before this change');
});

test('each account dismisses the notice separately', () => {
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
    'the email nudge waits for a later visit',
  );
  assert.equal(pickVisitNotice({ privacyOwed: true }), PRIVACY_NOTICE_ID, 'also when no nudge is pending');
  assert.equal(pickVisitNotice({ privacyOwed: false, eligible: ['email-down'], dismissed: [] }), 'email-down');
  assert.equal(pickVisitNotice({ privacyOwed: false, eligible: ['email-down'], dismissed: ['email-down'] }), null, 'a dismissed nudge stays dismissed');
  assert.equal(pickVisitNotice({ privacyOwed: false }), null);
});

test('an Escape that belongs to another dialog, menu or text field does not put the notice away', () => {
  const inside = (selectors: string) => ({ tagName: 'DIV', closest: (selector: string) => (selector.includes(selectors) ? {} : null) });
  assert.equal(escapeBelongsToOther(inside('role="dialog"')), true, 'a dialog');
  assert.equal(escapeBelongsToOther(inside('role="alertdialog"')), true, 'an alert dialog');
  assert.equal(escapeBelongsToOther(inside('role="menu"')), true, 'a menu');
  assert.equal(escapeBelongsToOther(inside('role="listbox"')), true, 'a list of options');
  assert.equal(escapeBelongsToOther(inside('aria-modal="true"')), true, 'a modal');
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(escapeBelongsToOther({ tagName, closest: () => null }), true, tagName);
  }
  assert.equal(escapeBelongsToOther({ tagName: 'DIV', isContentEditable: true, closest: () => null }), true, 'a note editor');
  assert.equal(escapeBelongsToOther({ tagName: 'BODY', closest: () => null }), false, 'the page underneath');
  assert.equal(escapeBelongsToOther(null), false);
  assert.equal(escapeBelongsToOther({}), false, 'the document itself has no closest');
});

test('an Escape that closes a tooltip or popover from its trigger does not put the notice away', () => {
  const inside = (selectors: string) => ({ tagName: 'BUTTON', closest: (selector: string) => (selector.includes(selectors) ? {} : null) });
  assert.equal(escapeBelongsToOther(inside('data-popup-open')), true, 'a trigger whose tooltip is open');
  assert.equal(escapeBelongsToOther({ tagName: 'BUTTON', closest: () => null }), false, 'a trigger with nothing open');
});

test('the notice is shown only to a signed-in reader on the feed, and returns when they come back', () => {
  const on = (picked: string | null, signedIn: boolean, pathname: string) => noticeOnScreen({ picked, signedIn, pathname });
  assert.equal(on(PRIVACY_NOTICE_ID, true, '/feed'), PRIVACY_NOTICE_ID);
  assert.equal(on('email-down', true, '/feed'), 'email-down');
  for (const pathname of ['/search', '/lists', '/explore', '/settings', '/paper/abc', '/feed/x', '/']) {
    assert.equal(on(PRIVACY_NOTICE_ID, true, pathname), null, `a paper may be open as a modal on ${pathname}`);
    assert.equal(on('email-down', true, pathname), null, `the email nudge too on ${pathname}`);
  }
  assert.equal(on(PRIVACY_NOTICE_ID, false, '/feed'), null, 'signed out');
  assert.equal(on(null, true, '/feed'), null, 'nothing picked');
});

test('who is told is decided from the account, its creation time and what this browser stored for its uid', () => {
  // The shipped instant is 05:00:00Z on 26 October: #363, the last announced
  // privacy.html change, was merged at 04:51:54Z and its Vercel deployment
  // succeeded at 04:52:18Z. Whoever signed up on that text has nothing to be
  // told, even though the notice itself ships later.
  const version = PRIVACY_POLICY_VERSION;
  const effectiveAt = PRIVACY_POLICY_EFFECTIVE_AT;
  const owed = (user: { uid: string; metadata?: { creationTime?: string | null } } | null, storage = fakeStorage(), signedIn = true) =>
    privacyOwedFor({ user, signedIn, version, effectiveAt, storage });
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Sun, 25 Oct 2026 10:00:00 GMT' } }), true, 'an older account');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Mon, 26 Oct 2026 04:51:53 GMT' } }), true, 'created before #363 was merged');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Mon, 26 Oct 2026 04:59:59 GMT' } }), true, 'a second before');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Mon, 26 Oct 2026 05:00:00 GMT' } }), false, 'the effective instant');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Mon, 26 Oct 2026 05:00:01 GMT' } }), false, 'a second after');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Mon, 26 Oct 2026 15:00:00 GMT' } }), false, 'signed up on the announced text, hours before the notice was deployed');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Tue, 27 Oct 2026 09:00:00 GMT' } }), false, 'a new account the next day');
  assert.equal(owed({ uid: 'a' }), true, 'no metadata: told');
  assert.equal(owed(null), false, 'nobody');
  assert.equal(owed({ uid: 'a', metadata: { creationTime: 'Sun, 25 Oct 2026 10:00:00 GMT' } }, fakeStorage(), false), false, 'not signed in');
  const storage = fakeStorage();
  rememberPrivacyNotice('a', version, storage);
  assert.equal(owed({ uid: 'a' }, storage), false, 'dismissed by this account');
  assert.equal(owed({ uid: 'b' }, storage), true, 'another account on the same browser');
});
