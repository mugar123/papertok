import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shouldOpenSearchOnSlash } from './searchShortcut.js';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

const slash = (overrides = {}) => ({ key: '/', target: { closest: () => null }, ...overrides });
const docWith = (modal) => ({
  querySelector: (selector) => (modal && selector === '[aria-modal="true"]' ? { tagName: 'DIV' } : null),
});

test('la barra abre el buscador cuando no hay nada modal delante', () => {
  assert.equal(shouldOpenSearchOnSlash(slash(), docWith(false)), true);
});

test('la barra NO abre el buscador con un diálogo modal abierto', () => {
  // El listener vive en `window`: la inercia del modal no filtra teclas, así
  // que sin esta puerta el lector abierto admitía la paleta, y elegir un
  // resultado navegaba de verdad dejando varada la entrada de useOverlayHistory.
  assert.equal(shouldOpenSearchOnSlash(slash(), docWith(true)), false);
});

test('escribir en un campo se sigue respetando', () => {
  const typing = slash({ target: { closest: (selector) => (selector.includes('input') ? { tagName: 'INPUT' } : null) } });
  assert.equal(shouldOpenSearchOnSlash(typing, docWith(false)), false);
});

test('una barra con modificador no es el atajo', () => {
  for (const mod of ['metaKey', 'ctrlKey', 'altKey']) {
    assert.equal(shouldOpenSearchOnSlash(slash({ [mod]: true }), docWith(false)), false, mod);
  }
});

test('cualquier otra tecla no es el atajo', () => {
  assert.equal(shouldOpenSearchOnSlash(slash({ key: 'k' }), docWith(false)), false);
});

test('SOURCE: la navbar delega en la puerta en vez de llevar la suya', async () => {
  const jsx = stripComments(await readFile(new URL('./Navbar.jsx', import.meta.url), 'utf8'));
  assert.match(jsx, /import \{ shouldOpenSearchOnSlash \} from '\.\/searchShortcut\.js';/);
  assert.match(
    jsx,
    /if \(!shouldOpenSearchOnSlash\(event, document\)\) return;/,
    'el handler del atajo tiene que preguntar por la puerta, documento incluido',
  );
  assert.doesNotMatch(
    jsx,
    /event\.key !== '\/'/,
    'la comprobación en crudo volvería a saltarse el modal: vive en searchShortcut.js',
  );
});
