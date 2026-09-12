import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * La puerta del invitado en el explorador (2026-09-12).
 *
 * Sin cuenta, una entidad enseña dos filas y un bloque debajo que explica lo
 * que falta y abre el diálogo de registro. Lo que se defiende aquí es el
 * cableado, que ningún test de unidad ve: que el recorte se aplique a las dos
 * pestañas, que el centinela de scroll infinito NO se monte sin sesión — si se
 * montara, el observador pediría la página 2 y la limitación sería solo
 * pintura — y que la barra de búsqueda no acepte texto que no puede honrar.
 *
 * La decisión en sí (cuántas filas, cuándo hay puerta, qué número se promete)
 * vive en utils/entityExplorer.js y se prueba allí.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8').then(stripComments);
const explorerJsx = read('./EntityExplorer.jsx');
const gateJsx = read('./ExplorerGuestGate.jsx');
const gateCss = read('./ExplorerGuestGate.css');

test('las dos listas se recortan por el mismo sitio', async () => {
  const jsx = await explorerJsx;
  assert.match(jsx, /guestPreviewRows\(mountedPapers, \{ publicMode \}\)/, 'los papers no pasan por el recorte de invitado');
  assert.match(jsx, /guestPreviewRows\(entityAuthors, \{ publicMode \}\)/, 'los autores no pasan por el recorte de invitado');
  assert.ok(!/mountedPapers\.map\(/.test(jsx), 'la rejilla sigue dibujando la lista sin recortar');
  assert.ok(!/entityAuthors\.map\(/.test(jsx), 'la pestaña de autores sigue dibujando la lista sin recortar');
});

test('sin sesión no se monta el centinela, así que nadie pide la página 2', async () => {
  const jsx = await explorerJsx;
  const sentinels = jsx.match(/\{[^{}]*hasMore[A-Za-z]*[\s\S]{0,200}?ehc-sentinel/g) || [];
  assert.equal(sentinels.length, 2, 'deberían quedar dos centinelas, el de papers y el de autores');
  for (const sentinel of sentinels) {
    assert.match(sentinel, /!publicMode/, `un centinela se monta sin sesión: ${sentinel.slice(0, 80)}`);
  }
});

test('la puerta se dibuja en las dos pestañas, y solo cuando queda algo detrás', async () => {
  const jsx = await explorerJsx;
  const gates = jsx.match(/<ExplorerGuestGate[\s\S]{0,400}?\/>/g) || [];
  assert.equal(gates.length, 2, 'falta la puerta en alguna de las dos pestañas');
  assert.match(jsx, /shouldShowGuestGate\(\{[^}]*publicMode[^}]*loaded:[^}]*hasMore[^}]*\}\)/, 'la puerta de papers no consulta la decisión pura');
  for (const gate of gates) {
    assert.match(gate, /onSignUp=/, 'la puerta no lleva su botón a ninguna parte');
  }
});

test('la barra de búsqueda del invitado no acepta texto, abre la puerta', async () => {
  const jsx = await explorerJsx;
  const input = jsx.slice(jsx.indexOf('explorer-search-input'), jsx.indexOf('explorer-search-input') + 900);
  assert.match(input, /readOnly=\{publicMode\}/, 'el campo sigue aceptando texto sin sesión');
  assert.match(input, /publicMode/, 'el campo no distingue al invitado');
  const filters = jsx.slice(jsx.indexOf('Open filters') - 700, jsx.indexOf('Open filters'));
  assert.match(filters, /publicMode \?[\s\S]{0,80}setShowFilters\(true\)/, 'el botón de filtros sigue abriendo la hoja sin sesión');
});

test('la puerta dice lo mismo en los dos idiomas y para las dos listas', async () => {
  const jsx = await gateJsx;
  for (const key of ['papers', 'authors']) {
    assert.match(jsx, new RegExp(`${key}:`), `falta la copia de ${key}`);
  }
  for (const lang of ['es:', 'en:']) {
    assert.ok(jsx.includes(lang), `falta el idioma ${lang}`);
  }
  assert.match(jsx, /total/, 'la puerta no usa el número de publicaciones de la entidad');
});

test('el bloque se dibuja como una fila más de la lista, no como un diálogo', async () => {
  const css = await gateCss;
  assert.match(css, /\.explorer-guest-gate\s*\{/, 'falta la regla del bloque');
  assert.match(css, /var\(--bg-card\)/, 'el bloque no usa el fondo de las filas');
  assert.ok(!/position:\s*fixed/.test(css), 'el bloque no puede flotar sobre la página');
});
