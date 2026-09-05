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
});

/**
 * El disclosure anuncia su estado a través del trigger: Base UI escribe
 * `aria-expanded` y `data-popup-open` en el botón que renderiza
 * `PopoverTrigger`, así que la promesa vive en usar ese trigger, no en un
 * atributo escrito a mano que podría quedarse desincronizado del panel.
 */
test('el trigger es un PopoverTrigger de Base UI y el panel conserva role="group"', async () => {
  const jsx = await prefsJsx;
  const css = await prefsCss;
  assert.match(jsx, /from '\.\.\/ui\/popover\.jsx'/, 'el menú no usa el Popover de ui/');
  assert.match(jsx, /<PopoverTrigger\s+render=\{<button type="button" className="navbar-icon-btn nav-prefs-trigger" \/>\}/,
    'el trigger debe seguir siendo el botón de utilidades de la barra');
  assert.match(jsx, /<PopoverContent[\s\S]*?role="group"[\s\S]*?aria-label=\{label\}/,
    'el contenido son toggles con estado: role="group" con nombre, no un menu ARIA');
  assert.match(css, /\.nav-prefs-trigger\[data-popup-open\]/, 'el aspecto abierto del trigger se lee del estado que escribe Base UI');
  assert.doesNotMatch(jsx, /aria-expanded=/, 'aria-expanded lo escribe Base UI; a mano se desincroniza');
  assert.doesNotMatch(jsx, /addEventListener\('pointerdown'|addEventListener\('keydown'/,
    'cerrar al pulsar fuera y con Escape es del Popover, no del componente');
});

test('el popover lo posiciona Base UI y anima solo con CSS', async () => {
  const css = await prefsCss;
  const jsx = await prefsJsx;
  const rule = css.match(/\.nav-prefs-menu\s*\{([^}]*)\}/);
  assert.ok(rule, 'falta la regla .nav-prefs-menu');
  assert.doesNotMatch(rule[1], /position:\s*absolute/, 'el Positioner ancla el panel; una posición propia lo sacaría del sitio');
  assert.match(jsx, /align="end"/, 'a la derecha el panel se pega al borde del propio botón');
  assert.match(css, /prefers-reduced-motion/, 'el popover debe respetar reduced motion');
  assert.doesNotMatch(jsx, /framer-motion/, 'nada de framer en el cromo');
});

/**
 * La salida sigue existiendo: antes era `is-closing` + un temporizador que
 * esperaba a `navPrefsOut`; ahora Base UI marca `data-ending-style` y espera a
 * que la transición termine antes de desmontar. Sin regla para ese estado el
 * panel desaparecería de golpe, y con reduced motion no debe transicionar.
 */
test('el popover anima la salida, no solo la entrada', async () => {
  const css = await prefsCss;
  const jsx = await prefsJsx;
  assert.match(css, /\.nav-prefs-menu\[data-starting-style\]\s*\{[^}]*opacity:\s*0/, 'la entrada no parte de opacity 0');
  assert.match(css, /\.nav-prefs-menu\[data-ending-style\]\s*\{[^}]*opacity:\s*0/, 'la salida no tiene regla');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(reduced, 'falta el bloque de reduced motion');
  assert.match(reduced[1], /\.nav-prefs-menu\[data-ending-style\]/, 'la salida también se apaga con reduced motion');
  for (const resto of ['setClosing', 'MENU_EXIT_MS', 'is-closing', 'useReducedMotion']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en NavPreferencesMenu.jsx: la salida la espera Base UI`);
  }
  assert.ok(!css.includes('navPrefsOut') && !css.includes('is-closing'), 'la salida a mano sigue en el CSS');
});

/**
 * Tema e idioma son toggles de ui/: el tema un `Toggle` (un solo on/off, con
 * `aria-pressed` puesto por Base UI) y el idioma un `ToggleGroup` de selección
 * única, cuyo valor es siempre un array y llega vacío si se vuelve a pulsar el
 * idioma activo — un estado que no existe, así que se ignora.
 */
test('tema e idioma son los toggles de ui/', async () => {
  const jsx = await prefsJsx;
  assert.match(jsx, /<Toggle[\s\S]*?pressed=\{isDark\}[\s\S]*?onPressedChange=\{\(\) => toggleTheme\(themeRowRef\.current\)\}/);
  assert.match(jsx, /<ToggleGroup[\s\S]*?value=\{\[language\]\}[\s\S]*?onValueChange=\{\(\[next\]\) => \{ if \(next\) setLanguage\(next\); \}\}/);
  assert.match(jsx, /<ToggleGroupItem value="es">ES<\/ToggleGroupItem>/);
  assert.match(jsx, /<ToggleGroupItem value="en">EN<\/ToggleGroupItem>/);
  assert.doesNotMatch(jsx, /aria-pressed=/, 'aria-pressed lo escriben los toggles');
});

test('el interruptor de tema del header invitado es el Toggle de ui/', async () => {
  const jsx = await readFile(new URL('./ThemeToggle.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('./ThemeToggle.css', import.meta.url), 'utf8');
  assert.match(jsx, /from '\.\.\/ui\/toggle\.jsx'/);
  assert.match(jsx, /<Toggle[\s\S]*?pressed=\{isDark\}[\s\S]*?onPressedChange=\{\(\) => toggleTheme\(buttonRef\.current\)\}/);
  assert.doesNotMatch(jsx, /aria-pressed=/, 'Base UI escribe aria-pressed');
  // The morph keys off the attribute Base UI writes, so the drawing and the
  // announcement stay one fact.
  assert.match(css, /\.theme-toggle\[aria-pressed='true'\] \.theme-toggle-core/);
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
