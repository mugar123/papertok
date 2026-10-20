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

const navbarJsx = readFile(new URL('./Navbar.tsx', import.meta.url), 'utf8');
const navbarCss = readFile(new URL('./Navbar.css', import.meta.url), 'utf8');
const accountJsx = readFile(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');
const accountCss = readFile(new URL('./AccountMenu.css', import.meta.url), 'utf8');

test('la navbar no dibuja el botón de recargar ni escucha al informe', async () => {
  const jsx = await navbarJsx;
  // Both names of the reload glyph: Lucide's, and Phosphor's since the switch.
  for (const resto of ['RotateCw', 'ArrowClockwise', 'refreshScientificReport', 'reportLoadingStart', 'reportLoadingEnd', 'showReloadButton', 'handleReload']) {
    assert.ok(!jsx.includes(resto), `\`${resto}\` sigue en Navbar.tsx`);
  }
});

test('el spinner de la navbar se fue con su botón', async () => {
  const css = await navbarCss;
  assert.ok(!css.includes('.navbar-icon-btn.spinning'), 'la regla del spinner sigue en Navbar.css');
  assert.ok(!css.includes('@keyframes spin'), 'el keyframes spin ya no tiene consumidor en Navbar.css');
});

test('the navbar opens the account menu from the avatar, with no separate preferences button', async () => {
  const jsx = await navbarJsx;
  assert.match(jsx, /import AccountMenu from '\.\/AccountMenu\.tsx';/);
  assert.match(jsx, /<AccountMenu \/>/);
  assert.ok(!jsx.includes('NavPreferencesMenu'), 'the preferences button came back beside the avatar');
  assert.ok(!jsx.includes('<ThemeToggle'), 'el ThemeToggle suelto sigue en la navbar');
});


test('the account menu gathers the account, the three-way theme and sign-out', async () => {
  const jsx = await accountJsx;
  assert.match(jsx, /from '@base-ui\/react\/menu'/);
  for (const to of ['/lists', '/settings']) assert.match(jsx, new RegExp(`to: '${to}'`));
  assert.doesNotMatch(jsx, /to: '\/profile'/, 'there is no profile page to open; /profile only redirects');
  assert.doesNotMatch(jsx, /to: '\/settings\//, 'settings is one entry; its pages are inside it');
  assert.match(jsx, /render=\{<Link to=\{to\} \/>\}/);
  assert.match(jsx, /<Menu\.RadioGroup[\s\S]*?value=\{preference\}[\s\S]*?onValueChange=\{setPreference\}/);
  for (const id of ['light', 'dark', 'system']) assert.match(jsx, new RegExp(`id: '${id}'`));
  assert.match(jsx, /closeOnClick=\{false\}/, 'choosing a theme keeps the menu open');
  assert.match(jsx, /onClick=\{handleSignOut\}/);
  assert.doesNotMatch(jsx, /aria-expanded=/, 'Base UI writes aria-expanded on the trigger');
});

test('on a phone the avatar opens the same entries as a bottom sheet', async () => {
  // The menu hung from the top corner with 34 px rows; a phone gets the
  // shared Drawer instead, with the same links, theme and sign-out.
  const jsx = await accountJsx;
  assert.match(jsx, /if \(isPhone\) \{\s*return \(\s*<AccountSheet/);
  assert.match(jsx, /from '\.\.\/ui\/drawer\.tsx'/);
  assert.match(jsx, /<DrawerTrigger className="navbar-avatar-btn"/);
  const sheet = jsx.match(/function AccountSheet[\s\S]*?\n\}/)![0];
  assert.match(sheet, /LINKS\.map\([\s\S]*?<Link key=\{to\}[^>]*\bto=\{to\} className="account-sheet-row" onClick=\{close\}>/);
  assert.match(sheet, /<RadioGroup[\s\S]*?value=\{preference\}[\s\S]*?onValueChange=\{setPreference\}/);
  assert.match(sheet, /onClick=\{onSignOut\}/);
  assert.doesNotMatch(sheet, /role="menu/, 'a sheet is a dialog, not a menu');

  const css = await accountCss;
  const px = (rule: string, prop: string) => Number(css.match(new RegExp(`\\.${rule} \\{[^}]*${prop}:\\s*(\\d+)px`))?.[1]);
  assert.ok(px('account-sheet-row', 'min-height') >= 44, 'sheet rows are thumb-sized');
  assert.ok(px('account-sheet-theme-option', 'min-height') >= 36, 'theme choices stay comfortably over the 24px target minimum');
});

test('the account menu animates in and out with CSS, and keeps its items focusable', async () => {
  const css = await accountCss;
  assert.match(css, /\.account-menu\[data-starting-style\],\s*\.account-menu\[data-ending-style\]\s*\{[^}]*opacity:\s*0/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(reduced, 'falta el bloque de reduced motion');
  assert.match(reduced[1], /\.account-menu-theme-pill/);
  // Only the container turns its outline off; rows keep the global ring.
  const item = css.match(/\.account-menu-item\s*\{([^}]*)\}/);
  assert.ok(item && !/outline:\s*none/.test(item[1]), 'menu rows must keep the focus ring');
});

test('el interruptor de tema del header invitado es el Toggle de ui/', async () => {
  const jsx = await readFile(new URL('./ThemeToggle.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('./ThemeToggle.css', import.meta.url), 'utf8');
  assert.match(jsx, /from '\.\.\/ui\/toggle\.tsx'/);
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
 * Desde el 05-09-2026 las tres son <a> (Navbar.tsx), así que la declaración ya
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
 * habría quedado SIN NOMBRE. Since 2026-10-17 the word shows down to 360px,
 * and below that it is clipped rather than removed (the next test).
 */
test('la marca se llama por su propio texto, no por un aria-label que lo contradiga', async () => {
  const jsx = await navbarJsx;
  const desde = jsx.indexOf('className="navbar-brand"');
  assert.notEqual(desde, -1, 'no encuentro el botón de la marca en Navbar.tsx');
  const boton = jsx.slice(desde, jsx.indexOf('</button>', desde));

  assert.doesNotMatch(boton, /aria-label=/,
    'volvió el `aria-label` al botón de la marca. Su nombre accesible sería «PaperTok» '
    + 'mientras que lo visible es «PT PaperTok», y eso es `label-content-name-mismatch`: '
    + 'el nombre tiene que CONTENER lo que se lee en pantalla (WCAG 2.5.3)');
  assert.match(boton, /<span className="navbar-brand-word">Paper<span>Tok<\/span><\/span>/,
    'el rótulo de la marca dejó de ser texto, que es de donde sale ahora el nombre del botón');
  assert.match(boton, /<span className="navbar-brand-mark" aria-hidden="true">/,
    'la marca PT dejó de estar oculta al lector de pantalla; sin `aria-hidden` el botón '
    + 'pasa a anunciarse «PT PaperTok»');
});

test('the logo stays on every width, and on a phone the word is clipped, never removed', async () => {
  const css = await navbarCss;
  assert.doesNotMatch(css, /\.navbar-brand \{\s*display:\s*none;/,
    'the brand is hidden at some width again; the PT mark stays on every width');
  const tramo = css.slice(css.indexOf('@media (max-width: 768px)'));
  assert.ok(tramo.startsWith('@media (max-width: 768px)'), 'no 768px block in Navbar.css');
  const regla = tramo.match(/\.navbar-brand-word \{[^}]*\}/)?.[0];
  assert.ok(regla, 'the 768px block no longer clips `.navbar-brand-word`');
  assert.doesNotMatch(regla, /display:\s*none/,
    'the word is removed instead of clipped: the PT mark is `aria-hidden`, so the button '
    + 'would have no name (`button-name`)');
  assert.match(regla, /clip: rect\(0, 0, 0, 0\)/);
  assert.match(regla, /position: absolute/, 'clipped in flow, the word would still push the mark');
  assert.equal((css.match(/\.navbar-brand-word \{/g) || []).length, 2,
    'the word is styled once and clipped once; no other width hides it');
});
