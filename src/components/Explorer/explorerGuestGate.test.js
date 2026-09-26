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

// Hasta el 24-09 el invitado veía un campo de texto en solo lectura: el
// teclado escribía y no pasaba nada, y nada decía por qué (auditoría del
// 23-09, fallo 10). Ahora es un botón con la forma del buscador, que dice que
// necesita cuenta y abre la puerta con ese motivo: lo que se ve, lo que se
// anuncia y lo que hace son la misma cosa (WCAG 4.1.2).
test('el buscador del invitado es un botón que dice que necesita cuenta y abre la puerta', async () => {
  const jsx = await explorerJsx;
  const gate = jsx.slice(jsx.indexOf('explorer-search-gate'), jsx.indexOf('explorer-search-gate') + 500);
  assert.match(
    jsx,
    /\{publicMode \? \(\s*<button\s+type="button"\s+className="explorer-search-box explorer-search-gate"\s+onClick=\{\(\) => requestAccount\('explorer_search'\)\}\s*>/,
    'el invitado ya no recibe un botón con la forma del buscador',
  );
  assert.match(gate, /\{guestSearchLabel\}/, 'el botón no dice qué hace');
  assert.doesNotMatch(jsx, /readOnly=\{publicMode\}/, 'volvió el campo de solo lectura para el invitado');
  assert.match(
    jsx,
    /const guestSearchLabel = `Search \$\{guestSearchScope\.en\} · needs an account`;/,
    'the button label no longer says it needs an account',
  );
  const filters = jsx.slice(jsx.indexOf('Open filters') - 700, jsx.indexOf('Open filters'));
  assert.match(
    filters,
    /onClick=\{publicMode \? \(\) => requestAccount\('explorer_search'\) : \(\) => setShowFilters\(true\)\}/,
    'el botón de filtros sin sesión no abre la puerta con su motivo',
  );
});

test('la puerta del Explorer pasa su motivo al diálogo', async () => {
  const jsx = await explorerJsx;
  const start = jsx.indexOf('const requestAccount = useCallback(');
  const block = jsx.slice(start, jsx.indexOf('}, [', start));
  assert.match(block, /\(reason\) => \{\s*trackEvent\([^)]*\);\s*onAuthRequired\(reason\);/);
});

test('the gate has English copy for both lists', async () => {
  const jsx = await gateJsx;
  for (const key of ['papers', 'authors']) {
    assert.match(jsx, new RegExp(`${key}:`), `falta la copia de ${key}`);
  }
  assert.ok(jsx.includes('en:'), 'the English copy is missing');
  assert.ok(!/^\s*es:/m.test(jsx), 'a Spanish copy block is back');
  assert.match(jsx, /total/, 'la puerta no usa el número de publicaciones de la entidad');
});

test('el bloque se dibuja como una fila más de la lista, no como un diálogo', async () => {
  const css = await gateCss;
  assert.match(css, /\.explorer-guest-gate\s*\{/, 'falta la regla del bloque');
  assert.match(css, /var\(--bg-card\)/, 'el bloque no usa el fondo de las filas');
  assert.ok(!/position:\s*fixed/.test(css), 'el bloque no puede flotar sobre la página');
});
