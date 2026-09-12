import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La alerta de consentimiento cabe en una fila.
 *
 * El botón «No permitir» se fue y su hueco lo ocupa una X que registra el
 * mismo rechazo; el botón de aceptar sube a la fila del texto. Nada de esto
 * lo vigila el build — un grid de dos filas es CSS válido — así que se
 * sostiene aquí, leyendo el fuente como hace readerMobileStyles.test.js.
 */

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

const cssPromise = readFile(new URL('./AnalyticsConsentBanner.css', import.meta.url), 'utf8').then(stripComments);
const jsxPromise = readFile(new URL('./AnalyticsConsentBanner.jsx', import.meta.url), 'utf8');

test('el botón de texto «No permitir» ya no existe', async () => {
  const jsx = await jsxPromise;
  assert.ok(!jsx.includes('analytics-consent-decline'), 'la clase del botón de rechazo de texto sigue en el JSX');
});

test('la X de cierre registra el rechazo, no solo esconde la alerta', async () => {
  const jsx = await jsxPromise;
  assert.ok(jsx.includes('analytics-consent-dismiss'), 'falta la X de cierre');
  const dismissBlock = jsx.slice(jsx.indexOf('analytics-consent-dismiss'));
  assert.match(dismissBlock.slice(0, 400), /onClick=\{handleDecline\}/, 'la X debe llamar a handleDecline para persistir DENIED');
});

test('el grid es de una fila: icono, texto, acción y X como columnas', async () => {
  const css = await cssPromise;
  const rule = css.match(/\.analytics-consent\s*\{([^}]*)\}/);
  assert.ok(rule, 'falta la regla .analytics-consent');
  assert.match(rule[1], /grid-template-columns:\s*40px\s+minmax\(0,\s*1fr\)\s+auto\s+auto/, 'las acciones deben ser columnas de la misma fila');
  assert.match(rule[1], /align-items:\s*center/, 'la fila única se alinea al centro');
});

test('en móvil el icono cede su columna al texto en vez de apilar las acciones', async () => {
  const css = await cssPromise;
  const start = css.indexOf('@media (max-width: 560px)');
  assert.notEqual(start, -1, 'falta el media query de 560px');
  const block = css.slice(start, css.indexOf('@media', start + 1) === -1 ? css.length : css.indexOf('@media', start + 1));
  assert.match(block, /\.analytics-consent-icon\s*\{[^}]*display:\s*none/, 'el icono debe ocultarse en móvil');
  assert.ok(!/analytics-consent-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(block), 'las acciones ya no se apilan bajo el texto');
});

/**
 * Pulsar «Permitir analítica» (2026-09-03). La persistencia es síncrona, así
 * que «Activando…» duraba un frame y el botón cambiaba de texto dos veces en
 * treinta milisegundos, saltando de anchura entre etiquetas; la marca de hecho
 * aparecía sin más y la alerta se iba a los 620 ms en 0,22 s.
 */

test('el botón apila sus tres caras en una celda, así que su anchura no salta al cambiar de estado', async () => {
  const css = await cssPromise;
  const jsx = await jsxPromise;
  assert.match(css, /\.analytics-consent-accept-faces\s*\{[^}]*display:\s*grid/, 'las caras comparten una rejilla');
  assert.match(css, /\.analytics-consent-accept-face\s*\{[^}]*grid-area:\s*1\s*\/\s*1/, 'cada cara ocupa la misma celda');
  for (const face of ['idle', 'loading', 'success']) {
    assert.match(jsx, new RegExp(`data-face="${face}"`), `falta la cara ${face}`);
  }
  // Las caras son decorativas; lo que se anuncia es una sola etiqueta oculta.
  assert.match(jsx, /className="analytics-consent-accept-faces" aria-hidden="true"/);
  assert.match(jsx, /<span className="visually-hidden" aria-live="polite">\{currentLabel\}<\/span>/);
  assert.ok(!/className=\{`analytics-consent-accept is-\$\{acceptanceState\}`\}\s+disabled=\{decisionInProgress\}\s+aria-live/.test(jsx), 'el aria-live ya no va en el botón');
});

test('las caras entran desde abajo y salen por arriba, y la marca de hecho brota', async () => {
  const css = await cssPromise;
  assert.match(css, /\.analytics-consent-accept-face\.is-next\s*\{[^}]*transform:\s*translateY\(6px\)/);
  assert.match(css, /\.analytics-consent-accept-face\.is-past\s*\{[^}]*transform:\s*translateY\(-6px\)/);
  assert.match(css, /\.analytics-consent-accept-face\.is-current\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*none/);
  assert.match(css, /\.analytics-consent-accept-face\s*\{[^}]*transition:\s*opacity 0\.18s ease,\s*transform 0\.32s cubic-bezier\(0\.16, 1, 0\.3, 1\)/);
  assert.match(css, /\.analytics-consent-accept-face\.is-current\[data-face="success"\] svg\s*\{[^}]*animation:\s*analyticsConsentCheckIn 0\.42s cubic-bezier\(0\.34, 1\.4, 0\.64, 1\)/);
  assert.match(css, /@keyframes analyticsConsentCheckIn\s*\{\s*from\s*\{\s*transform:\s*scale\(0\.4\) rotate\(-12deg\);\s*opacity:\s*0;/);
});

test('«Activando…» dura un instante legible y la alerta se despide sin prisa', async () => {
  const jsx = await jsxPromise;
  assert.match(jsx, /const ACCEPT_BEAT_MS = 320;/);
  assert.match(jsx, /const CONFIRMED_HOLD_MS = 800;/);
  assert.match(jsx, /await Promise\.all\(\[\s*updateConsent\(ANALYTICS_CONSENT\.GRANTED\),\s*new Promise\(resolve => window\.setTimeout\(resolve, prefersReducedMotion \? 0 : ACCEPT_BEAT_MS\)\),\s*\]\)/);
  assert.match(jsx, /prefersReducedMotion \? 0 : CONFIRMED_HOLD_MS/);
  // La FORMA del adiós la fijan los dos tests de relojes del final del fichero
  // (12-09); aquí sobrevive lo que este test venía defendiendo: que sigue
  // habiendo adiós, y que el panel se hunde en vez de evaporarse en el sitio.
  const leave = jsx.slice(jsx.indexOf('exit={prefersReducedMotion'), jsx.indexOf('exit={prefersReducedMotion') + 520);
  const sink = leave.match(/(?<![A-Za-z-])y: (\d+)/);
  assert.ok(sink && Number(sink[1]) > 0, 'la alerta debe hundirse al irse, no desaparecer donde está');
});

test('al confirmar, el icono de la alerta se pone en verde y con movimiento reducido nada transiciona', async () => {
  const css = await cssPromise;
  assert.match(css, /\.analytics-consent\.is-success \.analytics-consent-icon\s*\{[^}]*color:\s*var\(--tint-green-fg\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.analytics-consent-accept-face,/);
  assert.match(reduced, /\.analytics-consent-accept-face svg,/);
});

/**
 * La llegada y la marcha del panel (2026-09-12).
 *
 * Las dos corrían UNA transición para opacidad, desplazamiento y escala, con
 * una `cubic-bezier(0.22, 1, 0.36, 1)`. Una expo sobre la opacidad no es un
 * fundido: es un destello con cola — el panel estaba al 90 % de opacidad a los
 * 90 ms y aún le quedaban 12 px por recorrer. Es el mismo fallo que ya se
 * corrigió en la entrada de los recortes del feed (a6f1e76) y en la transición
 * de ruta.
 *
 * Lo que se fija aquí no son los números, que se retocan, sino la propiedad:
 * el fundido corre en su propio reloj, en recta, y termina ANTES que el
 * movimiento. Un solo reloj para las tres cosas vuelve a fallar.
 */

// La mirilla hacia atrás no es adorno: sin ella, buscar `y:` casa dentro de
// `opacit_y_: { duration ... }` y el test se cree que el viaje dura lo que el
// fundido. Falló así a la primera.
const motionClock = (block, property) => {
  const match = block.match(new RegExp(`(?<![A-Za-z-])${property}: \\{ duration: ([\\d.]+), ease: ([^}]+?) \\}`));
  return match && { duration: Number(match[1]), ease: match[2].trim() };
};

const motionBlock = (jsx, anchor) => {
  const start = jsx.indexOf(anchor);
  assert.notEqual(start, -1, `falta ${anchor} en el JSX`);
  return jsx.slice(start, start + 520);
};

for (const [name, anchor] of [['la llegada', 'transition={prefersReducedMotion'], ['la marcha', 'exit={prefersReducedMotion']]) {
  test(`${name} funde en su propio reloj, en recta y más corto que el movimiento`, async () => {
    const block = motionBlock(await jsxPromise, anchor);
    const fade = motionClock(block, 'opacity');
    const travel = motionClock(block, 'y');
    const scale = motionClock(block, 'scale');

    assert.ok(fade, `${name}: la opacidad no declara reloj propio`);
    assert.ok(travel, `${name}: el desplazamiento no declara reloj propio`);
    assert.equal(fade.ease, "'linear'", `${name}: una curva sobre la opacidad es un destello, no un fundido`);
    assert.ok(fade.duration < travel.duration, `${name}: el fundido (${fade.duration}s) debe terminar antes que el viaje (${travel.duration}s)`);
    assert.ok(scale, `${name}: la escala no declara reloj propio`);
    assert.equal(scale.duration, travel.duration, `${name}: escala y desplazamiento son un solo gesto y comparten reloj`);
  });
}

test('el movimiento sigue teniendo su apagado para quien pide menos', async () => {
  const jsx = await jsxPromise;
  assert.match(jsx, /initial=\{prefersReducedMotion \? false :/, 'la entrada debe poder no animarse');
  assert.match(jsx, /exit=\{prefersReducedMotion\s*\?\s*\{ opacity: 0 \}/, 'la salida sin movimiento debe seguir siendo solo opacidad');
  assert.match(jsx, /transition=\{prefersReducedMotion\s*\?\s*\{ duration: 0 \}/, 'el reloj de la llegada debe anularse entero');
});

/**
 * Y el hover del botón, que era el último sitio donde vivía el acento de
 * antes: tinta en reposo y morado al pasar por encima. El token existe y lo
 * usa el botón primario de toda la app (ui/button-variants.js).
 */
test('el hover del botón de aceptar usa el token de la casa, no un literal', async () => {
  const css = await cssPromise;
  const hover = css.match(/\.analytics-consent-accept:hover\s*\{([^}]*)\}/);
  assert.ok(hover, 'falta la regla de hover del botón de aceptar');
  assert.match(hover[1], /background:\s*var\(--accent-primary-hover\)/, 'el hover debe seguir al acento, sea cual sea');
});
