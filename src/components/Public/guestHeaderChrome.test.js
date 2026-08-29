import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La cabecera de invitado, sin botón de recargar.
 *
 * Es la misma decisión que se tomó en la navbar: recargar la página consigue lo
 * mismo, porque las cachés que el botón forzaba viven en Maps de memoria. Dejar
 * uno de los dos habría hecho que la aplicación se comportara distinto según
 * hubiera sesión o no.
 *
 * Lo que NO se va es `refresh`/`isRefreshing` de `useGuestFeed`: `FeedContainer`
 * los sigue leyendo del `source` para su propio tirar-para-recargar. Por eso hay
 * un aserto que los defiende — borrarlos por parecer huérfanos rompería el gesto
 * sin que ningún test se quejara.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

const guestJsx = readFile(new URL('./GuestFeedPage.jsx', import.meta.url), 'utf8');
const guestCss = readFile(new URL('./GuestFeedPage.css', import.meta.url), 'utf8').then(stripComments);
const feedContainerJsx = readFile(new URL('../Feed/FeedContainer.jsx', import.meta.url), 'utf8');

test('la cabecera de invitado ya no dibuja el botón de recargar', async () => {
  const jsx = await guestJsx;
  assert.ok(!jsx.includes('RotateCw'), 'el icono de recargar sigue en GuestFeedPage.jsx');
  assert.ok(!jsx.includes('is-spinning'), 'la clase del spinner sigue en GuestFeedPage.jsx');
  assert.ok(!jsx.includes('guestFeed.refresh'), 'el handler del botón sigue enganchado en la cabecera');
});

test('el spinner de la cabecera se fue con su botón', async () => {
  const css = await guestCss;
  assert.ok(!css.includes('.guest-header-button.is-spinning'), 'la regla del spinner sigue en GuestFeedPage.css');
});

test('el feed de invitado conserva su propio refresh, el que usa FeedContainer', async () => {
  const [guest, container] = await Promise.all([guestJsx, feedContainerJsx]);
  assert.match(guest, /\.\.\.guestFeed/, 'el feed ya no se le pasa entero a FeedContainer');
  assert.match(container, /source\.refresh/, 'FeedContainer dejó de leer el refresh del source');
  assert.match(container, /source\.isRefreshing/, 'FeedContainer dejó de leer isRefreshing del source');
});
