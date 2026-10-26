import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUDGE_DISMISSED_KEY,
  NUDGE_DWELL_MS,
  PRIVACY_NOTICE_ID,
  emailNudgeProblem,
  escapeBelongsToOther,
  pickNudge,
  pickVisitNotice,
  privacyNoticeOwed,
  readDismissedNudges,
  readPrivacyNoticeAck,
  rememberNudgeDismissal,
  rememberPrivacyNotice,
} from './nudges.ts';

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
  assert.equal(privacyNoticeOwed({ version, acknowledged: null, signedIn: true }), true, 'an account with no creation date');
  assert.equal(privacyNoticeOwed({ version, acknowledged: null, signedIn: false }), false, 'a guest cannot be told apart from a first-time visitor');
  assert.equal(privacyNoticeOwed({ version, acknowledged: '2026-10-20', signedIn: true }), true, 'dismissed an earlier version');
  assert.equal(privacyNoticeOwed({ version, acknowledged: '2026-10-22', signedIn: true }), false, 'dismissed this one');
  assert.equal(
    privacyNoticeOwed({ version: '2026-10-22.2', acknowledged: '2026-10-22', signedIn: true }),
    true,
    'a second change on the same day is news to whoever dismissed the first',
  );
});

test('dismissing a later version settles an earlier one, and a suffix sorts as a number', () => {
  const owed = (version: string, acknowledged: string | null) => privacyNoticeOwed({ version, acknowledged, signedIn: true });
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

test('an account opened on or after the day of the change is not told about it', () => {
  const version = '2026-10-22';
  assert.equal(privacyNoticeOwed({ version, acknowledged: null, accountCreated: 'Tue, 20 Oct 2026 09:00:00 GMT', signedIn: true }), true);
  assert.equal(
    privacyNoticeOwed({ version, acknowledged: null, accountCreated: 'Wed, 21 Oct 2026 23:59:00 GMT', signedIn: true }),
    true,
    'the day before is an account that read the old policy',
  );
  assert.equal(
    privacyNoticeOwed({ version, acknowledged: null, accountCreated: 'Thu, 22 Oct 2026 08:00:00 GMT', signedIn: true }),
    false,
    'a change is published the day it is dated, so a new account that day started under it',
  );
  assert.equal(privacyNoticeOwed({ version, acknowledged: null, accountCreated: 'not a date', signedIn: true }), true, 'an unknown start is told');
  assert.equal(
    privacyNoticeOwed({ version: '2026-11-05', acknowledged: '2026-10-22', accountCreated: 'Fri, 23 Oct 2026 08:00:00 GMT', signedIn: true }),
    true,
    'and is told about the next change',
  );
});

test('each account dismisses the notice separately', () => {
  const storage = fakeStorage();
  rememberPrivacyNotice('reader-a', '2026-10-22', storage);
  assert.equal(readPrivacyNoticeAck('reader-a', storage), '2026-10-22');
  assert.equal(readPrivacyNoticeAck('reader-b', storage), null, 'another account on this device');
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
