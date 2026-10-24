import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOpenSearchOnSlash } from './search-shortcut.ts';

const slash = (overrides = {}) => ({ key: '/', target: { closest: () => null }, ...overrides } as Parameters<typeof shouldOpenSearchOnSlash>[0]);
const docWith = (modal: boolean) => ({
  querySelector: (selector: string) => (modal && selector === '[aria-modal="true"]' ? { tagName: 'DIV' } as Element : null),
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
  const typing = slash({ target: { closest: (selector: string) => (selector.includes('input') ? { tagName: 'INPUT' } : null) } });
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

test('⌘K y Ctrl+K abren el buscador, también desde un campo', () => {
  const field = { closest: (selector: string) => (selector.includes('input') ? { tagName: 'INPUT' } : null) };
  for (const mod of ['metaKey', 'ctrlKey']) {
    assert.equal(shouldOpenSearchOnSlash(slash({ key: 'k', [mod]: true }), docWith(false)), true, mod);
    assert.equal(shouldOpenSearchOnSlash(slash({ key: 'K', [mod]: true, target: field }), docWith(false)), true, mod);
    assert.equal(shouldOpenSearchOnSlash(slash({ key: 'k', [mod]: true }), docWith(true)), false, `${mod} con modal`);
    assert.equal(shouldOpenSearchOnSlash(slash({ key: 'k', [mod]: true, shiftKey: true }), docWith(false)), false, `${mod}+shift`);
  }
});
