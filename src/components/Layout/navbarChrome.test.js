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

/**
 * La marca, y por qué su `aria-label` sobraba y encima estorbaba.
 *
 * El botón ya se llamaba a sí mismo: `.navbar-brand-word` dice «PaperTok» en
 * texto. El `aria-label="PaperTok"` no añadía nada y rompía el criterio 2.5.3,
 * porque lo que se VE en ese botón no es sólo la palabra: es la marca «PT» y
 * la palabra. Que la marca sea `aria-hidden` no la borra de la pantalla, y la
 * regla `label-content-name-mismatch` de axe cuenta el texto visible sin mirar
 * `aria-hidden` justamente por eso — quien maneja la interfaz por voz lo lee
 * igual. Medido el 18-09-2026: fallaba en las tres rutas a 1440.
 *
 * Quitar el atributo a secas abría un agujero peor, y en un tramo que la
 * auditoría no mira: entre 481 y 768 px la barra escondía el rótulo con
 * `display: none` y dejaba sólo la marca `aria-hidden`, así que el botón se
 * habría quedado SIN NOMBRE. Por eso el rótulo ahora se recorta en vez de
 * borrarse. Medido a 700 y a 520 px: el botón sigue midiendo 26x26 y Chrome
 * sigue calculando «PaperTok».
 */
test('la marca se llama por su propio texto, no por un aria-label que lo contradiga', async () => {
  const jsx = await navbarJsx;
  const desde = jsx.indexOf('className="navbar-brand"');
  assert.notEqual(desde, -1, 'no encuentro el botón de la marca en Navbar.jsx');
  const boton = jsx.slice(desde, jsx.indexOf('</button>', desde));

  assert.doesNotMatch(boton, /aria-label=/,
    'volvió el `aria-label` al botón de la marca. Su nombre accesible sería «PaperTok» '
    + 'mientras que lo visible es «PT PaperTok», y eso es `label-content-name-mismatch`: '
    + 'el nombre tiene que CONTENER lo que se lee en pantalla (WCAG 2.5.3)');
  assert.match(boton, /<span className="navbar-brand-word">Paper<span>Tok<\/span><\/span>/,
    'el rótulo de la marca dejó de ser texto, que es de donde sale ahora el nombre del botón');
  assert.match(boton, /<span className="navbar-brand-mark" aria-hidden="true">PT<\/span>/,
    'la marca PT dejó de estar oculta al lector de pantalla; sin `aria-hidden` el botón '
    + 'pasa a anunciarse «PT PaperTok»');
});

test('el rótulo de la marca se recorta en móvil, nunca se borra, o el botón se queda mudo', async () => {
  const css = await navbarCss;
  const tramo = css.slice(css.indexOf('@media (max-width: 768px)'), css.indexOf('@media (max-width: 480px)'));
  assert.ok(tramo.includes('@media (max-width: 768px)'), 'no encuentro el bloque de 768 px en Navbar.css');

  const regla = tramo.match(/\.navbar-brand-word \{[^}]*\}/)?.[0];
  assert.ok(regla, 'el bloque de 768 px ya no toca `.navbar-brand-word`');
  assert.doesNotMatch(regla, /display:\s*none/,
    'el rótulo de la marca vuelve a ocultarse con `display: none` por debajo de 768 px. '
    + '`.navbar-brand` sólo desaparece a 480, así que entre 481 y 768 px el botón se '
    + 'queda con la «PT» —que es `aria-hidden`— y sin nombre ninguno: `button-name`, '
    + 'crítico, en un tramo que una auditoría de 1440 y 390 no mira');
  assert.match(regla, /clip: rect\(0, 0, 0, 0\)/,
    'el rótulo dejó de recortarse; recortado no se ve, pero sigue en el árbol, que es '
    + 'lo que da nombre al botón en ese tramo');
  assert.match(regla, /position: absolute/,
    'sin `position: absolute` el rótulo recortado seguiría ocupando su hueco en el flex '
    + 'y la marca se movería');
});
