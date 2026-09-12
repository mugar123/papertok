import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUDGE_DISMISSED_KEY,
  NUDGE_DWELL_MS,
  STAR_COUNT_TTL_MS,
  STAR_FETCH_BUDGET_MS,
  cacheStarCount,
  emailNudgeProblem,
  pickNudge,
  readCachedStarCount,
  readDismissedNudges,
  rememberNudgeDismissal,
} from './nudges.js';

const fakeStorage = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
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
  assert.deepEqual(JSON.parse(storage.getItem(NUDGE_DISMISSED_KEY)), ['open-source', 'email-down']);
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

test('un servicio sano no tiene nada que avisar', () => {
  assert.equal(emailNudgeProblem({ loading: false, health: { configured: true, available: true, code: null } }), null);
  assert.equal(
    emailNudgeProblem({ loading: false, health: { configured: true, available: true, code: 'EMAIL_RATE_LIMITED' } }),
    null,
    'si el servicio dice que está disponible, no se le contradice',
  );
});

test('el número de estrellas se guarda un día y se olvida después', () => {
  const storage = fakeStorage();
  const now = 1_700_000_000_000;
  assert.equal(readCachedStarCount(storage, now), null);
  assert.equal(cacheStarCount(42, storage, now), true);
  assert.equal(readCachedStarCount(storage, now), 42);
  assert.equal(readCachedStarCount(storage, now + STAR_COUNT_TTL_MS - 1), 42);
  assert.equal(readCachedStarCount(storage, now + STAR_COUNT_TTL_MS + 1), null, 'pasado el día, se vuelve a preguntar');
  assert.equal(readCachedStarCount(storage, now - 1), null, 'un reloj que va hacia atrás no revive la cache');
});

test('lo que no es un recuento no se guarda ni se lee', () => {
  const storage = fakeStorage();
  const now = 1_700_000_000_000;
  for (const bad of [-1, Number.NaN, Infinity, '12', null, undefined, 1.5]) {
    assert.equal(cacheStarCount(bad, storage, now), false, `${String(bad)} no es un recuento`);
  }
  assert.equal(readCachedStarCount(fakeStorage({ papertok_github_stars: 'no soy json' }), now), null);
  assert.equal(readCachedStarCount(fakeStorage({ papertok_github_stars: '{"count":"muchas","at":1}' }), now), null);
  assert.equal(readCachedStarCount(brokenStorage(), now), null);
  assert.equal(cacheStarCount(3, brokenStorage(), now), false);
});

test('los tiempos son los acordados', () => {
  assert.equal(NUDGE_DWELL_MS, 60_000, 'un minuto leyendo antes de pedir nada');
  assert.equal(STAR_FETCH_BUDGET_MS, 1500, 'pasado este plazo el panel sale sin número, nunca con un hueco');
  assert.equal(STAR_COUNT_TTL_MS, 24 * 60 * 60 * 1000);
});
