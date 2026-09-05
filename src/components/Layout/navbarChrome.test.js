import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La navbar sin botón de recargar.
 *
 * Recargar la página consigue lo mismo (las tres cachés que forzaba son Maps
 * en memoria), así que el botón, su spinner y el bus de eventos que lo
 * mantenía girando durante el informe se van juntos. Se sostiene aquí porque
 * un listener sin emisor y un keyframes sin consumidor compilan sin queja.
 */

const navbarJsx = readFile(new URL('./Navbar.jsx', import.meta.url), 'utf8');
const navbarCss = readFile(new URL('./Navbar.css', import.meta.url), 'utf8');
const reportJsx = readFile(new URL('../Report/ScientificReport.jsx', import.meta.url), 'utf8');
const prefsJsx = readFile(new URL('./NavPreferencesMenu.jsx', import.meta.url), 'utf8');
const prefsCss = readFile(new URL('./NavPreferencesMenu.css', import.meta.url), 'utf8');

test('la navbar no dibuja el botón de recargar ni escucha al informe', async () => {
  const jsx = await navbarJsx;
  for (const resto of ['RotateCw', 'refreshScientificReport', 'reportLoadingStart', 'reportLoadingEnd', 'showReloadButton', 'handleReload']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en Navbar.jsx`);
  }
});

test('el informe ya no emite los eventos que solo la navbar escuchaba', async () => {
  const jsx = await reportJsx;
  for (const resto of ['refreshScientificReport', 'reportLoadingStart', 'reportLoadingEnd']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en ScientificReport.jsx`);
  }
});

test('el spinner de la navbar se fue con su botón', async () => {
  const css = await navbarCss;
  assert.ok(!css.includes('.navbar-icon-btn.spinning'), 'la regla del spinner sigue en Navbar.css');
  assert.ok(!css.includes('@keyframes spin'), 'el keyframes spin ya no tiene consumidor en Navbar.css');
});

test('la navbar monta el menú de preferencias en vez del toggle suelto', async () => {
  const jsx = await navbarJsx;
  assert.ok(jsx.includes('NavPreferencesMenu'), 'la navbar no importa NavPreferencesMenu');
  assert.ok(!jsx.includes('<ThemeToggle'), 'el ThemeToggle suelto sigue en la navbar');
});

test('el menú reúne tema, idioma y el enlace a ajustes', async () => {
  const jsx = await prefsJsx;
  assert.match(jsx, /toggleTheme\(/, 'falta el tema');
  assert.match(jsx, /setLanguage\(/, 'falta el idioma');
  assert.match(jsx, /navigate\('\/settings'\)/, 'falta el enlace a ajustes');
  assert.match(jsx, /aria-expanded/, 'el disclosure debe anunciar su estado');
});

test('el popover se ancla al botón y anima solo con CSS', async () => {
  const css = await prefsCss;
  const rule = css.match(/\.nav-prefs-menu\s*\{([^}]*)\}/);
  assert.ok(rule, 'falta la regla .nav-prefs-menu');
  assert.match(rule[1], /position:\s*absolute/);
  assert.match(css, /prefers-reduced-motion/, 'el popover debe respetar reduced motion');
});

test('el popover anima la salida, no solo la entrada', async () => {
  const css = await prefsCss;
  const jsx = await prefsJsx;
  assert.match(css, /@keyframes navPrefsOut/, 'NavPreferencesMenu.css perdió navPrefsOut');
  assert.match(css, /\.nav-prefs-menu\.is-closing/, 'la clase de salida no tiene regla');
  assert.match(jsx, /setClosing\(true\)/, 'el menú no se marca al cerrar');
  assert.match(jsx, /MENU_EXIT_MS/, 'el temporizador de salida desapareció');
});

/**
 * El filete viajaba en diagonal de «Para ti» a las otras dos pestañas: el
 * primero ERA un <button> (line-height `normal` del navegador, 28 px de alto)
 * y las otras son <a> (el 1.5 del body, 33 px), y el filete cuelga del borde
 * inferior de cada enlace. Medido: 2,5 px más alto bajo «Para ti». Una sola
 * line-height para los tres, fijada en la regla, y el filete corre a nivel.
 *
 * Desde el 05-09-2026 las tres son <a> (Navbar.jsx), así que la declaración ya
 * no reconcilia nada: --lh-normal es 1.5 y el body ya lo aplica, de modo que
 * fija justo lo que las anclas heredarían. Se queda como pin defensivo —
 * vuelve a hacer trabajo el día que una pestaña deje de ser un <a> o un padre
 * cambie su line-height, que es la deriva de la que nació— y este test la
 * sostiene para que no se borre por parecer redundante.
 */
test('los tres enlaces de la navbar comparten line-height, o el filete viaja en diagonal', async () => {
  const css = await readFile(new URL('./Navbar.css', import.meta.url), 'utf8');
  const rule = css.match(/\.navbar-link \{([\s\S]*?)\n\}/);
  assert.ok(rule, 'expected the .navbar-link rule');
  assert.match(rule[1], /line-height: var\(--lh-normal\);/,
    'el pin defensivo de line-height se ha borrado: hoy no cambia nada porque las tres '
    + 'pestañas son <a> y heredan el mismo 1.5, pero es lo que sujeta el filete si una '
    + 'deja de serlo o un padre cambia la suya');
});
