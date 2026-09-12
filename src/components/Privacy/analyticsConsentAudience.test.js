import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * A quien se le pregunta por la analítica (2026-09-12).
 *
 * La alerta se le pedía también a quien llega sin cuenta, encima de su primera
 * tarjeta y justo después de la hoja de intereses. En el feed de invitado se
 * retira: la primera visita se gasta entera en leer, no en administrar. Con
 * sesión sigue apareciendo igual.
 *
 * Nada de esto lo vigila el build — la rama de invitado era una condición
 * válida — así que se sostiene leyendo el fuente, como sus vecinos.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const bannerPromise = readFile(new URL('./AnalyticsConsentBanner.jsx', import.meta.url), 'utf8').then(stripComments);
const appPromise = readFile(new URL('../../App.jsx', import.meta.url), 'utf8').then(stripComments);

test('la alerta solo se dibuja con sesión: su condición no tiene rama de invitado', async () => {
  const jsx = await bannerPromise;
  const condition = jsx.match(/const feedIsVisible = ([\s\S]*?);/);
  assert.ok(condition, 'falta feedIsVisible en AnalyticsConsentBanner.jsx');
  assert.ok(!/!user/.test(condition[1]), 'la condición sigue teniendo una rama para quien no ha entrado');
  assert.ok(!/guestFeedReady/.test(jsx), 'la alerta sigue recibiendo el estado del feed de invitado');
  assert.match(condition[1], /user/, 'la alerta debe seguir apareciendo con sesión');
});

test('App ya no cablea el estado del invitado hasta la alerta', async () => {
  const app = await appPromise;
  assert.ok(!/guestFeedReady/.test(app), 'App sigue llevando la cuenta de si el feed de invitado está listo');
  assert.ok(!/guestInterestsOpen/.test(app), 'App sigue llevando la cuenta de la hoja de intereses para la alerta');
  assert.match(app, /<AnalyticsConsentBanner\s*\/>/, 'la alerta debe montarse sin props');
});

test('el feed de invitado deja de avisar de su estado hacia arriba', async () => {
  const guest = await readFile(new URL('../Public/GuestFeedPage.jsx', import.meta.url), 'utf8').then(stripComments);
  assert.ok(!/onReady/.test(guest), 'GuestFeedPage sigue exponiendo onReady, que solo servía a la alerta');
  assert.ok(!/onInterestsPromptChange/.test(guest), 'GuestFeedPage sigue avisando de la hoja de intereses');
  assert.match(guest, /interestsPromptSuspended/, 'la puerta de entrada no debe perder su freno mientras el diálogo de sesión está abierto');
});
