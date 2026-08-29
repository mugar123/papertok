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
