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
  assert.match(jsx, /exit=\{prefersReducedMotion\s*\?\s*\{ opacity: 0 \}\s*:\s*\{ opacity: 0, y: 20, scale: 0\.97, transition: \{ duration: 0\.3, ease: \[0\.4, 0, 1, 1\] \} \}\}/);
});

test('al confirmar, el icono de la alerta se pone en verde y con movimiento reducido nada transiciona', async () => {
  const css = await cssPromise;
  assert.match(css, /\.analytics-consent\.is-success \.analytics-consent-icon\s*\{[^}]*color:\s*var\(--tint-green-fg\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.analytics-consent-accept-face,/);
  assert.match(reduced, /\.analytics-consent-accept-face svg,/);
});
